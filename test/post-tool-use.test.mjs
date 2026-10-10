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

// Cursor after* event: afterShellExecution carries the same `generation_id`
// (per-call correlation id) the before* hook stored as tool_use_id, so the
// after hook can find the matching run state and finalize it. No exit_code /
// tool_error → the tool succeeded → outcome 'allowed'.
function afterShellEvent({ generation_id, conversation_id = 'sess_after', command = 'npm test', exit_code, duration_ms, duration } = {}) {
  const ev = { hook_event_name: 'afterShellExecution', conversation_id, command }
  if (duration !== undefined) ev.duration = duration
  if (generation_id !== undefined) ev.generation_id = generation_id
  if (exit_code !== undefined) ev.exit_code = exit_code
  if (duration_ms !== undefined) ev.duration_ms = duration_ms
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
    await runPost({ apiUrl: server.url, input: afterShellEvent({ generation_id: 'tu_yes' }), fakeTmp })
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
    await runPost({ apiUrl: server.url, input: afterShellEvent({ generation_id: 'tu_plain' }), fakeTmp })
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
    await runPost({ apiUrl: server.url, input: afterShellEvent({ generation_id: 'gen_yes', command: 'npm publish', duration: 42 }), fakeTmp })
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
    await runPost({ apiUrl: server.url, input: afterShellEvent({ generation_id: 'gen_turn', command: 'npm run build' }), fakeTmp })
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
    await runPost({ apiUrl: server.url, input: afterShellEvent({ generation_id: 'gen_mine', command: 'npm publish' }), fakeTmp })
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
    await runPost({ apiUrl: server.url, input: afterShellEvent({ generation_id: 'gen_plain', command: 'echo hi', duration: 7 }), fakeTmp })
    assert.deepEqual(finalizesOf(server)[0].body.result, { outcome: 'allowed', duration_ms: 7 })
  } finally {
    await server.close()
    try { rmSync(fakeTmp, { recursive: true, force: true }) } catch {}
  }
})
