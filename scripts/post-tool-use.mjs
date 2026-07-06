#!/usr/bin/env node
/**
 * VAIBot Cursor afterShellExecution / afterMCPExecution hook.
 *
 * Cursor delivers the event JSON on stdin. This is a fire-and-forget hook (no
 * permission decision): it finds the matching run state saved by the before*
 * hook and finalizes through the local VAIBot guard's /v1/finalize/tool (which
 * proves the finalize receipt) to close the run. It always exits 0.
 *
 * Environment variables:
 *   VAIBOT_GUARD_BASE_URL — override the local guard URL (else discovered from the lock file)
 *   VAIBOT_GUARD_TOKEN    — bearer token for the local guard
 *   VAIBOT_TIMEOUT_MS     — request timeout in ms (default: 10000)
 */

import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLock } from '../vendor/vaibot-guard/scripts/lib/guard-bootstrap.mjs'

// Stable identity for this agent's per-machine state — must match the before*
// hook (pre-tool-use.mjs) so the run-state files line up.
const AGENT_ID = 'cursor'
const TIMEOUT_MS = Number(process.env.VAIBOT_TIMEOUT_MS) || 10000

// Resolve the running guard to finalize against. The before* hook already launched
// it (lock written) by the time this after* hook fires; honour the env override if set.
function resolveGuard() {
  const baseUrl = process.env.VAIBOT_GUARD_BASE_URL
  if (baseUrl) {
    try {
      const u = new URL(baseUrl)
      return { host: u.hostname, port: Number(u.port) || 39111, token: process.env.VAIBOT_GUARD_TOKEN || '' }
    } catch { /* fall through */ }
  }
  const lock = readLock()
  return lock && lock.port ? { host: lock.host, port: lock.port, token: lock.token } : null
}

const STATE_DIR = join(tmpdir(), `vaibot-${AGENT_ID}`)
const MAX_STATE_AGE_MS = 5 * 60 * 1000 // 5 minutes

function findRunState(toolName, toolUseId) {
  try {
    const files = readdirSync(STATE_DIR).filter(f => f.endsWith('.json'))
    const now = Date.now()
    let bestMatch = null
    let bestTs = 0

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(STATE_DIR, file), 'utf-8'))

        // Expire ordinary entries after 5min. Ask-in-flight entries live until
        // a hook sweeps them (this after* hook, or a later before* sweep) —
        // human decisions can outlast the normal expiry window.
        if (!data.approval_required && now - data.ts > MAX_STATE_AGE_MS) {
          try { unlinkSync(join(STATE_DIR, file)) } catch { /* ignore */ }
          continue
        }

        // Prefer exact tool_use_id (generation_id) match; fall back to most-recent tool_name.
        if (toolUseId && data.tool_use_id === toolUseId) {
          bestMatch = { ...data, file }
          break
        }
        if (data.tool_name === toolName && data.ts > bestTs) {
          bestMatch = { ...data, file }
          bestTs = data.ts
        }
      } catch { /* ignore corrupt files */ }
    }

    // Claim the matched state file before any network call. If a parallel
    // sweep beats us to the unlink, abandon the match so we don't double-
    // resolve the same receipt.
    if (bestMatch) {
      try { unlinkSync(join(STATE_DIR, bestMatch.file)) }
      catch { return null }
    }

    return bestMatch
  } catch {
    return null
  }
}

// ── Cursor input adapter ─────────────────────────────────────────────────────
// Branch on `hook_event_name` to reconstruct the same { toolName, toolUseId }
// the before* hook stored: afterShellExecution → 'Shell'; afterMCPExecution →
// 'MCP:'+tool_name. The outcome is derived from whatever result fields Cursor
// provides (a non-zero exit code or an explicit error → 'blocked').
function normalizeAfterEvent(ev) {
  const event = ev.hook_event_name ?? ev.hookEventName ?? ''
  const isMcp = event === 'afterMCPExecution' || event === 'beforeMCPExecution'
  const rawToolName = isMcp ? (ev.tool_name ?? ev.toolName ?? 'unknown') : 'Shell'
  const toolName = isMcp ? `MCP:${rawToolName}` : 'Shell'
  const toolUseId = ev.generation_id ?? ev.generationId ?? ev.tool_use_id ?? ev.toolUseId ?? null
  const sessionId = ev.conversation_id ?? ev.conversationId ?? AGENT_ID
  const exitCode = ev.exit_code ?? ev.exitCode ?? null
  const error =
    ev.tool_error ?? ev.error ?? (typeof exitCode === 'number' && exitCode !== 0 ? `exit code ${exitCode}` : null)
  const durationMs = ev.duration_ms ?? ev.durationMs ?? null
  return { isMcp, rawToolName, toolName, toolUseId, sessionId, error, durationMs }
}

async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk

  let hookInput
  try {
    hookInput = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const { isMcp, rawToolName, toolName, toolUseId, sessionId, error, durationMs } = normalizeAfterEvent(hookInput)

  // Skip VAIBot's own governance MCP tools (never governed → nothing to finalize).
  if (isMcp && /vaibot/i.test(rawToolName)) process.exit(0)

  const runState = findRunState(toolName, toolUseId)
  if (!runState?.run_id) process.exit(0)

  // Receipt exists and needs closing.
  // Direction A: finalize through the local guard (it proves the finalize
  // receipt). The guard recovers the session from the runId's stored context.
  // The 'ask' approval the user granted in Cursor's native prompt is captured
  // by the finalize receipt; the guard's pending approval record self-expires.
  const guard = resolveGuard()
  if (!guard) {
    process.stderr.write(
      `VAIBot [finalize]: no local guard reachable — run ${runState.run_id} left unfinalized.\n`
    )
    process.exit(0)
  }

  const outcome = error ? 'blocked' : 'allowed'
  const result = { outcome }
  if (typeof durationMs === 'number') result.duration_ms = durationMs
  if (error) result.error = String(error).slice(0, 2000)

  try {
    await fetch(`http://${guard.host}:${guard.port}/v1/finalize/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${guard.token}` },
      body: JSON.stringify({ sessionId, runId: runState.run_id, result }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Best-effort finalization — don't block the session.
  }

  process.exit(0)
}

main().catch(() => process.exit(0))
