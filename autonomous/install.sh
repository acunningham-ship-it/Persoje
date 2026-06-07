#!/usr/bin/env bash
# =============================================================================
# Persoje Autonomous — Install Script
#
# Sets up everything needed for autonomous mode:
#   1. Checks/installs tmux (the only external dep)
#   2. Links the persoje binary to ~/.local/bin
#   3. Links the autonomous runner to ~/.local/bin
#   4. Creates the data directory
#   5. Verifies everything works
#
# Run: bash autonomous/install.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.local/share/persoje-autonomous"

echo "◆ Persoje Autonomous — Installer"
echo ""

# 1. Check tmux
if command -v tmux &>/dev/null; then
    echo "  ✓ tmux $(tmux -V 2>/dev/null || echo 'installed')"
else
    echo "  ⚠ tmux not found — installing..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq tmux
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y tmux
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm tmux
    elif command -v brew &>/dev/null; then
        brew install tmux
    else
        echo "  ✗ Can't auto-install tmux. Install it manually and re-run."
        exit 1
    fi
    echo "  ✓ tmux installed"
fi

# 2. Build persoje if needed
if [ ! -f "$PROJECT_DIR/dist/persoje" ]; then
    echo "  ⚠ persoje binary not found — building..."
    cd "$PROJECT_DIR"
    if command -v bun &>/dev/null; then
        bun build --compile --minify --outfile dist/persoje src/cli.ts
    else
        echo "  ✗ bun not found. Install bun: curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
    echo "  ✓ persoje built"
fi

# 3. Link binaries
mkdir -p "$BIN_DIR"
ln -sf "$PROJECT_DIR/dist/persoje" "$BIN_DIR/persoje"
ln -sf "$SCRIPT_DIR/persoje-autonomous.sh" "$BIN_DIR/persoje-autonomous"
chmod +x "$SCRIPT_DIR/persoje-autonomous.sh"
echo "  ✓ linked persoje → $BIN_DIR/persoje"
echo "  ✓ linked persoje-autonomous → $BIN_DIR/persoje-autonomous"

# 4. Create data directory
mkdir -p "$DATA_DIR"
echo "  ✓ data dir: $DATA_DIR"

# 5. Verify
echo ""
echo "━━━ Verification ━━━"
command -v persoje &>/dev/null && echo "  ✓ persoje in PATH" || echo "  ✗ persoje not in PATH (add $BIN_DIR to your PATH)"
command -v persoje-autonomous &>/dev/null && echo "  ✓ persoje-autonomous in PATH" || echo "  ✗ persoje-autonomous not in PATH"
command -v tmux &>/dev/null && echo "  ✓ tmux available" || echo "  ✗ tmux missing"

echo ""
echo "◆ Done. Run 'persoje' to start, then /autonomous on to go persistent."
