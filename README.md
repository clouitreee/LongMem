# LongMem

**Persistent memory for AI coding assistants.**

Your AI assistant forgets everything between sessions. LongMem fixes that — every file edit, command, and conversation is saved locally. Next session, your assistant remembers what you built, what broke, and how you fixed it.

```
You: what was I working on yesterday?

Claude: "You were fixing a login bug in auth.ts — the session
         expired too fast because the timer used seconds instead
         of milliseconds. Tests were passing before you stopped."
```

**No cloud. No manual notes. Everything stays on your machine.**

---

## Requirements

- **macOS** (Apple Silicon or Intel) or **Linux** (x64 or ARM64)
- [Claude Code](https://claude.ai/code) or [OpenCode](https://opencode.ai) installed
- [Bun](https://bun.sh) (only if building from source)

---

## Quick Start

```bash
# Install (binary)
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash

# Or build from source
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install && bun run build && bun run install.ts
```

The setup wizard launches automatically and walks you through:

1. **Privacy mode** — Choose `safe` (default), `flexible`, or `none`
2. **Auto-context** — Inject relevant memories at session start
3. **Client configuration** — Register hooks and MCP server
4. **System service** — Auto-start daemon on login
5. **Compression** — Optional LLM-powered summaries for smarter search
6. **Verification** — Health checks for all components

---

## CLI Commands

```bash
# Daemon management
longmem start              # Start the memory daemon
longmem stop              # Stop the daemon
longmem status            # Check daemon status
longmem stats             # Show memory statistics
longmem logs [-n 50] [-f] # View recent logs (or follow)

# Memory export
longmem export                       # Export all to JSON
longmem export --format markdown     # Export as Markdown
longmem export --days 30             # Last 30 days only
longmem export --project myapp       # Specific project
longmem export -o output.json        # Write to file

# Setup
longmem --tui             # Re-run setup wizard
longmem --version         # Show installed version
```

---

## How It Works

```
┌─────────────────┐
│  Claude Code /  │
│    OpenCode     │
└────────┬────────┘
         │ hooks / plugin
         ▼
┌─────────────────┐
│   longmemd      │◄── HTTP API (127.0.0.1:38741)
│   (daemon)      │
└────────┬────────┘
         │ SQLite
         ▼
┌─────────────────┐
│  ~/.longmem/    │
│  └ memory.db    │
└─────────────────┘
         ▲
         │ MCP tools
┌────────┴────────┐
│ mem_search       │
│ mem_get          │
│ mem_timeline     │
│ mem_export       │
└─────────────────┘
```

**Components:**

| Component | Purpose |
|-----------|---------|
| `longmemd` | Background daemon that stores and indexes activity |
| `PostToolUse` hook | Captures tool executions (file edits, commands, etc.) |
| `UserPromptSubmit` hook | Indexes prompts, injects context at session start |
| `Stop` hook | Finalizes session |
| MCP server | Exposes `mem_search`, `mem_get`, `mem_timeline`, `mem_export` |

---

## Directory Structure

```
~/.longmem/
├── memory.db           # SQLite database (your memories)
├── settings.json       # Configuration
├── version             # Installed version
├── daemon.pid          # Process ID
├── logs/
│   ├── daemon.log      # Daemon output
│   └── hook.log        # Hook errors
└── bin/
    ├── longmem         # Monolith binary (or symlink)
    ├── longmemd        # Daemon binary (symlink)
    ├── longmem-mcp     # MCP server (symlink)
    └── longmem-hook    # Hook binary (symlink)
```

---

## Privacy

LongMem uses **4 layers of defense** to protect secrets:

| Layer | What it does |
|-------|--------------|
| **Path exclusion** | `.env`, `.pem`, `.key`, SSH keys → metadata only, never content |
| **Persist gate** | `redactSecrets()` strips 22+ secret patterns before DB write |
| **Egress gate** | Re-sanitizes before sending to compression LLM |
| **Kill switch** | Quarantines high-risk patterns (PEM keys, JWTs, AWS keys, DB passwords) |

**Privacy modes:**

| Mode | Behavior |
|------|----------|
| `safe` (default) | Redacts secrets, blocks sensitive files, validates before compression |
| `flexible` | Same as safe + custom regex patterns you define |
| `none` | No redaction (use only for fully local setups) |

**Custom redaction:**

```json
{
  "privacy": {
    "mode": "flexible",
    "customPatterns": [
      { "name": "api_key", "pattern": "sk-[a-zA-Z0-9]+" },
      { "name": "internal_url", "pattern": "https://internal\\..*" }
    ]
  }
}
```

---

## Auto-Context

When enabled, LongMem injects relevant context before your assistant's first response:

1. **Specific query** ("fix the auth bug") → searches for matching memories
2. **Vague query** ("continue") → shows recent work from last session
3. **Topic change** → detects shift and surfaces related context

Configure via setup wizard or `~/.longmem/settings.json`:

```json
{
  "autoContext": {
    "enabled": true,
    "maxEntries": 5,
    "maxTokens": 500,
    "timeoutMs": 300
  }
}
```

---

## Compression (Optional)

By default, LongMem stores raw activity. With an API key, it generates summaries for smarter search:

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

**Supported providers:** OpenRouter, OpenAI, Anthropic, or local Ollama.

---

## Configuration

All settings in `~/.longmem/settings.json`:

```json
{
  "daemon": {
    "port": 38741,
    "logLevel": "warn"
  },
  "privacy": {
    "mode": "safe",
    "excludePaths": [".env", "*.pem", "*.key"],
    "excludeTools": ["AskQuestion", "TodoWrite"]
  },
  "autoContext": {
    "enabled": true,
    "maxEntries": 5,
    "maxTokens": 500
  },
  "compression": {
    "enabled": true,
    "provider": "openrouter",
    "model": "meta-llama/llama-3.1-8b-instruct",
    "apiKey": "",
    "maxConcurrent": 1,
    "maxPerMinute": 10,
    "idleThresholdSeconds": 5
  }
}
```

---

## Troubleshooting

### Daemon not responding

```bash
# Check health
curl -s http://127.0.0.1:38741/health

# Start manually
~/.longmem/bin/longmem start

# Check logs
longmem logs -n 100

# Restart (Linux)
systemctl --user restart longmem

# Restart (macOS)
launchctl stop com.longmem.daemon && launchctl start com.longmem.daemon
```

### Hooks not working

```bash
# Check hook binary exists
ls -la ~/.longmem/bin/longmem-hook

# Check hook logs
cat ~/.longmem/logs/hook.log
```

### Database issues

```bash
# Backup and recreate
cp ~/.longmem/memory.db ~/.longmem/memory.db.bak
rm ~/.longmem/memory.db
# Daemon recreates on next start
```

---

## Update

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash

# Or silent update
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash -s -- --yes
```

---

## Uninstall

```bash
bun run uninstall.ts          # Interactive
bun run uninstall.ts --yes    # No prompts
bun run uninstall.ts --keep-data  # Keep memories
```

**What it does:**

1. Stops the daemon
2. Removes systemd/launchd service
3. Restores Claude Code / OpenCode config
4. Moves `~/.longmem/` to backup folder

Recover from `~/.longmem.backup-*` if needed.

---

## Development

```bash
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install
bun run build    # Build JS modules
bun test         # Run tests
bun run dev      # Start daemon in dev mode
```

**Project structure:**

```
LongMem/
├── daemon/
│   ├── server.ts        # HTTP daemon
│   ├── db.ts            # SQLite operations
│   ├── config.ts        # Configuration loader
│   ├── routes.ts        # API endpoints
│   ├── compression-*    # LLM summarization
│   └── privacy.ts       # Secret redaction
├── mcp/
│   └── server.ts        # MCP protocol server
├── hooks/
│   ├── main.ts          # Unified hook entry
│   ├── post-tool.ts     # Tool activity capture
│   ├── prompt.ts        # Prompt indexing
│   └── stop.ts          # Session finalization
├── cli/
│   ├── start.ts         # longmem start
│   ├── stop.ts          # longmem stop
│   ├── status.ts        # longmem status
│   ├── stats.ts         # longmem stats
│   ├── logs.ts          # longmem logs
│   └── export.ts        # longmem export
├── shared/
│   ├── constants.ts     # Centralized configuration
│   ├── daemon-client.ts # HTTP client
│   ├── tui.ts           # Setup wizard
│   └── ...
├── opencode/
│   └── plugin.ts        # OpenCode integration
└── tests/               # Test suite
```

---

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Run `bun test` and `bun run build`
5. Open a PR

**Code style:**

- TypeScript with strict mode
- No `any` without justification
- Hooks must always exit 0
- Daemon binds to localhost only
- Config changes preserve user settings
- No secrets in logs

---

## License

MIT — Your coding sessions, stored locally. You own your data.