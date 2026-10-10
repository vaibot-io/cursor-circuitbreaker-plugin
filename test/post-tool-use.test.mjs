import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runKey } from '../scripts/lib/call-key.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'scripts', 'post-tool-use.mjs')

function startMockServer(handler) {
  return new Promise((resolve) => {
    const requests = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
        const r = handler({ method: req.method, url: req.url }) ?? { status: 200, body: { ok: true } }
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

// Cursor's generic postToolUse event for a Shell call, in the shape observed
// from cursor-agent 2026.10.01: tool_input is an object, tool_output a JSON
// string carrying the exit code. It shares the turn's `generation_id` with the
// before* hook, which keys run-state on it plus the exact call.
function postShellEvent({ generation_id, conversation_id = 'sess_after', command = 'npm test', exitCode = 0, duration } = {}) {
  const ev = {
    hook_event_name: 'postToolUse', conversation_id, tool_name: 'Shell',
    tool_input: { command, cwd: '', timeout: 30000 }, tool_use_id: 'tu_shell',
    tool_output: JSON.stringify({ output: '', exitCode }),
  }
  if (duration !== undefined) ev.duration = duration
  if (generation_id !== undefined) ev.generation_id = generation_id
  return ev
}

// Per-test isolated STATE_DIR (via TMPDIR) so parallel pre-hook runs in other
// test files can't sweep/claim our seeded run-state. The guard is mocked via
// VAIBOT_GUARD_BASE_URL so post-tool-use finalizes against the mock, not a real
// launched daemon.
function runPost({ apiUrl, input, fakeTmp }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        TMPDIR: fakeTmp,
        VAIBOT_GUARD_BASE_URL: apiUrl,
        VAIBOT_GUARD_TOKEN: 'test-guard-token',
        VAIBOT_TIMEOUT_MS: '2000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code }))
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

// Seed a runState file under the per-test fake TMPDIR (STATE_DIR = $TMPDIR/vaibot-cursor)
// as if the before* hook wrote it. tool_name 'Shell' matches how the after* hook
// reconstructs a shell event's tool name.
// Seeds run-state where the before* hook saves it: keyed on the generation plus
// the exact call (scripts/lib/call-key.mjs).
function seedRunState(fakeTmp, toolUseId, approvalRequired, contentHash = 'sha256:x', command = 'npm test') {
  const stateDir = join(fakeTmp, 'vaibot-cursor')
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, `${runKey({ genId: toolUseId, toolName: 'Shell', command })}.json`)
  writeFileSync(path, JSON.stringify({
    tool_name: 'Shell', tool_use_id: toolUseId,
    run_id: `run_${toolUseId}`, content_hash: contentHash,
    approval_required: approvalRequired, ts: Date.now(),
  }))
  return path
}

test('approval_required runState → finalize via guard (no V2 /approve)', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  seedRunState(fakeTmp, 'tu_yes', true, 'sha256:yes')
  const server = await startMockServer(() => ({ status: 200, body: { ok: true } }))
  try {
    await runPost({ apiUrl: server.url, input: postShellEvent({ generation_id: 'tu_yes' }), fakeTmp })
    // The guard owns approvals — no V2 /approve PATCH. The native-UI approval is
    // captured by the finalize receipt; the guard's pending record self-expires.
    const approves = server.requests.filter((r) => r.method === 'PATCH' && r.url.endsWith('/approve'))
    assert.equal(approves.length, 0)
    const finalizes = server.requests.filter((r) => r.url === '/v1/finalize/tool')
    assert.equal(finalizes.length, 1)
    assert.equal(finalizes[0].body.runId, 'run_tu_yes')
  } finally {
    await server.close()
    try { rmSync(fakeTmp, { recursive: true, force: true }) } catch {}
  }
})

test('runState → finalize via guard /v1/finalize/tool, no V2 calls', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  seedRunState(fakeTmp, 'tu_plain', false)
  const server = await startMockServer(() => ({ status: 200, body: { ok: true } }))
  try {
    await runPost({ apiUrl: server.url, input: postShellEvent({ generation_id: 'tu_plain' }), fakeTmp })
    const v2 = server.requests.filter((r) => r.url.startsWith('/v2/'))
    assert.equal(v2.length, 0)
    const finalizes = server.requests.filter((r) => r.url === '/v1/finalize/tool')
    assert.equal(finalizes.length, 1)
    assert.equal(finalizes[0].body.result?.outcome, 'allowed')
  } finally {
    await server.close()
    try { rmSync(fakeTmp, { recursive: true, force: true }) } catch {}
  }
})

// ── The after* hook closes exactly the call it ran ──────────────────────────
// Cursor's generation_id changes per USER MESSAGE and is shared by every call in
// the turn, so run-state is keyed on the generation plus the exact call.

const finalizesOf = (server) => server.requests.filter((r) => r.url === '/v1/finalize/tool')

test('a "Yes" in Cursor\'s prompt finalizes as approved and spends the retry pointer', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  const statePath = seedRunState(fakeTmp, 'gen_yes', true, 'appr_yes', 'npm publish')
  const state = JSON.parse(readFileSync(statePath, 'utf-8'))
  writeFileSync(statePath, JSON.stringify({ ...state, intent_key: 'ik_yes' }))
  const pendingDir = join(fakeTmp, 'vaibot-cursor', 'pending')
  mkdirSync(pendingDir, { recursive: true })
  writeFileSync(join(pendingDir, 'ik_yes.json'), '{}')
  const server = await startMockServer(() => ({ status: 200, body: { ok: true } }))
  try {
    await runPost({ apiUrl: server.url, input: postShellEvent({ generation_id: 'gen_yes', command: 'npm publish', duration: 42 }), fakeTmp })
    const fin = finalizesOf(server)
    assert.equal(fin.length, 1)
    assert.deepEqual(fin[0].body.result, { outcome: 'allowed', approval: 'approved', duration_ms: 42 })
    assert.ok(!existsSync(join(pendingDir, 'ik_yes.json')), 'the pointer is spent: the next identical command must not present a pending id')
  } finally {
    await server.close()
    try { rmSync(fakeTmp, { recursive: true, force: true }) } catch {}
  }
})

test('two calls in one turn (same generation_id) each finalize their own run', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  seedRunState(fakeTmp, 'gen_turn', false, 'sha256:t', 'npm test')
  const buildPath = seedRunState(fakeTmp, 'gen_turn', false, 'sha256:b', 'npm run build')
  const build = JSON.parse(readFileSync(buildPath, 'utf-8'))
  writeFileSync(buildPath, JSON.stringify({ ...build, run_id: 'run_build' }))
  const server = await startMockServer(() => ({ status: 200, body: { ok: true } }))
  try {
    await runPost({ apiUrl: server.url, input: postShellEvent({ generation_id: 'gen_turn', command: 'npm run build' }), fakeTmp })
    const fin = finalizesOf(server)
    assert.deepEqual(fin.map((r) => r.body.runId), ['run_build'], 'the build closes the build, not the test')
    assert.equal(readdirSync(join(fakeTmp, 'vaibot-cursor')).filter((f) => f.endsWith('.json')).length, 1, 'the other call is untouched')
  } finally {
    await server.close()
    try { rmSync(fakeTmp, { recursive: true, force: true }) } catch {}
  }
})

test('no fallback: a call with no run-state never finalizes another call\'s run', async () => {
  // Another conversation's ask is still open for the same tool. Before, the
  // newest same-tool entry was taken and finalized with this call's result.
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  const otherPath = seedRunState(fakeTmp, 'gen_other_conv', true, 'appr_other', 'ls')
  const server = await startMockServer(() => ({ status: 200, body: { ok: true } }))
  try {
    await runPost({ apiUrl: server.url, input: postShellEvent({ generation_id: 'gen_mine', command: 'npm publish' }), fakeTmp })
    assert.equal(finalizesOf(server).length, 0)
    assert.ok(existsSync(otherPath), 'the other call\'s open ask is left alone')
  } finally {
    await server.close()
    try { rmSync(fakeTmp, { recursive: true, force: true }) } catch {}
  }
})

test('an ungated call is finalized without an approval claim, and Cursor\'s `duration` is recorded', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  seedRunState(fakeTmp, 'gen_plain', false, 'sha256:p', 'echo hi')
  const server = await startMockServer(() => ({ status: 200, body: { ok: true } }))
  try {
    await runPost({ apiUrl: server.url, input: postShellEvent({ generation_id: 'gen_plain', command: 'echo hi', duration: 7 }), fakeTmp })
    assert.deepEqual(finalizesOf(server)[0].body.result, { outcome: 'allowed', duration_ms: 7 })
  } finally {
    await server.close()
    try { rmSync(fakeTmp, { recursive: true, force: true }) } catch {}
  }
})

// ── Failures, from the payloads cursor-agent 2026.10.01 actually sent ─────────
// A non-zero exit arrives as postToolUseFailure (afterShellExecution fires too
// but carries no exit code); an MCP protocol error fires ONLY
// postToolUseFailure (afterMCPExecution never fires); an MCP isError result is a
// postToolUse with the error inside tool_output.

function seedMcpRunState(fakeTmp, genId, toolName, input, extra = {}) {
  const stateDir = join(fakeTmp, 'vaibot-cursor')
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, `${runKey({ genId, toolName, mcpInput: input })}.json`)
  writeFileSync(path, JSON.stringify({ tool_name: toolName, run_id: `run_${genId}`, approval_required: false, ts: Date.now(), ...extra }))
  return path
}

async function finalizeOnce(fakeTmp, input) {
  const server = await startMockServer(() => ({ status: 200, body: { ok: true } }))
  try {
    await runPost({ apiUrl: server.url, input, fakeTmp })
    return finalizesOf(server)
  } finally {
    await server.close()
  }
}

test('a shell command that exits non-zero is finalized ok:false with Cursor\'s error', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  seedRunState(fakeTmp, 'gen_exit7', false, 'sha256:e', "sh -c 'exit 7'")
  try {
    const fin = await finalizeOnce(fakeTmp, {
      hook_event_name: 'postToolUseFailure', conversation_id: 'c', generation_id: 'gen_exit7',
      tool_name: 'Shell', tool_input: { command: "sh -c 'exit 7'", cwd: '', timeout: 30000 }, tool_use_id: 'tu_7',
      failure_type: 'error', error_message: 'Command failed with exit code 7', is_interrupt: false, duration: 63.141,
    })
    assert.equal(fin.length, 1)
    assert.deepEqual(fin[0].body.result, { outcome: 'blocked', ok: false, duration_ms: 63.141, error: 'Command failed with exit code 7' })
  } finally {
    rmSync(fakeTmp, { recursive: true, force: true })
  }
})

test('an MCP call whose server errors (no afterMCPExecution) is still finalized, ok:false', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  seedMcpRunState(fakeTmp, 'gen_throw', 'MCP:throw_tool', { x: 3 })
  try {
    const fin = await finalizeOnce(fakeTmp, {
      hook_event_name: 'postToolUseFailure', conversation_id: 'c', generation_id: 'gen_throw',
      tool_name: 'MCP:throw_tool', tool_input: { x: 3 }, tool_use_id: 'tu_t',
      failure_type: 'error', error_message: 'MCP error -32000: deliberate protocol error', is_interrupt: false, duration: 1.999,
    })
    assert.deepEqual(fin.map((r) => r.body.runId), ['run_gen_throw'])
    assert.equal(fin[0].body.result.ok, false)
    assert.equal(fin[0].body.result.error, 'MCP error -32000: deliberate protocol error')
  } finally {
    rmSync(fakeTmp, { recursive: true, force: true })
  }
})

test('an MCP isError result is finalized ok:false with the tool\'s own text; a clean one is allowed', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  seedMcpRunState(fakeTmp, 'gen_mcp', 'MCP:fail_tool', { x: 2 })
  seedMcpRunState(fakeTmp, 'gen_mcp2', 'MCP:ok_tool', { x: 1 })
  const ev = (gen, tool, x, isError, text) => ({
    hook_event_name: 'postToolUse', conversation_id: 'c', generation_id: gen,
    tool_name: tool, tool_input: { x }, tool_use_id: `tu_${x}`, duration: 1.4,
    tool_output: JSON.stringify({ content: [{ type: 'text', text }], isError }),
  })
  try {
    const failed = await finalizeOnce(fakeTmp, ev('gen_mcp', 'MCP:fail_tool', 2, true, 'deliberate tool error'))
    assert.deepEqual(failed[0].body.result, { outcome: 'blocked', ok: false, duration_ms: 1.4, error: 'deliberate tool error' })
    const clean = await finalizeOnce(fakeTmp, ev('gen_mcp2', 'MCP:ok_tool', 1, false, 'ok'))
    assert.deepEqual(clean[0].body.result, { outcome: 'allowed', duration_ms: 1.4 })
  } finally {
    rmSync(fakeTmp, { recursive: true, force: true })
  }
})

test('a "Yes" whose command then fails is approved AND failed', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  const statePath = seedRunState(fakeTmp, 'gen_yesfail', true, 'appr_yf', 'npm publish')
  writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf-8')), intent_key: 'ik_yf' }))
  try {
    const fin = await finalizeOnce(fakeTmp, {
      hook_event_name: 'postToolUseFailure', conversation_id: 'c', generation_id: 'gen_yesfail',
      tool_name: 'Shell', tool_input: { command: 'npm publish' }, failure_type: 'timeout', error_message: 'Command timed out after 30s',
    })
    assert.deepEqual(fin[0].body.result, { outcome: 'blocked', ok: false, approval: 'approved', error: 'Command timed out after 30s' })
  } finally {
    rmSync(fakeTmp, { recursive: true, force: true })
  }
})

test('permission_denied is left alone: nothing finalized, run-state and pointer kept for the ask sweep', async () => {
  // Whether Cursor reports a user's "No" this way, or another hooks.json
  // source's deny identically, is not established. Claim nothing.
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  const statePath = seedRunState(fakeTmp, 'gen_denied', true, 'appr_d', 'npm publish')
  writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf-8')), intent_key: 'ik_d' }))
  const pointer = join(fakeTmp, 'vaibot-cursor', 'pending', 'ik_d.json')
  mkdirSync(dirname(pointer), { recursive: true })
  writeFileSync(pointer, '{}')
  try {
    const fin = await finalizeOnce(fakeTmp, {
      hook_event_name: 'postToolUseFailure', conversation_id: 'c', generation_id: 'gen_denied',
      tool_name: 'Shell', tool_input: { command: 'npm publish' }, failure_type: 'permission_denied', error_message: 'denied',
    })
    assert.equal(fin.length, 0)
    assert.ok(existsSync(statePath) && existsSync(pointer))
  } finally {
    rmSync(fakeTmp, { recursive: true, force: true })
  }
})

test('hooks.json finalizes from postToolUse/postToolUseFailure only — never also from after*', () => {
  const { hooks } = JSON.parse(readFileSync(join(__dirname, '..', 'hooks', 'hooks.json'), 'utf-8'))
  for (const ev of ['postToolUse', 'postToolUseFailure']) {
    assert.equal(hooks[ev]?.[0]?.command, 'node ./scripts/post-tool-use.mjs', ev)
    assert.equal(hooks[ev][0].matcher, 'Shell|MCP:', `${ev}: matcher verified live to pass Shell and MCP:* and skip Read`)
  }
  // Both fire for every call, after* first: it would claim the run-state
  // without an exit code, and afterMCPExecution misses MCP protocol errors.
  assert.equal(hooks.afterShellExecution, undefined)
  assert.equal(hooks.afterMCPExecution, undefined)
})

test('round trip: the before* hook\'s key is the one the generic post hook rebuilds (Shell and MCP)', async () => {
  const fakeTmp = mkdtempSync(join(tmpdir(), 'vaibot-cursor-post-'))
  const fakeHome = mkdtempSync(join(tmpdir(), 'vaibot-cursor-home-'))
  let n = 0
  const server = await startMockServer(({ url }) => (url === '/v1/decide/tool'
    ? { status: 200, body: { ok: true, runId: `run_rt${++n}`, risk: { risk: 'low', reason: 'ok' }, decision: { decision: 'allow', reason: 'ok' } } }
    : { status: 200, body: { ok: true } }))
  const PRE = join(__dirname, '..', 'scripts', 'pre-tool-use.mjs')
  const runPre = (input) => new Promise((resolve, reject) => {
    mkdirSync(join(fakeHome, '.vaibot'), { recursive: true })
    writeFileSync(join(fakeHome, '.vaibot', 'credentials.json'), JSON.stringify({ version: 3, active_env: 'staging', environments: { staging: { governance: { url: server.url }, provenance: { url: server.url }, api_key: 'k' } } }))
    const c = spawn(process.execPath, [PRE], {
      env: { ...process.env, HOME: fakeHome, TMPDIR: fakeTmp, VAIBOT_API_URL: server.url, VAIBOT_GUARD_BASE_URL: server.url, VAIBOT_GUARD_TOKEN: 't', VAIBOT_API_KEY: 'k', VAIBOT_MODE: 'enforce', VAIBOT_TIMEOUT_MS: '2000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    c.on('error', reject)
    c.on('exit', resolve)
    c.stdin.end(JSON.stringify(input))
  })
  try {
    await runPre({ hook_event_name: 'beforeShellExecution', conversation_id: 'c', generation_id: 'g_rt', command: 'echo rt', cwd: '/tmp', sandbox: false })
    await runPre({ hook_event_name: 'beforeMCPExecution', conversation_id: 'c', generation_id: 'g_rt', tool_name: 'ok_tool', tool_input: '{"x":1,"y":{"b":2,"a":1}}', mcp_server_name: 'probe', command: 'node mcp.mjs' })
    await runPost({ apiUrl: server.url, fakeTmp, input: { hook_event_name: 'postToolUseFailure', conversation_id: 'c', generation_id: 'g_rt', tool_name: 'Shell', tool_input: { command: 'echo rt', cwd: '', timeout: 30000 }, failure_type: 'error', error_message: 'boom' } })
    await runPost({ apiUrl: server.url, fakeTmp, input: { hook_event_name: 'postToolUse', conversation_id: 'c', generation_id: 'g_rt', tool_name: 'MCP:ok_tool', tool_input: { y: { a: 1, b: 2 }, x: 1 }, tool_output: '{"content":[],"isError":false}' } })
    assert.deepEqual(finalizesOf(server).map((r) => r.body.runId), ['run_rt1', 'run_rt2'])
  } finally {
    await server.close()
    rmSync(fakeTmp, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  }
})
