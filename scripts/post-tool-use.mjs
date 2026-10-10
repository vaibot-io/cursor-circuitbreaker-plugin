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
import { runKey, parseMcpInput } from './lib/call-key.mjs'

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
const PENDING_DIR = join(STATE_DIR, 'pending')
const MAX_STATE_AGE_MS = 5 * 60 * 1000 // 5 minutes

// Expire ordinary entries after 5 min. Ask-in-flight entries live until this
// after* hook or a later before* sweep resolves them — a human decision can
// outlast the normal expiry window.
function expireStaleRunState() {
  try {
    const now = Date.now()
    for (const file of readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(STATE_DIR, file), 'utf-8'))
        if (!data.approval_required && now - data.ts > MAX_STATE_AGE_MS) unlinkSync(join(STATE_DIR, file))
      } catch { /* ignore corrupt or vanished files */ }
    }
  } catch { /* no state dir */ }
}

// The run-state of THIS call, by the key the before* hook saved it under (the
// generation plus the exact call). There is deliberately no fallback to "the
// newest entry for this tool": that entry belongs to a different call — another
// command, or another conversation's — and finalizing it records a result, and
// an approval, for a call that never produced them.
//
// Claimed by unlinking BEFORE any network call: if a parallel sweep wins the
// unlink, this hook backs off rather than double-resolve the receipt.
function takeRunState(key) {
  const file = join(STATE_DIR, `${key}.json`)
  let data
  try { data = JSON.parse(readFileSync(file, 'utf-8')) } catch { return null }
  try { unlinkSync(file) } catch { return null }
  return data
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
  const genId = ev.generation_id ?? ev.generationId ?? null
  const key = runKey({
    genId,
    toolName,
    command: ev.command ?? '',
    mcpInput: isMcp ? parseMcpInput(ev.tool_input ?? ev.toolInput) : undefined,
  })
  const sessionId = ev.conversation_id ?? ev.conversationId ?? AGENT_ID
  const exitCode = ev.exit_code ?? ev.exitCode ?? null
  const error =
    ev.tool_error ?? ev.error ?? (typeof exitCode === 'number' && exitCode !== 0 ? `exit code ${exitCode}` : null)
  // Cursor sends `duration` (ms, excluding approval wait); `duration_ms` is kept
  // for older payloads.
  const durationMs = ev.duration ?? ev.duration_ms ?? ev.durationMs ?? null
  return { isMcp, rawToolName, toolName, key, sessionId, error, durationMs }
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

  const { isMcp, rawToolName, toolName, key, sessionId, error, durationMs } = normalizeAfterEvent(hookInput)

  // Skip VAIBot's own governance MCP tools (never governed → nothing to finalize).
  // Governance tools are exempt so a governance call cannot recurse into governing
  // itself, and so an operator can still lift containment from inside the agent.
  //
  // Anchored at the namespace boundary. This was `/vaibot/i` unanchored, which
  // matched the substring ANYWHERE in the name: a tool called `list_vaibot_rows`
  // from any server at all was handed an exemption, and so was a server named
  // `vaibotage`. The check runs before the containment check below, so that was a
  // way around the account-wide stop.
  //
  // Cursor's MCP event carries only `tool_name` -- no server identity -- so this
  // can only match on the tool name. A server that deliberately named its tool
  // `vaibot_x` would still be exempt; closing that needs a server identity Cursor
  // does not give this hook.
  if (isMcp && /^vaibot(_|$)/i.test(rawToolName)) process.exit(0)

  expireStaleRunState()
  const runState = takeRunState(key)
  if (!runState?.run_id) process.exit(0)

  // An after* hook firing for an ask-in-flight means the user clicked "Yes" in
  // Cursor's prompt and the call ran. That answer spends the call's retry
  // pointer: left behind, the next identical command presented the guard's
  // still-pending approval id and was denied (`Approval not approved
  // (status=pending)`). Dropped before the guard lookup so it goes even when the
  // guard is unreachable.
  const nativelyApproved = runState.approval_required === true
  if (nativelyApproved && runState.intent_key) {
    try { unlinkSync(join(PENDING_DIR, `${runState.intent_key}.json`)) } catch { /* may not exist */ }
  }

  // Receipt exists and needs closing.
  // Direction A: finalize through the local guard (it proves the finalize
  // receipt). The guard recovers the session from the runId's stored context.
  const guard = resolveGuard()
  if (!guard) {
    process.stderr.write(
      `VAIBot [finalize]: no local guard reachable — run ${runState.run_id} left unfinalized.\n`
    )
    process.exit(0)
  }

  const outcome = error ? 'blocked' : 'allowed'
  const result = { outcome }
  // `ok: false` is what the guard reads as "the action failed".
  if (error) result.ok = false
  // The answer the user gave, stated rather than inferred: it is what spends the
  // guard's approval record (used) instead of leaving it pending until its TTL.
  if (nativelyApproved) result.approval = 'approved'
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
