# Changelog

All notable changes to `@vaibot/cursor-circuitbreaker-plugin`.

## [0.2.2] — 2026-09-27 — the governance exemption is a namespace, not a prefix

### Fixed
- **A look-alike MCP tool could take an exemption from governance entirely.**
  Governance tools are exempt from the breaker so that a governance call cannot
  recurse into governing itself, and so that an operator can still lift containment
  from inside the agent. That exemption was the unanchored pattern `/vaibot/i`,
  which matched the substring *anywhere* in a tool name: `list_vaibot_rows` from any
  server at all was exempt, and so was everything a server called `vaibotage`
  exposed — no containment check, no catastrophic floor, no policy. And because the
  exemption is tested *before* the containment check, it was a way around the
  account-wide stop added in 0.2.0 as well.

  The match is now anchored at the namespace boundary — `vaibot`, or a name under
  the `vaibot_` prefix. Nothing an operator needs while contained changed.

  Cursor's MCP event carries only `tool_name`, with no server identity, so this can
  only ever match on the tool name: a server that deliberately named its own tool
  `vaibot_x` would still be exempt. Closing that needs an identity Cursor does not
  give the hook. Recorded here rather than left implied.

## [0.2.1] — 2026-09-27 — vendored guard 2.2.1

### Changed
- Vendored guard refreshed to **2.2.1**, a declaration-only fix: the guard's
  `lib/guard-bootstrap.d.mts` was missing seven exports the module genuinely has.
  Runtime was never affected and this plugin's behaviour is unchanged; the version
  moved only because the vendored content did.

## [0.2.0] — 2026-09-26 — containment on every degraded path

### Added
- **The account-wide containment stop is honoured before any other decision.** The
  guard has enforced containment since 2.2.0, but only for calls that reach the
  daemon. Every path where this plugin degrades — daemon unreachable, no API key,
  breaker tripped, fail-open, hook timeout — skips that call, and so skipped
  containment; observe mode let everything through with a log line. Those are
  exactly the paths an account-wide block has to survive. The check now runs first,
  against the machine-wide record the guard writes, which needs no daemon, no
  network and no credentials.

## [0.1.0] — unreleased — initial Cursor circuit-breaker

Initial port of the VAIBot circuit-breaker to Cursor, modeled on the Claude Code
plugin (`@vaibot/claudecode-circuitbreaker-plugin`).

- **Mandatory pre-execution enforcement via Cursor hooks** — registers on
  `beforeShellExecution` and `beforeMCPExecution` (the two riskiest surfaces,
  both of which support an in-session approval prompt) with `failClosed: true`.
- Maps VAIBot policy decisions to Cursor's permission contract:
  `allow` / **`ask`** (human-in-the-loop approval) / `deny`. The `ask` path is a
  parity win over the Codex plugin, which has no in-session approval.
- Shares the vendored `@vaibot/guard` surface (classifier, breaker, guard
  client, creds) and `~/.vaibot/credentials.json` with the other plugins — one
  account across claudecode / codex / openclaw / cursor.
- Local circuit-breaker fallback + auto-bootstrap of a free-tier account +
  account recovery (`vaibot login` or `VAIBOT_API_KEY`), same as the siblings.
