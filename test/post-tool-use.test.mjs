import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
function afterShellEvent({ generation_id, conversation_id = 'sess_after', exit_code, duration_ms } = {}) {
  const ev = { hook_event_name: 'afterShellExecution', conversation_id }
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
function seedRunState(fakeTmp, toolUseId, approvalRequired, contentHash = 'sha256:x') {
  const stateDir = join(fakeTmp, 'vaibot-cursor')
  mkdirSync(stateDir, { recursive: true })
  const path = join(stateDir, `${toolUseId}.json`)
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
