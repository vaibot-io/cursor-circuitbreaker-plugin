#!/usr/bin/env node
/**
 * VAIBot Cursor postToolUse / postToolUseFailure hook (matcher `Shell|MCP:`).
 *
 * Cursor delivers the event JSON on stdin. This is a fire-and-forget hook (no
 * permission decision): it finds the matching run state saved by the before*
 * hook and finalizes through the local VAIBot guard's /v1/finalize/tool (which
 * proves the finalize receipt) to close the run. It always exits 0.
 *
 * Why the generic hooks and not afterShellExecution / afterMCPExecution (which
 * this used to be). Observed in cursor-agent 2026.10.01, every Shell and MCP call
 * fires the specific after* hook first and then the generic one:
 *   - a non-zero exit arrives as postToolUseFailure (failure_type "error",
 *     error_message "Command failed with exit code 7"); afterShellExecution fires
 *     too but carries no exit code, so a failed command was finalized as allowed;
 *   - an MCP call whose server returns a protocol error fires ONLY
 *     postToolUseFailure — afterMCPExecution never fires, so that run was never
 *     finalized at all;
 *   - an MCP result with isError:true is a postToolUse; the error is visible
 *     only inside tool_output.
 * Only one hook pair may finalize: the run-state is claimed by unlink, so with
 * both registered the after* hook would win the race without an exit code.
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
// The generic hooks name the tool the way the before* hook stores it: 'Shell',
// or 'MCP:'+tool_name. tool_input is an object (Shell: { command, cwd, timeout };
// MCP: the arguments), which keys identically to the before* hook's command /
// parsed JSON-string input. Anything else (Read, Write, …) is not governed here.
//
// The failure, from what Cursor reports:
//   postToolUseFailure      → error_message (or failure_type)
//   postToolUse, Shell      → tool_output.exitCode ≠ 0 (defensive: Cursor routes
//                             a non-zero exit to postToolUseFailure)
//   postToolUse, MCP        → tool_output.isError (the server's error result)
function parseToolOutput(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return null }
}

function mcpErrorText(output) {
  const text = Array.isArray(output?.content)
    ? output.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
    : ''
  return text || 'MCP tool returned an error'
}

function normalizePostEvent(ev) {
  const event = ev.hook_event_name ?? ev.hookEventName ?? ''
  const toolName = String(ev.tool_name ?? ev.toolName ?? '')
  const isMcp = toolName.startsWith('MCP:')
  if (!isMcp && toolName !== 'Shell') return null
  const rawToolName = isMcp ? toolName.slice('MCP:'.length) : 'Shell'
  const toolInput = parseMcpInput(ev.tool_input ?? ev.toolInput)
  const key = runKey({
    genId: ev.generation_id ?? ev.generationId ?? null,
    toolName,
    command: toolInput.command ?? '',
    mcpInput: isMcp ? toolInput : undefined,
  })
  const sessionId = ev.conversation_id ?? ev.conversationId ?? AGENT_ID

  let error = null
  let failureType = null
  if (event === 'postToolUseFailure') {
    failureType = ev.failure_type ?? 'error'
    error = ev.error_message || failureType
  } else {
    const output = parseToolOutput(ev.tool_output)
    if (!isMcp && typeof output?.exitCode === 'number' && output.exitCode !== 0) error = `exit code ${output.exitCode}`
    if (isMcp && output?.isError === true) error = mcpErrorText(output)
  }
  // Cursor sends `duration` (ms, excluding approval wait).
  const durationMs = ev.duration ?? ev.duration_ms ?? null
  return { isMcp, rawToolName, key, sessionId, error, failureType, durationMs }
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

  const call = normalizePostEvent(hookInput)
  if (!call) process.exit(0)
  const { isMcp, rawToolName, key, sessionId, error, failureType, durationMs } = call

  // A denied call never ran. Whether Cursor's permission_denied means the user
  // declined the before* hook's ask, or another hooks.json source denied it (any
  // deny wins over ask), is not yet established — so this is left exactly as it
  // was before this hook existed: the run-state stays for the ask sweep, and
  // nothing is claimed about who said no.
  if (failureType === 'permission_denied') process.exit(0)

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

  // A post hook firing for an ask-in-flight means the user clicked "Yes" in
  // Cursor's prompt and the call ran (a failure or timeout still ran it). That answer spends the call's retry
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
