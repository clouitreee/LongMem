# LongMem

Persistent memory for AI coding assistants.

LongMem stores your local coding activity so your assistant can recall what you did across sessions. Data stays on your machine.

## Requirements

- macOS (Apple Silicon or Intel) or Linux (x64 or ARM64)
- Claude Code or OpenCode installed
- Bun only if you build from source

## Install

Interactive install (bash wizard):

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

Non-interactive install (defaults):

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash -s -- --yes
```

The installer uses a simple bash menu (no @clack/prompts TUI). Settings are written to:

```
~/.longmem/settings.json
```

If the file already exists, the installer keeps it and writes a backup at `~/.longmem/settings.json.bak` when the wizard runs.

## Quick Start

After install, LongMem runs a local daemon and configures supported clients.

```bash
longmem status
```

## CLI Commands

```bash
# Daemon management
longmem start              # Start the memory daemon
longmem stop               # Stop the daemon
longmem status             # Check daemon status
longmem stats              # Show memory statistics
longmem logs [-n 50] [-f]  # View recent logs (or follow)

# Memory export
longmem export                       # Export all to JSON
longmem export --format markdown     # Export as Markdown
longmem export --days 30             # Last 30 days only
longmem export --project myapp       # Specific project
longmem export -o output.json        # Write to file

# Version
longmem --version
```

## How It Works

```
Claude Code / OpenCode
        |
      hooks
        v
    longmemd  <---- local HTTP API (127.0.0.1:38741)
        |
     SQLite
        v
   ~/.longmem/memory.db
        ^
        |
     MCP tools
```

Components:

| Component | Purpose |
|-----------|---------|
| `longmemd` | Background daemon that stores and indexes activity |
| Hook binaries | Capture tool usage and prompts |
| MCP server | Exposes `mem_search`, `mem_get`, `mem_timeline`, `mem_export` |

## Configuration

All settings live in `~/.longmem/settings.json`.

Minimal example:

```json
{
  "daemon": { "port": 38741 },
  "privacy": { "mode": "safe", "redactSecrets": true },
  "autoContext": { "enabled": true },
  "compression": {
    "enabled": false,
    "provider": "openrouter",
    "model": "meta-llama/llama-3.1-8b-instruct",
    "apiKey": ""
  }
}
```

## Privacy

LongMem applies redaction before writing to disk or sending to optional compression providers.

Privacy modes:

| Mode | Behavior |
|------|----------|
| `safe` | Redacts common secrets and blocks sensitive files |
| `flexible` | Same as safe + custom regex patterns |
| `none` | No redaction (only for fully local setups) |

Custom redaction patterns:

```json
{
  "privacy": {
    "mode": "flexible",
    "customPatterns": [
      { "name": "api_key", "pattern": "sk-[a-zA-Z0-9]+" }
    ]
  }
}
```

## Auto-Context

When enabled, LongMem injects relevant context at the start of a session.

```json
{
  "autoContext": {
    "enabled": true,
    "maxEntries": 5,
    "maxTokens": 500
  }
}
```

## Compression (Optional)

Compression is optional and requires an API key unless you use Local (Ollama/LM Studio).

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

Without compression, LongMem still works fully. It just skips summaries.

## Troubleshooting

Check daemon health:

```bash
curl -s http://127.0.0.1:38741/health
```

Restart and check logs:

```bash
longmem stop
longmem start
longmem logs -n 100
```

If hooks do not run, verify binaries exist:

```bash
ls -la ~/.longmem/bin/longmem-hook
```

## Update

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

## Uninstall

```bash
bun run uninstall.ts          # Interactive
bun run uninstall.ts --yes    # No prompts
bun run uninstall.ts --keep-data  # Keep memories
```

## Development

```bash
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install
bun run build
bun test
```

## License

MIT
