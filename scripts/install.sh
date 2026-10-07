#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required. Current: $(node -v)." >&2
  echo "If you use nvm: nvm use 20" >&2
  exit 1
fi

npm install
npm run build
chmod +x bin/container-translate.js bin/docker.js bin/docker-compose.js

mkdir -p "$HOME/.local/bin"
ln -sfn "$ROOT/bin/container-translate.js" "$HOME/.local/bin/container-translate"
ln -sfn "$ROOT/bin/docker.js" "$HOME/.local/bin/docker"
ln -sfn "$ROOT/bin/docker-compose.js" "$HOME/.local/bin/docker-compose"

ZSHRC="$HOME/.zshrc"
MARKER="# container-translate"
if [ -f "$ZSHRC" ] && grep -q "$MARKER" "$ZSHRC"; then
  echo "PATH block already present in $ZSHRC"
else
  cat >> "$ZSHRC" <<'EOF'

# container-translate
export PATH="$HOME/.local/bin:$PATH"
# A zsh function named docker() overrides every docker binary. Drop it so the shim is used.
unfunction docker 2>/dev/null || true
EOF
  echo "Updated $ZSHRC: ~/.local/bin is first on PATH, and a docker() function is removed."
fi

echo
echo "Installed shims in $HOME/.local/bin"
echo "Open a new terminal so ~/.local/bin is searched before /usr/local/bin."
if [ -x /usr/local/bin/docker ]; then
  echo "The previous wrapper is still at /usr/local/bin/docker. It only remaps ps and will pass compose through to container, which fails."
fi
echo "Check with: which docker docker-compose container-translate"
echo "sudo docker still misses these shims. Apple Container does not need sudo."
