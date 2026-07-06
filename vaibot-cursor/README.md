# VAIBot Circuit Breaker for Cursor

[![Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/mc2HuR2kgG)

A Cursor plugin that intercepts every tool call, evaluates it against your governance policy, and enforces the decision **before** execution proceeds — the same mandatory circuit breaker VAIBot ships for Claude Code, Codex, and OpenClaw.

> **Status: initial scaffold (0.1.0, unreleased).** Modeled on `@vaibot/claudecode-circuitbreaker-plugin`. Wired against Cursor's hook contract; needs live testing in Cursor + published distribution before GA. See "Open items" below.

## How it works

Cursor's [agent hooks](https://cursor.com/docs/hooks) let a plugin gate tool calls at the process level. This plugin registers on the two riskiest surfaces:

- **`beforeShellExecution`** — fires before Cursor's agent runs any shell command.
- **`beforeMCPExecution`** — fires before any MCP tool call.

Each hook reads the pending action, classifies its risk, and returns a permission decision:

| VAIBot decision | Cursor permission | Effect |
|---|---|---|
| allow | `allow` | proceeds |
| approval required | **`ask`** | Cursor prompts you in-session to approve/reject |
| deny | `deny` | blocked before execution |

Both hooks run with **`failClosed: true`** — if the hook crashes or times out, the action is blocked, not silently allowed. That's what makes enforcement *mandatory* rather than advisory. Every decision is recorded as a tamper-evident governance receipt (on-chain anchoring optional).

**Enforce is the default posture.** Out of the box the decisions above are applied — risky actions are blocked or held for approval, not merely logged. The account's server-resolved mode is authoritative; `VAIBOT_MODE=observe` (opt-in) switches to log-only, and even then the catastrophic floor still blocks and a guard that goes unreachable fails *closed* to local enforcement.

## Install

```sh
# Recommended — the universal installer sets up the guard + wires your agents:
curl -fsSL https://vaibot.io/install.sh | sh
```

On first tool call the plugin auto-bootstraps a free-tier VAIBot account using a machine fingerprint and saves credentials to `~/.vaibot/credentials.json` — **shared across all VAIBot plugins** (claudecode, codex, openclaw, cursor), so you get one account per machine.

To recover a lost key: run `vaibot login` (re-issues a key via your session) or set `VAIBOT_API_KEY`.

## Plugin structure

Per Cursor's [plugin reference](https://cursor.com/docs/reference/plugins):

- **`.cursor-plugin/plugin.json`** — the required plugin manifest (`name`, version, description, `hooks` path).
- **`.cursor-plugin/marketplace.json`** (at the repo root, one level up) — marketplace manifest listing this plugin at `source: "vaibot-cursor"`; Cursor's add-a-repo flow expects it.
- **`hooks/hooks.json`** — the hook registration (auto-discovered), pointing at `scripts/pre-tool-use.mjs` (before Shell/MCP, `failClosed`) and `scripts/post-tool-use.mjs` (after).

## Install / test locally

Cursor loads local plugins from `~/.cursor/plugins/local/`:

```sh
# symlink this repo in, then restart Cursor (or "Developer: Reload Window")
ln -s "$(pwd)" ~/.cursor/plugins/local/vaibot-cursor
```

For the marketplace: submit the public repo at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish) (plugins are Git repos, manually reviewed).

## Configuration

Environment variables (shared with the other plugins):

- `VAIBOT_API_URL` — API base (default `https://api.vaibot.io`)
- `VAIBOT_API_KEY` — bearer token (auto-provisioned if absent)
- `VAIBOT_MODE` — `enforce` (**default** — blocks/prompts risky actions) or `observe` (opt-in, log-only)
- `VAIBOT_TIMEOUT_MS` — request timeout (default 10000)

## Tests

`npm test` runs 25 `node:test` cases against Cursor's hook I/O contract —
allow / ask / deny mapping, breaker trip / denylist / observe-branch, the no-key
floor, nudge, fingerprint idempotency, state-file perms, and post-hook finalize.

## Open items (before GA)

- **Live-test in Cursor** — validate the exact stdin/stdout shapes for `beforeShellExecution` / `beforeMCPExecution` against a real Cursor build (load locally via the step above).
- **CLI** — `vaibot plugin add cursor` is wired as a file-based host (command-cli); full auto-wiring of `~/.cursor` is a follow-up.

## License

MIT © Campbell Labs LLC
