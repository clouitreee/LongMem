#!/usr/bin/env bash
# LongMem — universal installer
# Usage: curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
# Or:    curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash -s -- --opencode
# Or:    bash install.sh --all
set -euo pipefail

REPO="clouitreee/LongMem"
INSTALL_DIR="${HOME}/.longmem"
BIN_DIR="${INSTALL_DIR}/bin"
LOG_DIR="${INSTALL_DIR}/logs"
SETTINGS_FILE="${INSTALL_DIR}/settings.json"
DAEMON_PORT=38741

# ─── Color helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
err()  { echo -e "${RED}✗${RESET} $*" >&2; }
die()  { err "$*"; exit 1; }

# ─── Parse args ──────────────────────────────────────────────────────────────
INSTALL_OPENCODE=false
INSTALL_CLI=true
for arg in "$@"; do
  case "$arg" in
    --opencode)      INSTALL_OPENCODE=true ;;
    --all)           INSTALL_OPENCODE=true ;;
    --opencode-only) INSTALL_CLI=false; INSTALL_OPENCODE=true ;;
    --help|-h)
      echo "Usage: install.sh [--opencode] [--all] [--opencode-only]"
      echo "  (no flags)       Install for Claude Code CLI only"
      echo "  --opencode       Also configure OpenCode"
      echo "  --all            Configure both"
      echo "  --opencode-only  Configure OpenCode only (skip Claude Code CLI hooks)"
      exit 0 ;;
  esac
done

# ─── Detect OS / arch ────────────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64)  echo "linux-x64" ;;
        aarch64) die "Linux arm64 not yet in release — build from source: https://github.com/${REPO}" ;;
        *)       die "Unsupported Linux arch: $arch" ;;
      esac ;;
    Darwin)
      case "$arch" in
        arm64)  echo "macos-arm64" ;;
        x86_64) echo "macos-x64" ;;
        *)      die "Unsupported macOS arch: $arch" ;;
      esac ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      echo "windows-x64" ;;
    *) die "Unsupported OS: $os" ;;
  esac
}

PLATFORM="$(detect_platform)"
IS_WINDOWS=false
[[ "$PLATFORM" == windows-x64 ]] && IS_WINDOWS=true

# ─── Resolve latest release tag ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       LongMem installer          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════╝${RESET}"
echo ""
echo "Platform: $PLATFORM"

LATEST_TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')"
[[ -z "$LATEST_TAG" ]] && die "Could not determine latest release tag. Check your internet connection."
echo "Version:  $LATEST_TAG"
echo ""

BASE_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}"

DAEMON_BIN="longmemd-${PLATFORM}"
MCP_BIN="longmem-mcp-${PLATFORM}"
HOOK_BIN="longmem-hook-${PLATFORM}"
[[ "$IS_WINDOWS" == true ]] && DAEMON_BIN="${DAEMON_BIN}.exe" && MCP_BIN="${MCP_BIN}.exe" && HOOK_BIN="${HOOK_BIN}.exe"

# ─── Create directories ───────────────────────────────────────────────────────
mkdir -p "$BIN_DIR" "$LOG_DIR"
chmod 700 "$INSTALL_DIR"
ok "Created ${INSTALL_DIR}"

# ─── Download helper ──────────────────────────────────────────────────────────
download() {
  local url="$1" dest="$2" checksum_url="${1}.sha256"
  echo "  Downloading $(basename "$dest")..."
  curl -fsSL --progress-bar "$url" -o "$dest"

  # Verify checksum if shasum/sha256sum is available
  local sha_cmd=""
  if command -v sha256sum &>/dev/null; then sha_cmd="sha256sum";
  elif command -v shasum &>/dev/null; then sha_cmd="shasum -a 256"; fi

  if [[ -n "$sha_cmd" ]]; then
    local expected actual
    expected="$(curl -fsSL "${checksum_url}" | awk '{print $1}')"
    actual="$($sha_cmd "$dest" | awk '{print $1}')"
    if [[ "$expected" != "$actual" ]]; then
      rm -f "$dest"
      die "Checksum mismatch for $(basename "$dest"). Download may be corrupted."
    fi
    echo "  Checksum OK"
  else
    warn "sha256sum/shasum not found — skipping checksum verification"
  fi
}

# ─── Download binaries ────────────────────────────────────────────────────────
download "${BASE_URL}/${DAEMON_BIN}" "${BIN_DIR}/longmemd"
download "${BASE_URL}/${MCP_BIN}"    "${BIN_DIR}/longmem-mcp"
download "${BASE_URL}/${HOOK_BIN}"   "${BIN_DIR}/longmem-hook"
[[ "$IS_WINDOWS" == false ]] && chmod +x "${BIN_DIR}/longmemd" "${BIN_DIR}/longmem-mcp" "${BIN_DIR}/longmem-hook"
ok "Downloaded daemon, MCP server, and hook binary"

# ─── Download OpenCode plugin (JS, runs via bun in OpenCode) ─────────────────
if [[ "$INSTALL_OPENCODE" == true ]]; then
  download "${BASE_URL}/plugin.js" "${INSTALL_DIR}/plugin.js"
  ok "Downloaded OpenCode plugin"
fi

# ─── Default settings ─────────────────────────────────────────────────────────
if [[ ! -f "$SETTINGS_FILE" ]]; then
  cat > "$SETTINGS_FILE" <<'SETTINGS'
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
  "daemon": { "port": 38741 },
  "privacy": { "redactSecrets": true }
}
SETTINGS
  chmod 600 "$SETTINGS_FILE"
  ok "Created ${SETTINGS_FILE}"
  warn "Set your compression API key in ${SETTINGS_FILE} to enable summaries"
else
  ok "${SETTINGS_FILE} already exists"
fi

# ─── JSON merge helper (pure bash, no jq required) ───────────────────────────
# We use Python if available (almost always is), else fallback to raw append
merge_json() {
  local file="$1" key="$2" value="$3"
  if command -v python3 &>/dev/null; then
    python3 - "$file" "$key" "$value" <<'PYEOF'
import sys, json
file, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(file) as f:
        data = json.load(f)
except Exception:
    data = {}
# Support nested key like "hooks.PostToolUse"
parts = key.split(".")
d = data
for p in parts[:-1]:
    d = d.setdefault(p, {})
d[parts[-1]] = json.loads(value)
with open(file, "w") as f:
    json.dump(data, f, indent=2)
PYEOF
  else
    warn "python3 not found — cannot auto-patch ${file}. Patch manually."
    return 1
  fi
}

# ─── Backup helper ───────────────────────────────────────────────────────────
backup_if_exists() {
  local file="$1"
  if [[ -f "$file" ]]; then
    cp "$file" "${file}.bak"
    ok "Backed up ${file} → ${file}.bak"
  fi
}

# ─── Configure Claude Code CLI ───────────────────────────────────────────────
if [[ "$INSTALL_CLI" == true ]]; then
  CLAUDE_DIR="${HOME}/.claude"
  CLAUDE_SETTINGS="${CLAUDE_DIR}/settings.json"
  mkdir -p "$CLAUDE_DIR"
  backup_if_exists "$CLAUDE_SETTINGS"
  [[ ! -f "$CLAUDE_SETTINGS" ]] && echo '{}' > "$CLAUDE_SETTINGS"

  HOOK="${BIN_DIR}/longmem-hook"
  MCP="${BIN_DIR}/longmem-mcp"

  # Hooks — use the standalone longmem-hook binary
  merge_json "$CLAUDE_SETTINGS" "hooks.PostToolUse" \
    '[{"matcher":"","hooks":[{"type":"command","command":"'"${HOOK}"' post-tool"}]}]'
  merge_json "$CLAUDE_SETTINGS" "hooks.UserPromptSubmit" \
    '[{"matcher":"","hooks":[{"type":"command","command":"'"${HOOK}"' prompt"}]}]'
  merge_json "$CLAUDE_SETTINGS" "hooks.Stop" \
    '[{"matcher":"","hooks":[{"type":"command","command":"'"${HOOK}"' stop"}]}]'

  # MCP server
  merge_json "$CLAUDE_SETTINGS" "mcpServers.longmem" \
    '{"command":"'"${MCP}"'","args":[]}'

  ok "Updated ${CLAUDE_SETTINGS} (hooks + MCP server)"
fi

# ─── Configure OpenCode ───────────────────────────────────────────────────────
if [[ "$INSTALL_OPENCODE" == true ]]; then
  OC_CONFIG_DIR="${HOME}/.config/opencode"
  OC_CONFIG="${OC_CONFIG_DIR}/config.json"
  INSTRUCTIONS_DIR="${HOME}/.opencode"
  INSTRUCTIONS="${INSTRUCTIONS_DIR}/memory-instructions.md"

  mkdir -p "$OC_CONFIG_DIR" "$INSTRUCTIONS_DIR"
  backup_if_exists "$OC_CONFIG"
  [[ ! -f "$OC_CONFIG" ]] && echo '{}' > "$OC_CONFIG"

  # Write instructions file
  cat > "$INSTRUCTIONS" <<'INSTRUCTIONS_EOF'
# Persistent Memory Policy (Required)

## Before you answer (mandatory)
1. Call `mem_search` with 3–7 keywords from the user request
2. If results look relevant, call `mem_get` or `mem_timeline` for full details
3. Only then respond or execute further tools

## After significant work
- The daemon captures tool calls automatically — no action needed

## Security
- Never store or repeat secrets (API keys, passwords, tokens, .env values)
- Wrap any private content in `<private>...</private>` — it will be redacted
INSTRUCTIONS_EOF
  ok "Wrote ${INSTRUCTIONS}"

  # Patch OpenCode config
  if command -v python3 &>/dev/null; then
    python3 - "$OC_CONFIG" "$INSTRUCTIONS" "${INSTALL_DIR}/plugin.js" "${BIN_DIR}/longmem-mcp" <<'PYEOF'
import sys, json
cfg_file, instructions, plugin, mcp_bin = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    with open(cfg_file) as f:
        cfg = json.load(f)
except Exception:
    cfg = {}

# instructions array
if not isinstance(cfg.get("instructions"), list):
    cfg["instructions"] = []
if instructions not in cfg["instructions"]:
    cfg["instructions"].append(instructions)

# plugin array
if not isinstance(cfg.get("plugin"), list):
    cfg["plugin"] = []
if plugin not in cfg["plugin"]:
    cfg["plugin"].append(plugin)

# mcp server
cfg.setdefault("mcp", {})["longmem"] = {"command": mcp_bin, "args": []}

with open(cfg_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF
    ok "Updated ${OC_CONFIG} (instructions + plugin + MCP)"
  else
    warn "python3 not found — could not auto-patch ${OC_CONFIG}. Add manually:"
    echo '  "mcp": { "longmem": { "command": "'"${BIN_DIR}/longmem-mcp"'", "args": [] } }'
  fi
fi

# ─── Write uninstall script ───────────────────────────────────────────────────
cat > "${INSTALL_DIR}/uninstall.sh" <<UNINSTALL
#!/usr/bin/env bash
set -euo pipefail
echo "Removing LongMem..."

# Stop daemon if running
pkill -f "${BIN_DIR}/longmemd" 2>/dev/null || true

# Restore backups
for bak in "${HOME}/.claude/settings.json.bak" "${HOME}/.config/opencode/config.json.bak"; do
  if [ -f "\$bak" ]; then
    mv "\$bak" "\${bak%.bak}"
    echo "Restored \${bak%.bak}"
  fi
done

# Remove install dir
rm -rf "${INSTALL_DIR}"
echo "LongMem removed. Memory DB deleted — this cannot be undone."
UNINSTALL
chmod +x "${INSTALL_DIR}/uninstall.sh"
ok "Created ${INSTALL_DIR}/uninstall.sh"

# ─── Start daemon ─────────────────────────────────────────────────────────────
echo ""
echo "── Starting daemon ──────────────────────────────────────"

"${BIN_DIR}/longmemd" &
DAEMON_PID=$!
disown $DAEMON_PID 2>/dev/null || true

sleep 2

if curl -sf "http://127.0.0.1:${DAEMON_PORT}/health" &>/dev/null; then
  ok "Daemon running on port ${DAEMON_PORT}"
else
  warn "Daemon did not respond — check logs at ${LOG_DIR}/"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══ Installation complete! ════════════════════════════════${RESET}"
echo ""
if grep -q '"apiKey": ""' "$SETTINGS_FILE" 2>/dev/null; then
  echo "Next step — set compression API key:"
  echo "  nano ${SETTINGS_FILE}"
  echo "  (memory works without a key — observations are stored raw)"
  echo ""
fi
echo "MCP tools available to the LLM:"
echo "  mem_search   — search past sessions"
echo "  mem_timeline — chronological context"
echo "  mem_get      — full observation details"
echo ""
echo "To uninstall: bash ${INSTALL_DIR}/uninstall.sh"
echo ""
