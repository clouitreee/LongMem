# LongMem

**Your AI coding assistant forgets everything between sessions. LongMem fixes that.**

Every file edit, command, and conversation from [Claude Code](https://claude.ai/code) and [OpenCode](https://opencode.ai) is saved locally. Next session, your assistant remembers what you built, what broke, and how you fixed it.

```
You: what was I working on yesterday?

Claude: "You were fixing a login bug in auth.ts — the session
         expired too fast because the timer used seconds instead
         of milliseconds. You got the tests passing before stopping."
```

No cloud. No manual notes. Everything stays on your machine.

---

## What you need

- **Mac** (Apple Silicon or Intel) or **Linux** (x64 or ARM64)
- **Claude Code** or **OpenCode** installed (at least one)
- That's it

---

## Install

Paste this in your terminal:

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

The setup wizard launches automatically — no JSON editing needed:

1. Detects your tools (Claude Code, OpenCode)
2. Lets you pick privacy mode, auto-context, and compression
3. Configures hooks and MCP server
4. Installs the background service
5. Verifies everything works
6. Scans your existing memory files (CLAUDE.md, auto-memory) and indexes them
7. Asks if you want to remove Claude Code's auto-memory files (LongMem replaces them)

```
┌  LongMem Setup Wizard
│
◇  Detected ─────────────────────────────────────────╮
│                                                    │
│    Claude Code CLI v2.1.63 (configured)            │
│    Daemon: binary mode, running                    │
│                                                    │
├────────────────────────────────────────────────────╯
│
◇  Privacy mode
│  Safe (recommended)
│
◇  Enable auto-context? … Yes
◇  Apply client configuration? … Yes
◇  Install system service? … Yes
◇  Enable compression? … Yes
│
◇  Indexed 6 file(s) into memory
│
◇  Found 5 Claude Code auto-memory file(s) ─────────╮
│    ~/.claude/projects/.../memory/MEMORY.md         │
│    ~/.claude/projects/.../memory/history.md         │
│    ~/.claude/projects/.../memory/security.md        │
├────────────────────────────────────────────────────╯
│
◆  LongMem replaces Claude Code's built-in memory.
│  Remove these auto-memory files?
│  ● Keep them
│  ○ Remove all (already indexed into LongMem)
│
◇  All checks passed
│  ✓ Daemon health
│  ✓ Hook binary
│  ✓ MCP server
│  ✓ Config paths
│
└  LongMem is ready! Changes take effect in your next session.
```

Start a new session — your assistant now has memory.

### Install options

| Option | What it does |
|--------|-------------|
| `--yes` | Accept everything, no prompts (headless) |
| `--dry-run` | See what would happen without changing anything |
| `--all` | Set up both Claude Code and OpenCode |
| `--tui` | Re-run the setup wizard anytime |
| `--no-service` | Don't install systemd/launchd unit |

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

LongMem captures your activity in the background. At the start of every session, your assistant automatically gets a summary of your recent work — no need to explain what you were doing last time.

### Automatic context on first prompt

When you start a new session, LongMem injects relevant context before your assistant responds. If your first message is specific ("fix the auth bug"), it searches for related memories. If it's vague ("continue"), it shows your most recent work.

```
You: fix the JWT expiry bug

(LongMem silently injects: recent auth.ts edits, test results, related sessions)

Claude: "I can see you were working on JWT validation in src/auth.ts.
         The issue was comparing seconds against milliseconds..."
```

This happens automatically — you don't need to ask "what was I doing?"

### Ask about past work

You can also search your memory anytime:

```
You: what did I change in the auth module last week?
You: how did I fix the Docker build?
You: what was that regex I used for email validation?
```

### Improve search with compression (optional)

By default, LongMem searches your raw activity. If you add an API key, it also generates summaries that make search smarter.

The setup wizard asks about this during install. You can skip it and add it later — everything works without it.

Supported providers: **OpenRouter**, **OpenAI**, **Anthropic**, or a **local model** (Ollama).

---

## Update

Re-run the same install command. It updates LongMem and keeps your memories:

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

The setup wizard will launch again so you can review your settings. To update silently without prompts:

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
- **Secrets are redacted automatically** — API keys, tokens, passwords, connection strings, and private keys are stripped before saving.
- **Sensitive files are never stored** — `.env`, `.pem`, `.key`, and SSH keys are detected automatically. Only the file name is recorded, never the content.
- **`<private>` tag** — wrap anything sensitive: `<private>my password is xyz</private>` — it won't be saved at all.
- **Your data, your disk.** Everything is in `~/.longmem/`. Delete it anytime.

---

## Settings

Run the setup wizard anytime:

```bash
~/.longmem/bin/longmem-cli --tui
```

Or from source:

```bash
bun install.ts --tui
```

The wizard walks you through each setting interactively:

| Screen | What it configures |
|--------|--------------------|
| **Privacy mode** | Choose between `safe` (default — redacts secrets and blocks sensitive files), `flexible` (same + your own custom regex patterns), or `none` (no redaction, for fully local setups). Selecting `none` requires double confirmation. |
| **Auto-context** | Toggle automatic memory injection at session start. When enabled, LongMem searches for relevant past work and injects it before your first prompt. |
| **Client configuration** | Reviews and applies hooks (`PostToolUse`, `UserPromptSubmit`, `Stop`) and MCP server registration to Claude Code and/or OpenCode. Shows a preview before applying. Skips clients that are already configured. |
| **System service** | Installs a systemd (Linux) or launchd (macOS) unit so the daemon starts automatically on login. |
| **Compression** | Choose a provider (OpenRouter, OpenAI, Anthropic, or local Ollama), enter your API key, and enable background summarization for smarter search. Everything works without this — observations are stored raw. |
| **Verification** | Checks daemon health, hook binary, MCP server, and config paths. Shows a pass/fail summary. |
| **Ecosystem scan** | Indexes existing CLAUDE.md files, auto-memory files, skills, and OpenCode instructions into LongMem so nothing is lost. |
| **Memory migration** | Lists Claude Code auto-memory files (`~/.claude/projects/*/memory/*.md`) and lets you remove them — their content is already indexed into LongMem. |

All changes are saved atomically to `~/.longmem/settings.json` with an automatic backup. You can cancel at any step — nothing is written until you complete the wizard.

<details>
<summary>Advanced: edit settings.json directly</summary>

All settings live in `~/.longmem/settings.json`. You can edit this file directly instead of using the wizard.

**Privacy modes:**

| Mode | What it does |
|------|-------------|
| **safe** (default) | Redacts secrets, blocks sensitive files, re-checks before sending to compression |
| **flexible** | Same as safe, plus you can add your own custom redaction patterns |
| **none** | No redaction (only use this if you're self-hosting everything locally) |

```json
{ "privacy": { "mode": "safe" } }
```

**Auto-context:**

```json
{ "autoContext": { "enabled": true, "maxEntries": 5, "maxTokens": 500 } }
```

**Compression:**

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

</details>

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
- Hybrid search (text + semantic embeddings)
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
Your editor  -->  longmemd (local)  -->  ~/.longmem/memory.db
                       |
                  MCP tools: mem_search, mem_get, mem_timeline
```

### File layout

```
~/.longmem/
  memory.db       <- your memories (SQLite)
  settings.json   <- configuration
  daemon.js       <- memory service
  mcp.js          <- search tools
  hooks/          <- activity capture
  bin/            <- longmem (monolith) + symlinks (longmemd, longmem-mcp, longmem-hook, longmem-cli)
  logs/
```

### Claude Code hooks

| Hook | Purpose |
|------|---------|
| `PostToolUse` | Captures tool activity (with path/tool exclusion and secret redaction) |
| `UserPromptSubmit` | Indexes prompts, injects session primer on first prompt, topic-change context on subsequent prompts |
| `Stop` | Finalizes session |

All hooks exit cleanly — they never block your workflow.

### Auto-context

The session primer and topic-change injection can be toggled from the setup wizard (`--tui`). The wizard configures max entries, max tokens, and timeout. Disable auto-injection entirely by setting auto-context to off.

### Privacy architecture

LongMem uses 4 layers of defense to prevent secrets from leaking:

1. **Path exclusion** — `.env`, `.pem`, `.key`, SSH keys -> only metadata saved, never content
2. **Persist gate** — `redactSecrets()` strips 22+ secret patterns before writing to DB
3. **Egress gate** — re-sanitizes data before sending to compression LLM
4. **Kill switch** — `containsHighRiskPattern()` quarantines PEM keys, JWTs, AWS keys, DB connection strings with passwords

Privacy mode and custom redaction patterns are configured through the setup wizard (`--tui`). In `flexible` mode, the wizard prompts for comma-separated regex patterns.

### Supported platforms

| Platform | Architecture | Build type |
|----------|-------------|------------|
| Linux | x64 | Native |
| Linux | ARM64 | Cross-compiled |
| macOS | Apple Silicon (ARM64) | Native |
| macOS | Intel (x64) | Native |
| Windows | x64 | Native (binaries only, no install.sh) |

### Contributing

```bash
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install && bun run build && bun test
```

**Tests:** 85 tests across 5 files.

**Rules:** hooks must always exit 0, the daemon only binds to localhost, config changes must preserve existing user settings, no secrets in logs.

</details>

---

## License

MIT — *Your coding sessions, stored locally. You own your data.*
