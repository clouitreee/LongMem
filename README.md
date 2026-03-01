# LongMem

**Persistent memory for [Claude Code CLI](https://claude.ai/code) and [OpenCode](https://opencode.ai) — both, simultaneously, without freezing your model or polluting your chat.**

Every tool call, file edit, and prompt is captured and indexed in a local SQLite database. Three MCP tools (`mem_search`, `mem_get`, `mem_timeline`) let the LLM retrieve the past on demand — no auto-injection, no context bloat.

---

## Why you care

- **Stop repeating yourself.** Architecture decisions, debugging sessions, file locations — searchable across every future session.
- **No freeze.** Compression runs in a separate local daemon on its own idle timer, completely decoupled from your main model's API slot.
- **Clean chat.** Memory is retrieved via MCP tools only when the LLM asks for it — never injected automatically into every message.
- **Safe config.** The installer detects your clients, shows exactly what it will change, asks permission, and merges hooks without overwriting your existing setup.

---

## Demo

```
You: why was auth broken last week?

LLM calls -> mem_search: "auth broken jwt"
-> [ID:142] 2026-02-28 | Edit | src/auth.ts
    Fixed JWT expiry — was comparing seconds vs milliseconds

LLM calls -> mem_get: [142]
-> Full diff, concepts: jwt, expiry, middleware, auth

LLM: "Last week you fixed a JWT expiry bug in src/auth.ts — the check
      was comparing seconds against a milliseconds timestamp..."
```

---

## Quickstart

### Option A — One-line install (no Bun required)

Pre-compiled standalone binaries for macOS (arm64 / x64) and Linux (x64). Requires `curl`, `bash`, and `python3` (for JSON config patching).

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

The installer will:

1. **Detect** which clients you have installed (Claude Code CLI, OpenCode)
2. **Show** exactly what config changes it will make
3. **Ask permission** before modifying any file
4. **Merge** hooks safely — your existing hooks are never overwritten
5. **Offer** to install a systemd/launchd service for daemon auto-start
6. **Verify** everything works (daemon, hooks, MCP, config paths)

```
╔══════════════════════════════════╗
║       LongMem installer          ║
╚══════════════════════════════════╝

Scanning...

  Detected:
    ✓ Claude Code CLI  v2.1.50    (/home/you/.local/bin/claude)
    ✗ OpenCode         not found

── Claude Code CLI ──────────────────────────────────────

  Config: ~/.claude/settings.json

  Will add:
    hooks.PostToolUse      → longmem-hook post-tool
    hooks.UserPromptSubmit → longmem-hook prompt
    hooks.Stop             → longmem-hook stop
    mcpServers.longmem     → longmem-mcp

  Apply changes? [Y/n]: y

  ✓ Updated ~/.claude/settings.json

  Install system service for daemon auto-start on login? [Y/n]: y

  ✓ Installed systemd user service

── Verification ─────────────────────────────────────────

  ✓ Daemon health    port 38741, uptime 2s
  ✓ Hook binary      exits 0
  ✓ MCP server       3 tools registered
  ✓ Config paths     all resolve

══ LongMem is ready! ════════════════════════════════════
```

#### Installer flags

| Flag | Effect |
|------|--------|
| `--yes` / `-y` | Skip all prompts, answer Y to everything |
| `--dry-run` | Preview what would happen, don't modify anything |
| `--no-service` | Don't install systemd/launchd unit |
| `--opencode` | Also configure OpenCode |
| `--all` | Configure both Claude Code CLI and OpenCode |
| `--opencode-only` | Configure OpenCode only |

```bash
# Non-interactive, full install
curl -fsSL .../install.sh | bash -s -- --all --yes

# Preview mode
curl -fsSL .../install.sh | bash -s -- --dry-run
```

---

### Option B — Dev install (requires [Bun](https://bun.sh) >= 1.1)

```bash
git clone https://github.com/clouitreee/LongMem.git
cd LongMem
bun install
bun run build
bun run install.ts           # interactive install
# or:
bun run install.ts --dry-run # preview only
bun run install.ts --all -y  # non-interactive, both clients
```

---

### Verify

```bash
curl -s http://127.0.0.1:38741/health
# -> {"status":"ok","pending":0,"sessions":0}
```

---

## How It Works

```mermaid
flowchart LR
    A["Claude Code hooks\nOpenCode plugin"] -->|"POST /observe"| B["longmemd\n127.0.0.1:38741"]
    B --> C[("SQLite FTS5\n~/.longmem/memory.db")]
    C -->|"idle -> compress\n(optional)"| D["LLM API\noptional"]
    E["LLM calls mem_search"] -->|"GET /search"| B
    B -->|"compact index"| E
    E -->|"IDs"| F["mem_get / mem_timeline"]
    F -->|"full detail"| G["LLM answers"]
```

**Progressive disclosure:**
1. `mem_search` — returns compact index entries (~50 tokens each). Fast, cheap. Start here.
2. `mem_get` — fetches full detail for specific IDs. Only what you need.
3. `mem_timeline` — shows what happened before/after a specific observation (chronological context).

FTS search works immediately on raw tool output — no compression required. Compressed summaries (from a small model you configure) improve ranking quality when available, but are entirely optional.

---

## Integrations

### Claude Code CLI

The installer patches `~/.claude/settings.json` with hooks and an MCP server:

| Hook | What it does |
|------|-------------|
| `PostToolUse` | Captures tool name + input + output, sends to daemon (fire-and-forget) |
| `UserPromptSubmit` | Indexes the user prompt for full-text search |
| `Stop` | Signals session end so the daemon can finalize compression |

All hooks always exit `0` — they never block or break your Claude Code workflow.

**Binary install** adds entries like:
```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.longmem/bin/longmem-hook post-tool" }] }]
  },
  "mcpServers": {
    "longmem": { "command": "~/.longmem/bin/longmem-mcp", "args": [] }
  }
}
```

**Dev install** uses `bun ~/.longmem/hooks/post-tool.js` and `bun ~/.longmem/mcp.js` instead.

Existing hooks in your `settings.json` are preserved. The installer only adds/updates LongMem entries — it never overwrites the whole array.

---

### OpenCode

Install with `--opencode` or `--all`. Patches `~/.config/opencode/config.json`:

```json
{
  "instructions": ["~/.opencode/memory-instructions.md"],
  "plugin": ["~/.longmem/plugin.js"],
  "mcp": {
    "longmem": { "command": "~/.longmem/bin/longmem-mcp", "args": [] }
  }
}
```

- **`instructions`** — tells the model to call `mem_search` before answering.
- **`plugin`** — hooks into `tool.execute.after`, `session.created`, `session.deleted`, `chat.message` to capture activity.
- **`mcp`** — exposes `mem_search`, `mem_get`, `mem_timeline` as native OpenCode tools.

---

## Daemon Service

The installer can register a system service so the daemon starts automatically on login.

**Linux** — systemd user unit at `~/.config/systemd/user/longmem.service`:
```bash
systemctl --user status longmem    # check status
systemctl --user restart longmem   # restart
journalctl --user -u longmem       # view logs
```

**macOS** — launchd plist at `~/Library/LaunchAgents/com.longmem.daemon.plist`:
```bash
launchctl list | grep longmem      # check status
launchctl stop com.longmem.daemon  # stop
launchctl start com.longmem.daemon # start
```

If the service is not installed, hooks fall back to spawning the daemon on demand (original behavior).

---

## Configuration

Settings file: **`~/.longmem/settings.json`** (created on first install, `chmod 600`)

```json
{
  "compression": {
    "enabled": true,
    "provider": "openrouter",
    "model": "meta-llama/llama-3.1-8b-instruct",
    "apiKey": "",
    "maxConcurrent": 1,
    "idleThresholdSeconds": 5,
    "maxPerMinute": 10
  },
  "daemon": {
    "port": 38741
  },
  "privacy": {
    "redactSecrets": true
  }
}
```

**`apiKey` is optional.** Without it, observations are stored raw and full-text search still works. Set it to enable AI-generated summaries that improve search ranking.

**Supported providers:** `openrouter`, `openai`, `anthropic`, `local` (Ollama-compatible).

**Custom base URL** (for local models or proxies):
```json
"compression": {
  "provider": "local",
  "baseURL": "http://localhost:11434/v1",
  "model": "llama3.1:8b",
  "apiKey": "ollama"
}
```

---

## Updates

Re-running the installer detects an existing installation and updates in place:

- Binaries are replaced with the latest version
- `settings.json` and `memory.db` are never touched
- Config files are re-validated (shows "already configured" if unchanged)
- Daemon is restarted automatically
- A `~/.longmem/version` file tracks the installed release

```bash
# Update to latest release
curl -fsSL .../install.sh | bash -s -- --yes

# Or from source
git pull && bun run build && bun run install.ts --yes
```

---

## Security & Privacy

**Local only.** The daemon binds exclusively to `127.0.0.1:38741`. No data leaves your machine unless you configure compression (optional, idle windows only). It never phones home.

**Automatic redaction** (when `privacy.redactSecrets: true`):

| Pattern | Example |
|---------|---------|
| OpenRouter keys | `sk-or-v1-...` |
| Anthropic keys | `sk-ant-...` |
| OpenAI keys | `sk-...` |
| GitHub PATs / OAuth | `ghp_...`, `gho_...` |
| Slack bot tokens | `xoxb-...` |
| AWS secrets | 20-char ID + 40-char value |
| Generic key=value secrets | `password=hunter2`, `api_key="abc"` |

**`<private>` tag** — wrap anything you never want stored:

```
<private>my database password is xyz</private>
The rest of this message is stored normally.
```

Content inside `<private>` is stripped before writing to the DB. The tag and its contents are never stored, not even redacted — just removed.

**What redaction does NOT guarantee:**
- It won't catch every secret format.
- Don't rely on it as your only security layer.
- Treat memory output as potentially sensitive.

---

## Troubleshooting

**Daemon not running:**
```bash
curl -s http://127.0.0.1:38741/health

# Start manually (binary install)
~/.longmem/bin/longmemd &

# Start manually (dev install)
bun run ~/.longmem/daemon.js &

# Via systemd (Linux)
systemctl --user start longmem

# Check logs
ls ~/.longmem/logs/
```

**Port already in use:**

Edit `~/.longmem/settings.json`, change `"port": 38741` to another value, and restart the daemon.

**`mem_search` returns nothing:**

The search index is empty until the daemon has captured at least one session. Use Claude Code or OpenCode normally, then search. If compression hasn't run yet, results will show raw tool output snippets instead of summaries — this is normal.

**Compression not working / "circuit open" in logs:**

Compression is optional. Without an `apiKey`, search still works on raw data. If you have a key set and compression fails repeatedly, the circuit breaker opens after 5 consecutive failures and pauses for 60 seconds. Check:
- `apiKey` is correct in `~/.longmem/settings.json`
- `model` is supported by your provider
- Your API account has credits

---

## Uninstall

```bash
bash ~/.longmem/uninstall.sh
```

The uninstall script:
1. Stops the daemon
2. Removes the systemd/launchd service (if installed)
3. Offers to restore config backups (timestamped `.pre-longmem-*.bak` files)
4. Removes `~/.longmem/`

**Manual:**
```bash
# Stop everything
pkill -f longmemd 2>/dev/null
systemctl --user disable --now longmem 2>/dev/null  # Linux
launchctl unload ~/Library/LaunchAgents/com.longmem.daemon.plist 2>/dev/null  # macOS

# Remove install
rm -rf ~/.longmem

# Restore configs from the latest backup
cp ~/.claude/settings.json.pre-longmem-*.bak ~/.claude/settings.json
cp ~/.config/opencode/config.json.pre-longmem-*.bak ~/.config/opencode/config.json
```

**Clear memory only** (keep the install):
```bash
rm ~/.longmem/memory.db
# The daemon recreates it automatically on next start
```

---

## Architecture

```
~/.longmem/
  bin/
    longmemd          # daemon binary
    longmem-mcp       # MCP server binary
    longmem-hook      # hook binary (post-tool, prompt, stop)
  daemon.js           # daemon (bun mode, dev install)
  mcp.js              # MCP server (bun mode, dev install)
  hooks/
    post-tool.js      # hook scripts (bun mode, dev install)
    prompt.js
    stop.js
  memory.db           # SQLite FTS5 database
  settings.json       # user configuration
  version             # installed release tag
  logs/
  uninstall.sh
```

Binary install uses standalone executables in `bin/`. Dev install uses JS modules that run through Bun. Both work identically.

---

## Roadmap

- [ ] Signed releases (minisign / cosign) for binary verification
- [ ] Package managers: Homebrew tap, `.deb` / `.rpm` for Linux
- [ ] Windows hooks testing (daemon + MCP work; hook binary untested on Windows)
- [ ] Memory observatory — local web UI to browse, search, and delete observations
- [ ] `mem_forget` MCP tool — delete observations by ID or pattern
- [ ] Per-project DB isolation (currently one DB with project-level filtering)

---

## Contributing

```bash
git clone https://github.com/clouitreee/LongMem.git
cd LongMem
bun install
bun run build    # compile all targets to dist/
bun run dev      # run daemon in dev mode
```

**Ground rules:**
- Hooks must always exit `0` — they cannot block the host CLI.
- Daemon must bind `127.0.0.1` only — never `0.0.0.0`.
- Config merging must preserve existing user hooks — never overwrite arrays.
- No secrets in issues, PRs, or log output.

---

## License

MIT

---

*LongMem stores your coding sessions locally. You own your data.*
