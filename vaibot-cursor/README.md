# VAIBot Governance Plugin for Cursor

[![Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/mc2HuR2kgG)

A Cursor plugin that intercepts every shell command and MCP tool call, evaluates it against your governance policy, and enforces the decision before execution proceeds.

VAIBot classifies each tool call by risk and returns an allow, deny, or approval-required verdict. Every decision creates a tamper-evident receipt with on-chain provenance anchoring. The plugin works with zero configuration — a free account is provisioned automatically on first run, and it **enforces by default**.

## Plugin vs. MCP server

VAIBot also ships an MCP server that exposes governance tools your agent can call voluntarily. The plugin and the MCP server are complementary — they serve different roles:

| | MCP server | This plugin |
|---|---|---|
| Agent queries policy / status | ✓ | ✗ |
| Agent approves actions in-session | ✓ | ✓ |
| Enforcement happens before execution | ✗ | ✓ |
| Agent can skip or bypass the check | ✓ | ✗ |
| Audit trail the agent can't forge | ✗ | ✓ |

The MCP server gives the agent a way to query and interact with VAIBot. This plugin is what makes governance **mandatory** — it hooks into Cursor's `beforeShellExecution` and `beforeMCPExecution` events, which fire before the tool runs regardless of what the agent chooses to do. Cursor runs the hooks with **`failClosed: true`**, so if the check crashes or times out the action is blocked, not silently allowed. If the goal is a tamper-evident audit record or blocking a misbehaving agent, the plugin is the enforcement layer that actually enforces it.

Most deployments use both: the plugin for mandatory pre-execution enforcement, the MCP server (added to `~/.cursor/mcp.json`) so the agent can surface policy context and manage approvals in-session.

## Quick start

**Add the plugin in Cursor.** Cursor plugins are distributed as Git repositories. Add this one as a marketplace, then install it:

1. In Cursor, open **Customize** (or Settings → Plugins) and add the marketplace repo `vaibot-io/cursor-circuitbreaker-plugin`.
2. Install **vaibot-cursor** from it.
3. Restart Cursor, or run **Developer: Reload Window**.

**Local / development install** — symlink the plugin into Cursor's local-plugins folder:

```bash
ln -s /path/to/cursor-circuitbreaker-plugin/vaibot-cursor ~/.cursor/plugins/local/vaibot-cursor
# then restart Cursor (or "Developer: Reload Window")
```

On first tool call the plugin auto-bootstraps a free-tier VAIBot account using a machine fingerprint and saves credentials to `~/.vaibot/credentials.json` — **shared across every VAIBot plugin** (Claude Code, Codex, OpenClaw, Cursor), so you get one account per machine.

### Optional — the full stack

The `vaibot` CLI installs the guard (the local enforcement + audit daemon all VAIBot plugins share) and wires your other agents. macOS + Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/vaibot-io/command-cli/main/install.sh | sh
```

The plugin governs on its own without it, but the guard daemon is the shared decision authority and propagates your account's effective mode to every agent.

## What you see at runtime

**Allowed tool** — passes through silently. A receipt is recorded in the background.

**Approval required** — the hook returns Cursor's **`ask`** permission and Cursor prompts you in-session before the command runs:
```
VAIBot flagged this shell command as elevated risk — writes outside the workspace.
content_hash: sha256:a3f9c1…
Approving here records your decision in the VAIBot audit chain.
```

Approving lets the tool proceed and records the approval; rejecting records a denial — the agent is told the action was blocked and why.

If you later approve the same action from the dashboard, the agent retries it automatically on its next attempt.

**Hard deny** — the tool is blocked outright (`permission: deny`). The agent receives the policy reason and reports it to you.

**In observe mode** — all tools proceed, but the policy verdict is logged to stderr:
```
VAIBot [observe]: Shell would be denied — command writes outside the workspace.
```

## Modes

The **effective mode is resolved by the guard from your account** and wins whenever the guard is reachable. `VAIBOT_MODE` is the **local fallback**, used only before the guard has answered — and it defaults to **`enforce`**.

### Enforce (default)

Tool calls are blocked when the policy returns `deny`, and routed to Cursor's in-session approval prompt (`ask`) when it returns `approval_required`. The agent sees the policy reason.

```bash
export VAIBOT_MODE=enforce
```

### Observe

All tool calls proceed; the governance verdict is logged to stderr but never enforced (**except the catastrophic floor**). Use it to audit your agent — and as the **escape hatch** if enforcement ever blocks you (see [Recovery / escape hatch](#recovery--escape-hatch)).

```bash
export VAIBOT_MODE=observe
```

## Auto-bootstrap

On first run with no API key, the plugin calls `POST /v2/bootstrap` with a machine fingerprint and provisions a free-tier account. Credentials are saved to `~/.vaibot/credentials.json` and reused on every subsequent run.

If the account was already provisioned (e.g. by the Claude Code plugin on the same machine) but the local key is missing, you'll see:
```
VAIBot: account exists but API key not found locally.
  Check ~/.vaibot/credentials.json or set VAIBOT_API_KEY manually.
```

To claim your account and approve actions from the dashboard, visit the URL printed on first run.

### No API key never bricks the agent

A missing or unprovisionable key does **not** fail-closed. If `/v2/bootstrap` can't mint one (the account already exists and the local key was lost, or the endpoint is unreachable), the plugin **governs locally** with the built-in classifier:

- **safe** tools run,
- **risky** tools route to Cursor's approval prompt (`ask`, no key needed),
- the **catastrophic floor** still denies (filesystem-root/home wipes, guard self-protection, fork bombs, …).

Server-backed receipts are skipped until a key is restored, so a fresh or key-lost machine keeps working — and can always recover itself.

## Recovery / escape hatch

If enforcement ever blocks you and you need out **now**, switch to observe mode (allows everything except the catastrophic floor). Because Cursor is a desktop app rather than a CLI you relaunch, use one of:

- **Account-level (durable, recommended):** flip your account to observe from **https://www.vaibot.io** — the guard propagates the change to the plugin within a poll cycle.
- **Environment:** set `VAIBOT_MODE=observe` in the environment Cursor launches from, then restart Cursor so the hooks inherit it.

This is a local fallback — it does **not** weaken enforcement once the guard is reachable and you have a key again.

Updating or reinstalling the plugin goes through Cursor's plugin manager (Customize → the plugin), not a tool call, so you can do it even mid-block. To restore full (server-backed) governance, get a key back — any one:
- `vaibot login` (allowed — it's a safe tool),
- copy your key from **https://www.vaibot.io** → `export VAIBOT_API_KEY=vb_…`,
- or check `~/.vaibot/credentials.json`.

## Managing governance

This plugin is the enforcement layer (hooks only). To check status, list pending approvals, or approve/deny out-of-band, use either:

- **The VAIBot MCP server** — add it to `~/.cursor/mcp.json` and the agent can call `vaibot_status`, `vaibot_pending`, `vaibot_approve`, `vaibot_deny`, `vaibot_recent`, and `vaibot_policy` in-session.
- **The `vaibot` CLI** — `vaibot status`, `vaibot pending`, `vaibot approve <content_hash>`, `vaibot deny <content_hash>`, `vaibot recent`, `vaibot policy`.

## Configuration

All environment variables are optional.

| Variable | Default | Description |
|---|---|---|
| `VAIBOT_API_KEY` | _(auto-provisioned)_ | Bearer token for the governance API |
| `VAIBOT_MODE` | `enforce` | `enforce` (default) or `observe` |
| `VAIBOT_API_URL` | `https://api.vaibot.io` | API base URL |
| `VAIBOT_TIMEOUT_MS` | `10000` | Request timeout in ms |
| `VAIBOT_FAIL_OPEN` | `false` | If `true`, allow tool calls when the API is unreachable |
| `VAIBOT_DEBUG` | _(unset)_ | Set to `1` for verbose decision logging |
| `VAIBOT_BREAKER_FAILURE_THRESHOLD` | `3` | Transient API failures within `WINDOW_MS` that trip the local breaker |
| `VAIBOT_BREAKER_WINDOW_MS` | `10000` | Sliding window for failure counting, in ms |
| `VAIBOT_BREAKER_COOLDOWN_MS` | `60000` | Auto-reset window after the breaker trips, in ms |
| `VAIBOT_BREAKER_DENYLIST` | _(empty)_ | Tool names always blocked when tripped (the un-overridable safety floor) |

## Local breaker (offline fallback)

When the V2 governance API is unreachable, repeated transient failures trip a
local circuit breaker that takes over until the API recovers. Sliding window:
`VAIBOT_BREAKER_FAILURE_THRESHOLD` failures inside `VAIBOT_BREAKER_WINDOW_MS`
trip the breaker for `VAIBOT_BREAKER_COOLDOWN_MS`. While tripped:

- The local **risk classifier** re-decides each call: classifier-safe tools
  pass through (`permission: allow`).
- Tools in `VAIBOT_BREAKER_DENYLIST` are blocked (`permission: deny`).
- Anything the classifier would ask/deny is denied with an actionable reason
  (approval can't be requested while offline — wait for cooldown or API recovery).

Only 5xx responses and network errors count as transient failures. 401/403
(authentication) and other 4xx responses do **not** trip the breaker — those
are real verdicts or config problems, not transient outages.

Breaker state persists at `~/.vaibot/breaker-state/cursor.json` (mode `0o600`)
so trip state survives Cursor restarts. In observe mode the breaker still tracks
failures but never blocks — it just logs a breadcrumb when tripped.

## How decisions flow

```
Cursor                          VAIBot API                    On-chain
   │                                │                            │
   ├─ beforeShellExecution ────────►│                            │
   │  beforeMCPExecution            │                            │
   │  (tool, command, target)       ├─ classifyRisk()            │
   │                                ├─ makeDecision()            │
   │                                ├─ buildReceipt()            │
   │                                ├─ anchorProvenance() ──────►│
   │◄─ allow / deny / ask ──────────┤                            │
   │                                │                            │
   ├─ [tool executes or blocked]    │                            │
   │                                │                            │
   ├─ afterShellExecution ─────────►│                            │
   │  afterMCPExecution             ├─ finalizeReceipt()         │
   │  (outcome, duration)           │                            │
```

## Plugin layout

Per Cursor's [plugin reference](https://cursor.com/docs/reference/plugins), this repo is a Cursor marketplace containing one plugin:

- **`.cursor-plugin/marketplace.json`** (repo root) — lists the plugin at `source: "vaibot-cursor"`.
- **`vaibot-cursor/.cursor-plugin/plugin.json`** — the plugin manifest.
- **`vaibot-cursor/hooks/hooks.json`** — hook registration (auto-discovered): `beforeShellExecution` / `beforeMCPExecution` → `scripts/pre-tool-use.mjs` (`failClosed`), `afterShellExecution` / `afterMCPExecution` → `scripts/post-tool-use.mjs`.
- **`vaibot-cursor/vendor/vaibot-guard/`** — the shared `@vaibot/guard` surface (classifier, breaker, guard client, creds).

## Skipped tools

MCP tools in the **`vaibot` namespace** are skipped automatically to prevent the governance plugin from governing itself.

## Tests

`npm test` runs 25 `node:test` cases against Cursor's hook I/O contract — the
allow / ask / deny mapping, breaker trip / denylist / observe branch, the no-key
floor, the approval nudge, fingerprint idempotency, state-file permissions, and
the post-hook finalize.

## Community & support

**[Join the VAIBot Discord](https://discord.gg/mc2HuR2kgG)** — get help, share feedback, and connect with other users.

VAIBot is in early access. If you're installing this plugin now, you're among the first developers putting verifiable AI governance into production. Early community members shape the roadmap directly — feature requests, policy design, and integration patterns all come from conversations in Discord.

To become a founding member, join the Discord and introduce yourself in **#founding-members**. Founding members get:
- Direct access to the VAIBot team
- Early previews of upcoming governance features
- Input on default policy design and approval workflows
- Recognition in the project

## Uninstall

Remove **vaibot-cursor** from Cursor's plugin manager (or delete the `~/.cursor/plugins/local/vaibot-cursor` symlink) and reload the window. No state is written outside `~/.vaibot/` and a system temp directory (`/tmp/vaibot-cursor/`).

MIT © Campbell Labs LLC
