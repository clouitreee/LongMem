#!/usr/bin/env bash
# LongMem — universal installer
# Usage: curl -fsSL https://github.com/clouitreee/LongMem/releases/latest/download/install.sh | bash
# Or:    bash install.sh --yes --no-service
set -euo pipefail

REPO="clouitreee/LongMem"
INSTALL_DIR="${HOME}/.longmem"
BIN_DIR="${INSTALL_DIR}/bin"
LOG_DIR="${INSTALL_DIR}/logs"

# ─── Color helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
err()  { echo -e "${RED}✗${RESET} $*" >&2; }
die()  { err "$*"; exit 1; }

# ─── Parse args ──────────────────────────────────────────────────────────────
declare -a PASSTHROUGH_ARGS=()
PASSTHROUGH_ARGS=("$@")

# Detect --yes / -y to force headless
HAS_YES=false
if [[ ${#PASSTHROUGH_ARGS[@]} -gt 0 ]]; then
  for arg in "${PASSTHROUGH_ARGS[@]}"; do
    case "$arg" in
      --yes|-y) HAS_YES=true ;;
    esac
  done
fi

# Detect dry-run
HAS_DRY_RUN=false
if [[ ${#PASSTHROUGH_ARGS[@]} -gt 0 ]]; then
  for arg in "${PASSTHROUGH_ARGS[@]}"; do
    case "$arg" in
      --dry-run) HAS_DRY_RUN=true ;;
    esac
  done
fi

# Remove --tui/-t when forcing headless to avoid Bun TUI
HEADLESS_ARGS=()
if [[ ${#PASSTHROUGH_ARGS[@]} -gt 0 ]]; then
  for arg in "${PASSTHROUGH_ARGS[@]}"; do
    case "$arg" in
      --tui|-t) ;;
      *) HEADLESS_ARGS+=("$arg") ;;
    esac
  done
fi

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

run_bash_wizard() {
  local settings_path="${INSTALL_DIR}/settings.json"
  local privacy_mode="safe"
  local redact_secrets="true"
  local auto_context="true"
  local comp_enabled="false"
  local comp_provider="openrouter"
  local comp_model="meta-llama/llama-3.1-8b-instruct"
  local comp_key=""

  echo ""
  echo "LongMem setup"
  echo "-------------"

  PS3="Privacy mode: "
  select privacy in "Safe (recommended)" "Flexible" "None"; do
    case "$privacy" in
      "Safe (recommended)") privacy_mode="safe"; redact_secrets="true"; break ;;
      "Flexible") privacy_mode="flexible"; redact_secrets="true"; break ;;
      "None") privacy_mode="none"; redact_secrets="false"; break ;;
    esac
  done

  read -r -p "Enable auto-context? [Y/n] " ac
  if [[ -n "$ac" && ! "$ac" =~ ^[Yy]$ ]]; then
    auto_context="false"
  fi

  read -r -p "Enable compression? [y/N] " comp
  if [[ -n "$comp" && "$comp" =~ ^[Yy]$ ]]; then
    comp_enabled="true"
    PS3="Compression provider: "
    select provider in "OpenRouter" "OpenAI" "Anthropic" "Local (Ollama/LM Studio)"; do
      case "$provider" in
        "OpenRouter") comp_provider="openrouter"; comp_model="meta-llama/llama-3.1-8b-instruct"; break ;;
        "OpenAI") comp_provider="openai"; comp_model="gpt-4o-mini"; break ;;
        "Anthropic") comp_provider="anthropic"; comp_model="claude-haiku-4-5-20251001"; break ;;
        "Local (Ollama/LM Studio)") comp_provider="local"; comp_model="llama3.1:8b"; break ;;
      esac
    done

    if [[ "$comp_provider" != "local" ]]; then
      read -r -p "API key for $provider: " comp_key
    fi
  fi

  if [[ -f "$settings_path" ]]; then
    cp "$settings_path" "${settings_path}.bak"
  fi

  cat > "$settings_path" <<EOF
{
  "compression": {
    "enabled": ${comp_enabled},
    "provider": "${comp_provider}",
    "model": "${comp_model}",
    "apiKey": "$(json_escape "$comp_key")",
    "maxConcurrent": 1,
    "idleThresholdSeconds": 5,
    "maxPerMinute": 10
  },
  "daemon": { "port": 38741 },
  "privacy": {
    "mode": "${privacy_mode}",
    "redactSecrets": ${redact_secrets},
    "customPatterns": []
  },
  "autoContext": { "enabled": ${auto_context} }
}
EOF
  chmod 600 "$settings_path"
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      echo "Usage: install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --yes, -y        Skip all prompts (answer Y)"
      echo "  --dry-run        Preview changes without modifying anything"
      echo "  --no-service     Don't install systemd/launchd unit"
      echo "  --opencode       Also configure OpenCode"
      echo "  --all            Configure both Claude Code CLI and OpenCode"
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
        aarch64) echo "linux-arm64" ;;
        *)       die "Unsupported Linux arch: $arch" ;;
      esac ;;
    Darwin)
      case "$arch" in
        arm64)  echo "macos-arm64" ;;
        x86_64) echo "macos-x64" ;;
        *)      die "Unsupported macOS arch: $arch" ;;
      esac ;;
    *) die "Unsupported OS: $os" ;;
  esac
}

PLATFORM="$(detect_platform)"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 1: Banner
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}╔══════════════════════════════════╗${RESET}"
echo -e "${BOLD}║       LongMem installer          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════╝${RESET}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 2: Download binaries
# ═══════════════════════════════════════════════════════════════════════════════

# Resolve latest release tag
LATEST_TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')"
[[ -z "$LATEST_TAG" ]] && die "Could not determine latest release tag. Check your internet connection."
echo "Version:  $LATEST_TAG"

BASE_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}"

mkdir -p "$BIN_DIR" "$LOG_DIR"
chmod 700 "$INSTALL_DIR"

# Stop running daemon before overwriting binaries
if curl -sf "http://127.0.0.1:38741/health" &>/dev/null; then
  echo "  Stopping daemon for update..."
  curl -sf -X POST "http://127.0.0.1:38741/shutdown" &>/dev/null || pkill -f longmemd 2>/dev/null || true
  sleep 1
fi

# Download helper with checksum verification
download() {
  local url="$1" dest="$2" checksum_url="${1}.sha256"
  echo "  Downloading $(basename "$dest")..."
  curl -fsSL --progress-bar "$url" -o "$dest"
  chmod +x "$dest"

  local sha_cmd=""
  if command -v sha256sum &>/dev/null; then sha_cmd="sha256sum";
  elif command -v shasum &>/dev/null; then sha_cmd="shasum -a 256"; fi

  if [[ -n "$sha_cmd" ]]; then
    local expected actual
    expected="$(curl -fsSL "${checksum_url}" 2>/dev/null | awk '{print $1}' || true)"
    if [[ -n "$expected" ]]; then
      actual="$($sha_cmd "$dest" | awk '{print $1}')"
      if [[ "$expected" != "$actual" ]]; then
        rm -f "$dest"
        die "Checksum mismatch for $(basename "$dest"). Download may be corrupted."
      fi
      echo "  Checksum OK"
    fi
  fi
}

# Download monolith binary + create symlinks
download "${BASE_URL}/longmem-${PLATFORM}" "${BIN_DIR}/longmem"

for name in longmemd longmem-mcp longmem-hook longmem-cli; do
  ln -sf longmem "${BIN_DIR}/${name}"
done

ok "Downloaded monolith binary + created symlinks"
echo ""

# Write version file
echo "${LATEST_TAG:-unknown}" > "${INSTALL_DIR}/version"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3: Delegate to CLI binary (wizard or headless)
# ═══════════════════════════════════════════════════════════════════════════════

echo "Running setup..."
echo ""
if [[ "$HAS_YES" == "true" ]]; then
  # Headless by explicit choice
  "${BIN_DIR}/longmem-cli" ${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}
elif [[ "$HAS_DRY_RUN" == "true" ]]; then
  # Dry-run should not write settings
  "${BIN_DIR}/longmem-cli" --yes ${HEADLESS_ARGS[@]+"${HEADLESS_ARGS[@]}"}
else
  if [[ -c /dev/tty ]]; then
    # Use a simple bash wizard instead of Bun TUI
    exec < /dev/tty
    run_bash_wizard
    "${BIN_DIR}/longmem-cli" --yes ${HEADLESS_ARGS[@]+"${HEADLESS_ARGS[@]}"}
  else
    # No terminal (CI, Docker, etc.) — headless mode
    "${BIN_DIR}/longmem-cli" --yes ${HEADLESS_ARGS[@]+"${HEADLESS_ARGS[@]}"}
    echo ""
    echo -e "${BOLD}LongMem installed with defaults.${RESET}"
    echo "Edit settings here: ${INSTALL_DIR}/settings.json"
    echo ""
fi
