# LongMem

<p align="center">
  <img src="assets/hero.png" alt="LongMem hero" width="920">
</p>

<p align="center">
  <b>LongMem</b> — Persistent memory for AI coding assistants
</p>

<p align="center">
  <a href="https://github.com/clouitreee/LongMem/releases/latest">
    <img src="https://img.shields.io/github/v/release/clouitreee/LongMem?style=flat-square" alt="release">
  </a>
  <a href="https://github.com/clouitreee/LongMem/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/clouitreee/LongMem/release.yml?style=flat-square" alt="build">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square" alt="license">
  </a>
</p>

<p align="center">
  <b>Never repeat yourself to your AI again.</b><br>
  LongMem keeps a private, local memory of your coding work so your assistant always starts with context.
</p>

<p align="center">
  <img src="assets/demo.gif" alt="LongMem demo" width="860">
</p>

---

## The problem

Every new session resets your assistant’s memory. You lose context and waste time re‑explaining what you already did.

## The fix

LongMem records your local coding activity and stores it on your machine. Your assistant can then recall what you were working on without you doing the recap.

**No cloud. No manual notes. Local‑first by default.**

---

## What LongMem stores (and what it doesn’t)

**Stored locally:**
- prompts
- commands
- tool outputs (after redaction)
- file references

**Never uploaded**, unless you explicitly enable compression with a cloud provider.

---

## How it works (at a glance)

```
Claude Code / OpenCode
        |
      hooks
        v
   +------------+
   |  longmemd  |  (local daemon)
   +------------+
        |
     SQLite DB
        v
  ~/.longmem/memory.db
```

---

## Requirements

- macOS (Apple Silicon or Intel) or Linux (x64 / ARM64)
- Claude Code or OpenCode installed
- Bun only if you build from source

---

## Install (interactive)

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

You’ll get a simple **bash menu** to choose:
- Privacy mode
- Auto‑context
- Optional compression (API key if needed)

### Non‑interactive install

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash -s -- --yes
```

---

## Quick start

```bash
longmem status
```

If the daemon is running, you’re done.

---

## Why users like it

- **“I don’t have to repeat myself.”**
- **“My assistant remembers yesterday’s bugs.”**
- **“No cloud. My data stays local.”**

---

## Configuration

Your config lives here:

```
~/.longmem/settings.json
```

Example:

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

---

## Privacy modes

| Mode | Behavior |
|------|----------|
| `safe` | Redacts common secrets + blocks sensitive files |
| `flexible` | Safe + custom regex patterns |
| `none` | No redaction (local‑only setups) |

---

## Compression (optional)

Compression creates short summaries that improve recall and search relevance.

- **No compression:** LongMem still works fully (no summaries).
- **With compression:** better recall, requires API key (unless Local).

---

## Commands

```bash
longmem start
longmem stop
longmem status
longmem stats
longmem logs -n 50

longmem export
longmem export --format markdown
longmem export --days 30
```

---

## Troubleshooting

**Installer hangs**

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash -s -- --yes
```

**Config errors**

LongMem auto‑backs up invalid JSON and repairs it.

---

## Update

```bash
curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
```

---

## Uninstall

```bash
bun run uninstall.ts
bun run uninstall.ts --yes
bun run uninstall.ts --keep-data
```

---

## Development

```bash
git clone https://github.com/clouitreee/LongMem.git && cd LongMem
bun install
bun run build
bun test
```

---

## License

MIT
