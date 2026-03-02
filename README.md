# LongMem

**Your AI coding assistant forgets everything between sessions. LongMem fixes that.**

Every file edit, command, and conversation from [Claude Code](https://claude.ai/code) and [OpenCode](https://opencode.ai) is saved locally. Next session, your assistant remembers what you built, what broke, and how you fixed it.

```
You: why was auth broken last week?

Claude: "You fixed a JWT expiry bug in src/auth.ts on Feb 28 —
         the check was comparing seconds against milliseconds."
```

No cloud. No manual notes. Everything stays on your machine.

---

## What you need

- **Mac or Linux**
- **Claude Code** or **OpenCode** installed (at least one)
- That's it

---

## Install

Paste this in your terminal:

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

The installer does everything for you:

1. Finds your tools (Claude Code, OpenCode)
2. Shows what it will change and **asks permission**
3. Sets up memory capture + search
4. Verifies everything works

```
╔══════════════════════════════════╗
║       LongMem installer          ║
╚══════════════════════════════════╝

  Detected:
    ✓ Claude Code CLI  v2.1.50
    ✓ OpenCode         v1.2.15

  Apply changes? [Y/n]: y
  ✓ Done

  ✓ Daemon running
  ✓ Hooks working
  ✓ Memory search ready

══ LongMem is ready! ════════════════════════════════
```

Start a new session — your assistant now has memory.

### Install options

| Option | What it does |
|--------|-------------|
| `--yes` | Accept everything, no prompts |
| `--dry-run` | See what would happen without changing anything |
| `--all` | Set up both Claude Code and OpenCode |

### Install from source

If you prefer to build it yourself (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install && bun run build
bun run install.ts
```

---

## Using it

You don't need to do anything special. Just use Claude Code or OpenCode as you normally do.

LongMem captures your activity in the background. When your assistant needs past context, it searches your memory automatically.

### Ask about past work

Just ask naturally — your assistant will search your memory:

```
You: what did I change in the auth module last week?
You: how did I fix the Docker build?
You: what was that regex I used for email validation?
```

### Improve search with compression (optional)

By default, LongMem searches your raw activity. If you add an API key, it also generates summaries that make search smarter.

The installer asks about this at the end. You can skip it and add it later — everything works without it.

Supported providers: **OpenRouter**, **OpenAI**, **Anthropic**, or a **local model** (Ollama).

---

## Update

Re-run the same install command. It updates LongMem and keeps your memories:

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash -s -- --yes
```

---

## Uninstall

```bash
bun run uninstall.ts
```

| Option | What it does |
|--------|-------------|
| `--yes` | No prompts, just uninstall |
| `--keep-data` | Remove LongMem but keep your memories (can reinstall later) |
| `--dry-run` | See what would happen without changing anything |

What the uninstaller does:

1. Stops the memory service
2. Restores your Claude Code / OpenCode config to how it was before (your other settings stay untouched)
3. Moves LongMem to a backup folder — **nothing is deleted permanently**

You can always recover from `~/.longmem.backup-*` if you change your mind.

### Erase memory only (keep LongMem running)

```bash
rm ~/.longmem/memory.db
```

The database is recreated automatically next session.

---

## Privacy

- **100% local.** Nothing leaves your machine unless you set up compression (optional, you choose the provider).
- **Secrets are redacted automatically** — API keys, tokens, and passwords are stripped before saving.
- **`<private>` tag** — wrap anything sensitive: `<private>my password is xyz</private>` — it won't be saved at all.
- **Your data, your disk.** Everything is in `~/.longmem/`. Delete it anytime.

---

## Troubleshooting

**Memory search returns nothing?**
Memory builds up as you work. Use Claude Code or OpenCode for a session first, then ask about it next time.

**LongMem not responding?**
```bash
# Check if it's running
curl -s http://127.0.0.1:38741/health

# Restart it (Linux)
systemctl --user restart longmem

# Restart it (Mac)
launchctl stop com.longmem.daemon && launchctl start com.longmem.daemon
```

**Compression not working?**
Check that your API key is correct and your account has credits. LongMem pauses compression automatically after repeated failures and retries later.

---

## Ideas & feedback

Got a feature idea, found a bug, or want to share how you use it? **[Open an issue](https://github.com/clouitreee/LongMem/issues)** — all ideas are welcome.

Things we're considering:

- Forget specific memories on demand
- Visual memory browser in the terminal
- Separate databases per project
- Homebrew / apt packages
- Windows support

Tell us what matters to you — it helps us prioritize.

---

## For developers

<details>
<summary>Architecture, hooks, and contributing</summary>

### How it works

A small background service (`longmemd`) runs on your machine. It captures activity via hooks (Claude Code) or a plugin (OpenCode), stores it in a SQLite database, and exposes search via MCP tools.

```
Your editor  ──▶  longmemd (local)  ──▶  ~/.longmem/memory.db
                       │
                  MCP tools: mem_search, mem_get, mem_timeline
```

### File layout

```
~/.longmem/
  memory.db       ← your memories (SQLite)
  settings.json   ← configuration
  daemon.js       ← memory service
  mcp.js          ← search tools
  hooks/          ← activity capture
  bin/            ← compiled binaries (if using release install)
  logs/
```

### Claude Code hooks

| Hook | Purpose |
|------|---------|
| `PostToolUse` | Captures tool activity |
| `UserPromptSubmit` | Indexes prompts, injects relevant context on topic change |
| `Stop` | Finalizes session |

All hooks exit cleanly — they never block your workflow.

### Contributing

```bash
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install && bun run build && bun test
```

**Rules:** hooks must always exit 0, the daemon only binds to localhost, config changes must preserve existing user settings, no secrets in logs.

</details>

---

## License

MIT — *Your coding sessions, stored locally. You own your data.*
