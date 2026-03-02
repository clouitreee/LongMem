# LongMem

**Your AI coding assistant forgets everything between sessions. LongMem fixes that.**

Every tool call, file edit, and prompt from [Claude Code](https://claude.ai/code) and [OpenCode](https://opencode.ai) is captured in a local database. Next session, your assistant remembers what you built, what broke, and how you fixed it.

```
You: why was auth broken last week?

Claude: "You fixed a JWT expiry bug in src/auth.ts on Feb 28 —
         the check was comparing seconds against milliseconds."
```

No cloud sync. No manual notes. Everything stays on your machine.

---

## Install (one command)

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

The installer auto-detects Claude Code / OpenCode, shows what it will change, asks permission, and verifies everything works:

```
╔══════════════════════════════════╗
║       LongMem installer          ║
╚══════════════════════════════════╝

Scanning...

  Detected:
    ✓ Claude Code CLI  v2.1.50
    ✓ OpenCode         v1.2.15

── Claude Code CLI ──────────────────────────────────

  Will add:
    hooks.PostToolUse      → capture tool activity
    hooks.UserPromptSubmit → index prompts + inject context
    hooks.Stop             → finalize session
    mcpServers.longmem     → memory search tools

  Apply changes? [Y/n]: y
  ✓ Done

── Verification ─────────────────────────────────────

  ✓ Daemon running     port 38741
  ✓ Hooks working      exits 0
  ✓ MCP tools          3 registered
  ✓ Config valid       all paths resolve

══ LongMem is ready! ════════════════════════════════
```

That's it. Start a new Claude Code or OpenCode session and your assistant has memory.

### Install flags

| Flag | Effect |
|------|--------|
| `--yes` / `-y` | Skip prompts, answer Y to everything |
| `--dry-run` | Preview changes without modifying anything |
| `--no-service` | Don't auto-start daemon on login |
| `--all` | Configure both Claude Code and OpenCode |

### Install from source (requires [Bun](https://bun.sh))

```bash
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install && bun run build
bun run install.ts
```

---

## How it works

```
┌─────────────────┐     POST /observe     ┌──────────────┐     SQLite FTS5
│ Claude Code     │ ───────────────────▶   │  longmemd     │ ──▶ ~/.longmem/
│ hooks + MCP     │                        │  127.0.0.1    │     memory.db
│                 │ ◀─── mem_search ─────  │  :38741       │
│ OpenCode        │ ◀─── mem_get ────────  │               │
│ plugin + MCP    │ ◀─── mem_timeline ───  └───────┬───────┘
└─────────────────┘                                │ idle
                                                   ▼
                                            LLM compression
                                            (optional)
```

**What gets captured:** Every tool call (edits, reads, bash commands), every prompt you type, session start/end events.

**What the LLM gets:** Three MCP tools to search memory on demand, plus automatic context injection when you switch topics mid-session.

**What's optional:** AI compression (summarizes raw data for better search). Works fine without it — raw full-text search is always available.

---

## Quick guide

### Search memory from your assistant

Your assistant already has the MCP tools. Just ask naturally:

```
You: what did I change in the auth module last week?
You: how did I fix the Docker build?
You: what was that regex pattern I used for email validation?
```

The assistant calls `mem_search` automatically, then `mem_get` for details if needed.

### Check daemon status

```bash
curl -s http://127.0.0.1:38741/health
# {"status":"ok","pending":0,"sessions":0}

curl -s http://127.0.0.1:38741/status
# {"pid":12345,"port":38741,"uptime_seconds":3600,...}
```

### Configure compression (optional)

The installer offers an interactive setup at the end. Or edit manually:

**`~/.longmem/settings.json`**
```json
{
  "compression": {
    "enabled": true,
    "provider": "openrouter",
    "model": "meta-llama/llama-3.1-8b-instruct",
    "apiKey": "your-key-here"
  }
}
```

Supported providers: `openrouter`, `openai`, `anthropic`, `local` (Ollama).

Without an API key, search works on raw tool output. With one, you get AI-generated summaries that improve ranking.

### Manage the daemon

**Linux (systemd):**
```bash
systemctl --user status longmem
systemctl --user restart longmem
journalctl --user -u longmem
```

**macOS (launchd):**
```bash
launchctl list | grep longmem
launchctl stop com.longmem.daemon
launchctl start com.longmem.daemon
```

If no service is installed, hooks auto-start the daemon on demand.

### Update

Re-run the installer. It detects the existing install, updates binaries, and preserves your data:

```bash
curl -fsSL .../install.sh | bash -s -- --yes
# or from source:
git pull && bun run build && bun run install.ts --yes
```

### Uninstall

```bash
bun run uninstall.ts
# or: bun run uninstall.ts --yes --keep-data
```

Stops daemon, removes service, restores your configs (preserves your other hooks), and moves `~/.longmem/` to a timestamped backup. Nothing is deleted permanently.

---

## Privacy & security

- **100% local.** Daemon binds to `127.0.0.1` only. No telemetry, no cloud, no phoning home.
- **Automatic secret redaction** — API keys, tokens, passwords are stripped before storage.
- **`<private>` tag** — wrap text you never want stored: `<private>secret stuff</private>`
- **Compression is optional** — the only time data leaves your machine, and only to the provider you configure.
- **Your data, your disk.** Everything lives in `~/.longmem/memory.db`. Delete it anytime.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Daemon not running | `systemctl --user start longmem` or `~/.longmem/bin/longmemd &` |
| Port conflict | The daemon has single-instance protection. Change port in `~/.longmem/settings.json` |
| `mem_search` returns nothing | Memory builds up as you use Claude Code / OpenCode. Give it a session first |
| Compression failing | Check API key, model name, and account credits. Circuit breaker pauses after 5 failures |

---

## Architecture

```
~/.longmem/
  bin/
    longmemd          # daemon binary
    longmem-mcp       # MCP server binary
    longmem-hook      # hook binary
  daemon.js           # daemon (bun/dev mode)
  mcp.js              # MCP server (bun/dev mode)
  hooks/              # hook scripts (bun/dev mode)
  memory.db           # SQLite FTS5 database
  settings.json       # config (chmod 600)
  version             # release tag
  logs/
```

### Claude Code integration

| Hook | Purpose |
|------|---------|
| `PostToolUse` | Captures tool calls (fire-and-forget) |
| `UserPromptSubmit` | Indexes prompts, detects topic changes, injects relevant context |
| `Stop` | Finalizes session for compression |

All hooks exit `0` — they never block your workflow.

### OpenCode integration

Patches `~/.config/opencode/config.json` with MCP server + plugin + instructions.

---

## Contributing

```bash
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install && bun run build && bun test
```

**Rules:** hooks must exit `0`, daemon binds `127.0.0.1` only, config merging never overwrites user hooks, no secrets in logs.

---

## License

MIT — *LongMem stores your coding sessions locally. You own your data.*
