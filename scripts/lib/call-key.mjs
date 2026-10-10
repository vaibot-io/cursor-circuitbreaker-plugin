/**
 * Per-call identity shared by the before* and after* hooks.
 *
 * Cursor gives these hooks no per-call id. `generation_id` is "the current
 * generation that changes with every user message" — every tool call in a turn
 * shares it — so keying run-state on it alone let one call's state overwrite
 * another's, and an after* hook finalize a different call than the one it ran.
 *
 * The key is the generation PLUS the exact call, built only from fields BOTH
 * sides of a pair receive:
 *   Shell → the command        (afterShellExecution carries no cwd)
 *   MCP   → tool + its input   (tool_input is a JSON string on both events)
 * Two calls share a key only when they are the same command (or the same MCP
 * call with the same input) in the same turn — the one case the hooks cannot
 * tell apart.
 */
import { createHash } from 'node:crypto'

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// MCP tool_input arrives as a JSON string; parse it the same way on both sides.
export function parseMcpInput(raw) {
  let parsed = raw ?? {}
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { parsed = {} }
  }
  return parsed && typeof parsed === 'object' ? parsed : {}
}

/** @param {{ genId: string|null, toolName: string, command?: string, mcpInput?: object }} call */
export function runKey({ genId, toolName, command, mcpInput }) {
  const what = toolName === 'Shell' ? String(command ?? '') : stableStringify(mcpInput ?? {})
  return createHash('sha256').update(`${genId ?? ''}|${toolName}|${what}`).digest('hex').slice(0, 32)
}
