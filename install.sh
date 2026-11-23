#!/usr/bin/env bash
# Cadbury installer: checks requirements, installs Electron, creates .env, links the `cadbury` command.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "🐱 Installing Cadbury"
command -v bun  >/dev/null && ok "bun $(bun --version)"  || fail "bun is required: curl -fsSL https://bun.sh/install | bash"
command -v curl >/dev/null && ok "curl"                    || fail "curl is required"
HAVE_AGENT=0
if command -v claude >/dev/null; then ok "Claude Code $(claude --version 2>/dev/null | head -1)"; HAVE_AGENT=1
else warn "Claude Code not found (https://claude.com/claude-code); needed for the default mode"; fi
if command -v tmux >/dev/null; then ok "tmux $(tmux -V | cut -d' ' -f2)"
else warn "tmux not found; needed for Claude Code mode (the cat types into Claude through it)"; fi
if command -v opencode >/dev/null; then ok "opencode (optional) $(opencode --version 2>/dev/null)"; HAVE_AGENT=1; fi
[ "$HAVE_AGENT" = 1 ] || fail "install Claude Code or opencode first"

if command -v electron >/dev/null && [ -z "${CADBURY_LOCAL_ELECTRON:-}" ]; then
  ok "system electron $(electron --version 2>/dev/null)"
else
  echo "  … installing Electron with bun"
  bun install --silent && ok "electron installed in node_modules"
fi

if [ ! -f .env ]; then cp .env.example .env; ok "created .env (add GEMINI_API_KEY or OPENAI_API_KEY for voice)"
else ok ".env already exists (left untouched)"; fi
chmod +x bin/cadbury bin/cadbury-hook bin/cadbury-talk bin/mochi bin/mochi-hook bin/mochi-talk

BIN="${CADBURY_BIN_DIR:-${MOCHI_BIN_DIR:-$HOME/.local/bin}}"
mkdir -p "$BIN"
ln -sf "$ROOT/bin/cadbury" "$BIN/cadbury" && ok "linked $BIN/cadbury"
[ -L "$BIN/mochi" ] && ok "old $BIN/mochi link still works (it now starts cadbury)"
case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN is not on your PATH; add it to your shell profile";; esac

cat <<MSG

Done. Next:
  1. Get a free Gemini key at https://aistudio.google.com/apikey and put it in $ROOT/.env
  2. cd into a project and run:  cadbury
  3. Click the cat to talk.  (Docs: $ROOT/README.md)
MSG
