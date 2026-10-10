# Changelog

All notable changes to `@vaibot/cursor-circuitbreaker-plugin`.

## [Unreleased]

### Fixed
- **One conversation no longer clears another's open approval prompt.** The ask
  sweep, which runs on every before* hook, cleared **any** pending ask except the current
  generation's, across every Cursor conversation on the machine. A call in one
  conversation deleted another conversation's ask while its prompt was still open, so
  that conversation's "Yes" had nothing to finalize. The sweep now clears an ask only
  when it belongs to **this** conversation and an **earlier** user message (the user has
  moved on, so that prompt is over), or when it has been abandoned for over a day.
  Run-state now records its `conversation_id`. As before, nothing is recorded for a
  cleared ask: Cursor reports no answer to an ask, and its transcripts carry no tool
  results, so a "No" can't be told apart from a stop or an unanswered prompt.
- **A "Yes" in Cursor's prompt no longer gets the next identical command denied.**
  After the user approved an `ask` and the command ran, the after* hook finalized
  `{ outcome: "allowed" }`: no `approval`, and the retry pointer left behind. Running the
  same command again presented the guard's still-**pending** approval id and was denied,
  `Approval not approved (status=pending)`. The after* hook now spends the pointer and
  finalizes with `approval: "approved"`. That's also what lets guard 2.3.1 mark the
  approval `used` instead of leaving it pending on the dashboard until its TTL.
- **The after* hook closes exactly the call it ran.** Cursor's `generation_id` "changes
  with every user message", so it's shared by every call in a turn, but run-state was
  keyed on it alone. A second call in the turn overwrote the first's run-state, and
  when an after* hook found no entry it fell back to "the newest entry for this tool",
  which belonged to another call. In a reproduction, approving in one conversation
  finalized **another conversation's** still-pending call as having run. Run-state is
  now keyed on the generation plus the exact call (Shell: the command; MCP: tool and
  input, both fields both hooks receive). The fallback is gone.
- **Durations are recorded.** Cursor sends `duration`; the hook read `duration_ms`.

## [0.2.2] — 2026-09-28 — the governance exemption, and guard 2.3.0

### Changed
- **Vendored guard refreshed to 2.3.0**, taken from the published tarball and verified
  against the digest the registry reports (`ecdd56a7f87604435e06a2eafc6de4b96bb7918b`),
  so the committed copy is provably what npm serves. It brings:

  - the **git classification fix** — `git -C <path> …` no longer launders
    `reset --hard`, `clean -f` or `push --force` from ask to allow, and `branch -D` /
    `tag -d` are no longer classified as reads;
  - **`floorAsk`**, a verdict tier no preset can make silent;
  - **approval leases** and **batch approvals**, which this breaker inherits through
    the guard's decision path rather than implementing itself.

  **This changes what runs without asking, on the `permissive` preset.** The guard
  gained a third verdict tier — `floorAsk`, which always asks and which no preset can
  lower — so actions that cannot be undone by whoever authorised them now prompt even
  under `permissive`, which previously never prompted. Measured on the vendored
  classifier this breaker uses in-process:

  | command | 2.2.1 | 2.3.0 |
  |---|---|---|
  | `git branch -D <branch>` | allow | **ask** |
  | `git -C <path> reset --hard` | allow | **ask** |
  | `npm publish` · `cargo publish` | allow | **ask** |
  | `git status` · `npm test` | allow | allow |

  Routine work is untouched — there is a test table asserting exactly that, so the
  tier cannot drift into "ask about everything". If the new prompts are unwelcome, the
  lever is the preset, not the breaker version.

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
