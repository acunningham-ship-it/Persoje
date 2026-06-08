#!/usr/bin/env bash
# Persoje installer — clone/update, build a standalone binary, symlink onto PATH.
# Idempotent: re-run any time to update. Requires Bun (https://bun.sh).
set -euo pipefail

REPO="https://github.com/acunningham-ship-it/Persoje.git"
SRC="${PERSOJE_DIR:-$HOME/.local/share/persoje-src}"
BIN_DIR="${PERSOJE_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[38;5;214m●\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "Bun is required — install it: curl -fsSL https://bun.sh/install | bash"

if [ -d "$SRC/.git" ]; then
  say "updating $SRC"
  git -C "$SRC" pull --ff-only --quiet
else
  say "cloning into $SRC"
  git clone --quiet "$REPO" "$SRC"
fi

cd "$SRC"
say "installing dependencies"
bun install --silent

say "building binary"
bun build --compile --minify --outfile dist/persoje src/cli.ts >/dev/null

mkdir -p "$BIN_DIR"
ln -sf "$SRC/dist/persoje" "$BIN_DIR/persoje"
say "linked $BIN_DIR/persoje"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\033[33m⚠ %s is not on your PATH — add: export PATH="%s:$PATH"\033[0m\n' "$BIN_DIR" "$BIN_DIR" ;;
esac

say "done — run: persoje"
echo "   (first launch sets up your OpenRouter key + model)"
