# VAIBot — Cursor marketplace

A Cursor plugin marketplace publishing the **VAIBot circuit breaker** for Cursor — mandatory pre-execution governance (allow / ask / deny) via Cursor hooks, with tamper-evident receipts. Part of the VAIBot circuit-breaker fleet (Claude Code · Codex · OpenClaw · Cursor).

- **Marketplace manifest:** [`.cursor-plugin/marketplace.json`](./.cursor-plugin/marketplace.json)
- **Plugin:** [`vaibot-cursor/`](./vaibot-cursor) — see its [README](./vaibot-cursor/README.md)

## Add to Cursor

Add this repository as a marketplace in Cursor, then install **vaibot-cursor**. To test locally instead:

```sh
ln -s "$(pwd)/vaibot-cursor" ~/.cursor/plugins/local/vaibot-cursor
# then restart Cursor (or "Developer: Reload Window")
```

MIT © Campbell Labs LLC · https://www.vaibot.io
