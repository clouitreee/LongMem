#!/usr/bin/env bash
# LongMem — universal installer with auto-detection & permission flow
# Usage: curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
# Or:    bash install.sh --yes --no-service
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
FLAG_YES=false
FLAG_DRY_RUN=false
FLAG_NO_SERVICE=false
INSTALL_OPENCODE=false
INSTALL_CLI=true
for arg in "$@"; do
  case "$arg" in
    --yes|-y)          FLAG_YES=true ;;
    --dry-run)         FLAG_DRY_RUN=true ;;
    --no-service)      FLAG_NO_SERVICE=true ;;
    --opencode)        INSTALL_OPENCODE=true ;;
    --all)             INSTALL_OPENCODE=true ;;
    --opencode-only)   INSTALL_CLI=false; INSTALL_OPENCODE=true ;;
    --help|-h)
      echo "Usage: install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --yes, -y        Skip all prompts (answer Y)"
      echo "  --dry-run        Preview changes without modifying anything"
      echo "  --no-service     Don't install systemd/launchd unit"
      echo "  --opencode       Also configure OpenCode"
      echo "  --all            Configure both Claude Code CLI and OpenCode"
      echo "  --opencode-only  Configure OpenCode only"
      exit 0 ;;
  esac
done

# ─── Interactive prompt ──────────────────────────────────────────────────────
ask_yes_no() {
  local question="$1" default="${2:-Y}"
  if [[ "$FLAG_YES" == true ]]; then return 0; fi
  local suffix="[Y/n]"
  [[ "$default" == "N" ]] && suffix="[y/N]"
  printf "  %s %s: " "$question" "$suffix"
  read -r answer
  answer="${answer:-$default}"
  [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]]
}

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

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1: Detection
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}╔══════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       LongMem installer          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════╝${RESET}"
echo ""

[[ "$FLAG_DRY_RUN" == true ]] && echo -e "${YELLOW}  (dry-run mode — no files will be modified)${RESET}" && echo ""

echo "Scanning..."
echo ""

# ─── Detect Claude Code CLI ──────────────────────────────────────────────────
CLAUDE_BINARY=""
CLAUDE_CONFIG_DIR="${HOME}/.claude"
CLAUDE_SETTINGS="${CLAUDE_CONFIG_DIR}/settings.json"
CLAUDE_FOUND=false
CLAUDE_PATCHED=false
CLAUDE_VERSION=""

detect_claude_code() {
  if command -v claude &>/dev/null; then
    CLAUDE_BINARY="$(command -v claude)"
  elif [[ -x "${HOME}/.claude/bin/claude" ]]; then
    CLAUDE_BINARY="${HOME}/.claude/bin/claude"
  elif [[ -x "/usr/local/bin/claude" ]]; then
    CLAUDE_BINARY="/usr/local/bin/claude"
  fi

  if [[ -n "$CLAUDE_BINARY" || -d "$CLAUDE_CONFIG_DIR" ]]; then
    CLAUDE_FOUND=true
  fi

  # Check if already patched
  if [[ -f "$CLAUDE_SETTINGS" ]] && command -v python3 &>/dev/null; then
    CLAUDE_PATCHED=$(python3 -c "
import json, sys
try:
    with open('${CLAUDE_SETTINGS}') as f:
        s = json.load(f)
    hooks = s.get('hooks', {})
    has_hook = any('longmem' in json.dumps(v) for v in hooks.values() if isinstance(v, list))
    has_mcp = 'longmem' in s.get('mcpServers', {})
    print('true' if has_hook and has_mcp else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")
  fi

  # Version
  if [[ -n "$CLAUDE_BINARY" ]]; then
    CLAUDE_VERSION="$("$CLAUDE_BINARY" --version 2>/dev/null | head -1 || true)"
  fi
}

# ─── Detect OpenCode ─────────────────────────────────────────────────────────
OC_BINARY=""
OC_CONFIG_DIR="${HOME}/.config/opencode"
OC_CONFIG="${OC_CONFIG_DIR}/config.json"
OC_FOUND=false
OC_PATCHED=false
OC_VERSION=""

detect_opencode() {
  if command -v opencode &>/dev/null; then
    OC_BINARY="$(command -v opencode)"
  fi
  if [[ -n "$OC_BINARY" || -d "$OC_CONFIG_DIR" ]]; then
    OC_FOUND=true
  fi

  # Try opencode.jsonc if config.json doesn't exist
  if [[ ! -f "$OC_CONFIG" && -f "${OC_CONFIG_DIR}/opencode.jsonc" ]]; then
    OC_CONFIG="${OC_CONFIG_DIR}/opencode.jsonc"
  fi

  if [[ -f "$OC_CONFIG" ]] && command -v python3 &>/dev/null; then
    OC_PATCHED=$(python3 -c "
import json
try:
    with open('${OC_CONFIG}') as f:
        c = json.load(f)
    print('true' if 'longmem' in c.get('mcp', {}) else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")
  fi

  if [[ -n "$OC_BINARY" ]]; then
    OC_VERSION="$("$OC_BINARY" --version 2>/dev/null | head -1 || true)"
  fi
}

# ─── Detect existing daemon ──────────────────────────────────────────────────
DAEMON_INSTALLED=false
DAEMON_RUNNING=false
DAEMON_MODE=""
SERVICE_INSTALLED=false
EXISTING_INSTALL=false

detect_daemon() {
  if [[ -x "${BIN_DIR}/longmemd" ]]; then
    DAEMON_INSTALLED=true; DAEMON_MODE="binary"
  elif [[ -f "${INSTALL_DIR}/daemon.js" ]]; then
    DAEMON_INSTALLED=true; DAEMON_MODE="bun"
  fi

  if curl -sf "http://127.0.0.1:${DAEMON_PORT}/health" &>/dev/null; then
    DAEMON_RUNNING=true
  fi

  if [[ "$PLATFORM" == "linux-x64" && -f "${HOME}/.config/systemd/user/longmem.service" ]]; then
    SERVICE_INSTALLED=true
  elif [[ "$PLATFORM" == macos-* && -f "${HOME}/Library/LaunchAgents/com.longmem.daemon.plist" ]]; then
    SERVICE_INSTALLED=true
  fi

  if [[ -d "$INSTALL_DIR" ]] && { [[ "$DAEMON_INSTALLED" == true ]] || [[ -f "$SETTINGS_FILE" ]]; }; then
    EXISTING_INSTALL=true
  fi
}

detect_claude_code
detect_opencode
detect_daemon

# ─── Print detection summary ─────────────────────────────────────────────────
echo "  Detected:"

if [[ "$CLAUDE_FOUND" == true ]]; then
  ver=""
  [[ -n "$CLAUDE_VERSION" ]] && ver="v${CLAUDE_VERSION#v}"
  path=""
  [[ -n "$CLAUDE_BINARY" ]] && path="(${CLAUDE_BINARY})" || path="(config only)"
  printf "    ${GREEN}✓${RESET} %-18s %-12s %s\n" "Claude Code CLI" "$ver" "$path"
else
  printf "    ${RED}✗${RESET} %-18s %s\n" "Claude Code CLI" "not found"
fi

if [[ "$OC_FOUND" == true ]]; then
  ver=""
  [[ -n "$OC_VERSION" ]] && ver="v${OC_VERSION#v}"
  path=""
  [[ -n "$OC_BINARY" ]] && path="(${OC_BINARY})" || path="(config only)"
  printf "    ${GREEN}✓${RESET} %-18s %-12s %s\n" "OpenCode" "$ver" "$path"
else
  printf "    ${RED}✗${RESET} %-18s %s\n" "OpenCode" "not found"
fi

if [[ "$DAEMON_INSTALLED" == true ]]; then
  status="stopped"
  [[ "$DAEMON_RUNNING" == true ]] && status="running"
  printf "    ${GREEN}✓${RESET} %-18s %s mode, %s\n" "Daemon" "$DAEMON_MODE" "$status"
fi

echo ""

# Exit if no clients found
if [[ "$CLAUDE_FOUND" == false && "$OC_FOUND" == false ]]; then
  echo "No supported clients found."
  echo "Install Claude Code CLI or OpenCode first, then re-run this installer."
  exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2: Handle update
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$EXISTING_INSTALL" == true ]]; then
  old_ver="unknown"
  [[ -f "${INSTALL_DIR}/version" ]] && old_ver="$(cat "${INSTALL_DIR}/version")"
  echo "  Existing install detected (${old_ver})"

  if [[ "$DAEMON_RUNNING" == true ]]; then
    echo "  Stopping daemon for update..."
    curl -sf -X POST "http://127.0.0.1:${DAEMON_PORT}/shutdown" &>/dev/null || pkill -f longmemd 2>/dev/null || true
    sleep 1
  fi
  echo ""
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3: Download & install files
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$FLAG_DRY_RUN" == true ]]; then
  echo -e "  ${YELLOW}(dry-run)${RESET} Would download and install binaries to ${INSTALL_DIR}"
  echo ""
else
  # Resolve latest release tag
  LATEST_TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')"
  [[ -z "$LATEST_TAG" ]] && die "Could not determine latest release tag. Check your internet connection."
  echo "Version:  $LATEST_TAG"

  BASE_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}"

  DAEMON_BIN="longmemd-${PLATFORM}"
  MCP_BIN="longmem-mcp-${PLATFORM}"
  HOOK_BIN="longmem-hook-${PLATFORM}"
  [[ "$IS_WINDOWS" == true ]] && DAEMON_BIN="${DAEMON_BIN}.exe" && MCP_BIN="${MCP_BIN}.exe" && HOOK_BIN="${HOOK_BIN}.exe"

  mkdir -p "$BIN_DIR" "$LOG_DIR"
  chmod 700 "$INSTALL_DIR"

  # Download helper
  download() {
    local url="$1" dest="$2" checksum_url="${1}.sha256"
    echo "  Downloading $(basename "$dest")..."
    curl -fsSL --progress-bar "$url" -o "$dest"

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

  download "${BASE_URL}/${DAEMON_BIN}" "${BIN_DIR}/longmemd"
  download "${BASE_URL}/${MCP_BIN}"    "${BIN_DIR}/longmem-mcp"
  download "${BASE_URL}/${HOOK_BIN}"   "${BIN_DIR}/longmem-hook"
  [[ "$IS_WINDOWS" == false ]] && chmod +x "${BIN_DIR}/longmemd" "${BIN_DIR}/longmem-mcp" "${BIN_DIR}/longmem-hook"
  ok "Downloaded daemon, MCP server, and hook binary"

  # Download OpenCode plugin (JS)
  if [[ "$INSTALL_OPENCODE" == true ]]; then
    download "${BASE_URL}/plugin.js" "${INSTALL_DIR}/plugin.js"
    ok "Downloaded OpenCode plugin"
  fi

  # Default settings (never overwrite existing)
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
    ok "${SETTINGS_FILE} preserved"
  fi
  echo ""
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 4: Safe config merge (permission flow)
# ═══════════════════════════════════════════════════════════════════════════════

HOOK="${BIN_DIR}/longmem-hook"
MCP="${BIN_DIR}/longmem-mcp"

# Safe JSON merge that PRESERVES existing hooks (critical fix)
safe_merge_json() {
  local file="$1" key="$2" value="$3"
  if ! command -v python3 &>/dev/null; then
    warn "python3 not found — cannot auto-patch ${file}. Patch manually."
    return 1
  fi

  python3 - "$file" "$key" "$value" <<'PYEOF'
import sys, json
file, key, value = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    with open(file) as f:
        data = json.load(f)
except Exception:
    data = {}

parts = key.split(".")
d = data
for p in parts[:-1]:
    d = d.setdefault(p, {})

last_key = parts[-1]
new_val = json.loads(value)

# For hook arrays: merge instead of overwrite
if isinstance(new_val, list) and key.startswith("hooks."):
    existing = d.get(last_key, [])
    if isinstance(existing, list):
        # Remove old longmem entries, keep everything else
        cleaned = [e for e in existing if 'longmem' not in json.dumps(e)]
        # Append new longmem entries
        if isinstance(new_val, list):
            cleaned.extend(new_val)
        else:
            cleaned.append(new_val)
        d[last_key] = cleaned
    else:
        d[last_key] = new_val
else:
    d[last_key] = new_val

with open(file, "w") as f:
    json.dump(data, f, indent=2)
PYEOF
}

# Backup helper with timestamp
backup_config() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local ts
    ts="$(date +%Y%m%dT%H%M%S)"
    cp "$file" "${file}.pre-longmem-${ts}.bak"
    ok "Backed up ${file}"
  fi
}

# ─── Claude Code CLI coupling ────────────────────────────────────────────────
if [[ "$INSTALL_CLI" == true && "$CLAUDE_FOUND" == true ]]; then
  echo "── Claude Code CLI ──────────────────────────────────────"
  echo "  Config: ${CLAUDE_SETTINGS}"

  if [[ "$CLAUDE_PATCHED" == true ]]; then
    echo -e "  ${GREEN}✓${RESET} Already configured (skipping)"
    echo ""
  else
    # Show preview
    echo ""
    echo "  Will add:"
    echo "    hooks.PostToolUse      → ${HOOK} post-tool"
    echo "    hooks.UserPromptSubmit → ${HOOK} prompt"
    echo "    hooks.Stop             → ${HOOK} stop"
    echo "    mcpServers.longmem     → ${MCP}"
    echo ""

    APPLY=false
    if [[ "$FLAG_DRY_RUN" == true ]]; then
      echo -e "  ${YELLOW}(dry-run)${RESET} Would write to ${CLAUDE_SETTINGS}"
      APPLY=false
    elif ask_yes_no "Apply changes?"; then
      APPLY=true
    else
      echo "  Skipped."
    fi

    if [[ "$APPLY" == true ]]; then
      mkdir -p "$CLAUDE_CONFIG_DIR"
      [[ ! -f "$CLAUDE_SETTINGS" ]] && echo '{}' > "$CLAUDE_SETTINGS"
      backup_config "$CLAUDE_SETTINGS"

      safe_merge_json "$CLAUDE_SETTINGS" "hooks.PostToolUse" \
        '[{"matcher":"","hooks":[{"type":"command","command":"'"${HOOK}"' post-tool"}]}]'
      safe_merge_json "$CLAUDE_SETTINGS" "hooks.UserPromptSubmit" \
        '[{"matcher":"","hooks":[{"type":"command","command":"'"${HOOK}"' prompt"}]}]'
      safe_merge_json "$CLAUDE_SETTINGS" "hooks.Stop" \
        '[{"matcher":"","hooks":[{"type":"command","command":"'"${HOOK}"' stop"}]}]'

      safe_merge_json "$CLAUDE_SETTINGS" "mcpServers.longmem" \
        '{"command":"'"${MCP}"'","args":[]}'

      ok "Updated ${CLAUDE_SETTINGS}"
    fi
    echo ""
  fi
fi

# ─── OpenCode coupling ───────────────────────────────────────────────────────
if [[ "$INSTALL_OPENCODE" == true && "$OC_FOUND" == true ]]; then
  echo "── OpenCode ─────────────────────────────────────────────"
  echo "  Config: ${OC_CONFIG}"

  if [[ "$OC_PATCHED" == true ]]; then
    echo -e "  ${GREEN}✓${RESET} Already configured (skipping)"
    echo ""
  else
    echo ""
    echo "  Will add:"
    echo "    mcp.longmem            → ${MCP}"
    echo "    plugin                 → longmem plugin"
    echo "    instructions           → memory-instructions.md"
    echo ""

    APPLY=false
    if [[ "$FLAG_DRY_RUN" == true ]]; then
      echo -e "  ${YELLOW}(dry-run)${RESET} Would write to ${OC_CONFIG}"
      APPLY=false
    elif ask_yes_no "Apply changes?"; then
      APPLY=true
    else
      echo "  Skipped."
    fi

    if [[ "$APPLY" == true ]]; then
      INSTRUCTIONS_DIR="${HOME}/.opencode"
      INSTRUCTIONS="${INSTRUCTIONS_DIR}/memory-instructions.md"
      mkdir -p "$OC_CONFIG_DIR" "$INSTRUCTIONS_DIR"
      [[ ! -f "$OC_CONFIG" ]] && echo '{}' > "$OC_CONFIG"
      backup_config "$OC_CONFIG"

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

      if command -v python3 &>/dev/null; then
        python3 - "$OC_CONFIG" "$INSTRUCTIONS" "${INSTALL_DIR}/plugin.js" "${MCP}" <<'PYEOF'
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
        ok "Updated ${OC_CONFIG}"
      else
        warn "python3 not found — could not auto-patch ${OC_CONFIG}. Add manually:"
        echo '  "mcp": { "longmem": { "command": "'"${MCP}"'", "args": [] } }'
      fi
    fi
    echo ""
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 5: System service
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$FLAG_NO_SERVICE" == false && "$FLAG_DRY_RUN" == false ]]; then
  install_systemd_unit() {
    local exec_path="$1"
    local unit_dir="${HOME}/.config/systemd/user"
    local unit_file="${unit_dir}/longmem.service"
    mkdir -p "$unit_dir"

    cat > "$unit_file" <<UNIT
[Unit]
Description=LongMem memory daemon

[Service]
Type=simple
ExecStart=${exec_path}
Restart=on-failure
RestartSec=5
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
UNIT

    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable longmem.service 2>/dev/null || true
    systemctl --user start longmem.service 2>/dev/null || true
    ok "Installed systemd user service at ${unit_file}"
  }

  install_launchd_plist() {
    local exec_path="$1"
    local agents_dir="${HOME}/Library/LaunchAgents"
    local plist_file="${agents_dir}/com.longmem.daemon.plist"
    mkdir -p "$agents_dir"

    # Unload existing
    [[ -f "$plist_file" ]] && launchctl unload "$plist_file" 2>/dev/null || true

    cat > "$plist_file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.longmem.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exec_path}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/daemon.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
PLIST

    launchctl load "$plist_file" 2>/dev/null || true
    ok "Installed launchd plist at ${plist_file}"
  }

  DAEMON_EXEC="${BIN_DIR}/longmemd"
  if [[ -x "$DAEMON_EXEC" ]]; then
    SHOULD_INSTALL=false

    if [[ "$SERVICE_INSTALLED" == true ]]; then
      SHOULD_INSTALL=true  # Re-install to update paths
    elif ask_yes_no "Install system service for daemon auto-start on login?"; then
      SHOULD_INSTALL=true
    fi

    if [[ "$SHOULD_INSTALL" == true ]]; then
      case "$PLATFORM" in
        linux-x64)    install_systemd_unit "$DAEMON_EXEC" ;;
        macos-arm64)  install_launchd_plist "$DAEMON_EXEC" ;;
        macos-x64)    install_launchd_plist "$DAEMON_EXEC" ;;
        *) warn "Service install not supported on $PLATFORM" ;;
      esac
    fi
  else
    warn "Daemon binary not found at ${DAEMON_EXEC} — skipping service install"
  fi
  echo ""
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 6: Write uninstall script
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$FLAG_DRY_RUN" == false ]]; then
  cat > "${INSTALL_DIR}/uninstall.sh" <<'UNINSTALL'
#!/usr/bin/env bash
set -euo pipefail
echo "Removing LongMem..."

# Stop daemon
pkill -f longmemd 2>/dev/null || true

# Remove systemd unit
if [[ -f "${HOME}/.config/systemd/user/longmem.service" ]]; then
  systemctl --user stop longmem.service 2>/dev/null || true
  systemctl --user disable longmem.service 2>/dev/null || true
  rm -f "${HOME}/.config/systemd/user/longmem.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed systemd service"
fi

# Remove launchd plist
PLIST="${HOME}/Library/LaunchAgents/com.longmem.daemon.plist"
if [[ -f "$PLIST" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed launchd plist"
fi

# Restore config backups
for bak in "${HOME}/.claude/settings.json.pre-longmem-"*.bak "${HOME}/.config/opencode/config.json.pre-longmem-"*.bak; do
  if [[ -f "$bak" ]]; then
    target="${bak%.pre-longmem-*.bak}"
    echo "Found backup: $bak"
    echo "  Restore to ${target}? [y/N]"
    read -r ans
    if [[ "${ans,,}" == "y" ]]; then
      cp "$bak" "$target"
      echo "  Restored."
    fi
  fi
done

# Remove install dir
rm -rf "${HOME}/.longmem"
echo "LongMem removed. Memory DB deleted — this cannot be undone."
UNINSTALL
  chmod +x "${INSTALL_DIR}/uninstall.sh"
  ok "Created ${INSTALL_DIR}/uninstall.sh"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 7: Start daemon + verify
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$FLAG_DRY_RUN" == false ]]; then
  echo ""
  echo "── Starting daemon ──────────────────────────────────────"

  if curl -sf "http://127.0.0.1:${DAEMON_PORT}/health" &>/dev/null; then
    ok "Daemon already running"
  else
    "${BIN_DIR}/longmemd" &
    DAEMON_PID=$!
    disown $DAEMON_PID 2>/dev/null || true
    sleep 2
  fi

  # Verification
  echo ""
  echo "── Verification ─────────────────────────────────────────"
  echo ""

  # Daemon health
  if curl -sf "http://127.0.0.1:${DAEMON_PORT}/health" &>/dev/null; then
    UPTIME=$(curl -sf "http://127.0.0.1:${DAEMON_PORT}/health" 2>/dev/null | python3 -c "import sys,json;print(int(json.load(sys.stdin).get('uptime',0)))" 2>/dev/null || echo "?")
    printf "  ${GREEN}✓${RESET} %-18s port %s, uptime %ss\n" "Daemon health" "$DAEMON_PORT" "$UPTIME"
  else
    printf "  ${RED}✗${RESET} %-18s not responding on port %s\n" "Daemon health" "$DAEMON_PORT"
  fi

  # Hook binary
  if [[ -x "${BIN_DIR}/longmem-hook" ]]; then
    if echo '{}' | "${BIN_DIR}/longmem-hook" post-tool &>/dev/null; then
      printf "  ${GREEN}✓${RESET} %-18s exits 0\n" "Hook binary"
    else
      printf "  ${YELLOW}⚠${RESET}  %-18s exits non-zero (may be normal without data)\n" "Hook binary"
    fi
  else
    printf "  ${RED}✗${RESET} %-18s not found\n" "Hook binary"
  fi

  # MCP server existence
  if [[ -x "${BIN_DIR}/longmem-mcp" ]]; then
    printf "  ${GREEN}✓${RESET} %-18s binary present\n" "MCP server"
  else
    printf "  ${RED}✗${RESET} %-18s not found\n" "MCP server"
  fi

  # Config paths
  ALL_PATHS_OK=true
  for p in "$INSTALL_DIR" "$SETTINGS_FILE" "$LOG_DIR"; do
    [[ ! -e "$p" ]] && ALL_PATHS_OK=false
  done
  if [[ "$ALL_PATHS_OK" == true ]]; then
    printf "  ${GREEN}✓${RESET} %-18s all resolve\n" "Config paths"
  else
    printf "  ${RED}✗${RESET} %-18s some missing\n" "Config paths"
  fi

  echo ""
  echo -e "${BOLD}══ LongMem is ready! ════════════════════════════════════${RESET}"
  echo ""
  echo "  Changes take effect in your next Claude Code session."
  echo ""

  # Write version file
  echo "${LATEST_TAG:-unknown}" > "${INSTALL_DIR}/version"
else
  echo ""
  echo -e "${YELLOW}(dry-run complete — no changes were made)${RESET}"
  echo ""
fi

# ─── Final notes ─────────────────────────────────────────────────────────────
if [[ "$FLAG_DRY_RUN" == false ]]; then
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
fi
