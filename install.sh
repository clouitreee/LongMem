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
PASSTHROUGH_ARGS=("$@")

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
      echo "  --tui            Force interactive TUI wizard"
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

# Download all binaries
download "${BASE_URL}/longmemd-${PLATFORM}" "${BIN_DIR}/longmemd"
download "${BASE_URL}/longmem-mcp-${PLATFORM}" "${BIN_DIR}/longmem-mcp"
download "${BASE_URL}/longmem-hook-${PLATFORM}" "${BIN_DIR}/longmem-hook"
download "${BASE_URL}/longmem-cli-${PLATFORM}" "${BIN_DIR}/longmem-cli"

ok "Downloaded all binaries"
echo ""

# Write version file
echo "${LATEST_TAG:-unknown}" > "${INSTALL_DIR}/version"

# ═══════════════════════════════════════════════════════════════════════════════
# Phase 3: Delegate to CLI binary (TUI or headless)
# ═══════════════════════════════════════════════════════════════════════════════

echo "Running setup..."
echo ""
# When piped (curl | bash), stdin isn't a TTY — run headless and prompt for TUI after.
if [[ ! -t 0 ]]; then
  "${BIN_DIR}/longmem-cli" --yes ${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}
  echo ""
  echo -e "${BOLD}To configure privacy, compression, and more:${RESET}"
  echo "  ~/.longmem/bin/longmem-cli --tui"
  echo ""
else
  "${BIN_DIR}/longmem-cli" ${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}
fi
