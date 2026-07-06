# Changelog

All notable changes to `@vaibot/cursor-circuitbreaker-plugin`.

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
