#!/usr/bin/env bash
# Idempotent (re)deploy helper for Warlock. Run as `sem` with sudo available.
set -euo pipefail

ROOT="${WARLOCK_ROOT:-/opt/warlock}"
DATA="${WARLOCK_DATA:-$HOME/warlock}"

echo "==> Warlock redeploy from $ROOT (data=$DATA)"

# 1. Operator data tree
for d in engagements captures tracks handshakes wordlists reports; do
    mkdir -p "$DATA/$d"
done
touch "$DATA/wordlists/.gitkeep"

# 2. Python venv via uv
if ! command -v uv >/dev/null 2>&1; then
    echo "error: uv not on PATH" >&2
    exit 1
fi

cd "$ROOT"
if [[ ! -d .venv ]]; then
    uv venv --python 3.13 || uv venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
uv pip install -e .
deactivate

# 3. Web build (only if web/package.json present and node available)
if [[ -f web/package.json ]]; then
    # shellcheck disable=SC1090
    [[ -f "$HOME/.local/share/fnm/fnm" ]] && eval "$("$HOME/.local/share/fnm/fnm" env)" || true
    if command -v npm >/dev/null 2>&1; then
        (cd web && npm ci --no-audit --no-fund || npm install --no-audit --no-fund) || true
        (cd web && npm run build) || true
        rm -rf web/node_modules
    fi
fi

# 4. Systemd unit
if [[ -f systemd/warlock.service ]]; then
    sudo install -m 0644 systemd/warlock.service /etc/systemd/system/warlock.service
    sudo systemctl daemon-reload
fi

# 5. CLI shim
sudo install -m 0755 scripts/warlock /usr/local/bin/warlock

# 6. tmpfiles for the Unix socket dir
sudo tee /etc/tmpfiles.d/warlock.conf >/dev/null <<'EOF'
d /run/warlock 0750 sem sem -
EOF
sudo systemd-tmpfiles --create /etc/tmpfiles.d/warlock.conf || true

# 7. Desktop launchers + icon — system menu AND sem's Desktop.
echo "==> Installing desktop launchers"
if [[ -f scripts/desktop/warlock.svg ]]; then
    sudo install -Dm644 scripts/desktop/warlock.svg \
        /usr/share/icons/hicolor/scalable/apps/warlock.svg
    # Optional raster for environments that prefer PNG.
    if [[ -f scripts/desktop/warlock.png ]]; then
        sudo install -Dm644 scripts/desktop/warlock.png \
            /usr/share/icons/hicolor/256x256/apps/warlock.png
    fi
fi
if [[ -f scripts/desktop/warlock-tui.desktop ]]; then
    sudo install -Dm644 scripts/desktop/warlock-tui.desktop \
        /usr/share/applications/warlock-tui.desktop
fi
if [[ -f scripts/desktop/warlock-web.desktop ]]; then
    sudo install -Dm644 scripts/desktop/warlock-web.desktop \
        /usr/share/applications/warlock-web.desktop
fi
# Refresh icon + desktop caches.
sudo gtk-update-icon-cache /usr/share/icons/hicolor 2>/dev/null || true
sudo update-desktop-database /usr/share/applications 2>/dev/null || true

# Also drop copies on sem's Desktop for click-to-launch icons.
if [[ -f scripts/desktop/warlock-tui.desktop ]]; then
    install -Dm755 scripts/desktop/warlock-tui.desktop "$HOME/Desktop/warlock-tui.desktop"
    install -Dm755 scripts/desktop/warlock-web.desktop "$HOME/Desktop/warlock-web.desktop"
    # LXDE/XFCE trusts only files with the `metadata::trusted` flag set.
    gio set "$HOME/Desktop/warlock-tui.desktop" metadata::trusted true 2>/dev/null || true
    gio set "$HOME/Desktop/warlock-web.desktop" metadata::trusted true 2>/dev/null || true
fi

echo "==> Enabling warlock.service"
sudo systemctl enable warlock
sudo systemctl restart warlock || sudo systemctl start warlock
sleep 2
sudo systemctl is-active warlock
echo "==> Done. curl http://127.0.0.1:7777/api/health"
