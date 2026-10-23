#!/bin/bash
# Installs the board as a LaunchAgent so it starts at login. It listens on every interface so the
# wall tablet can reach it over Wi-Fi, but only the Mac itself (loopback, and `tailscale serve`) gets
# in freely: other devices need the key in ~/.config/tablero/clave, created here the first time and
# handed to the tablet with `scripts/tablet-kiosk.sh enlace`. Delete the key to lock them out.
# Remove the service with: launchctl bootout "gui/$(id -u)/io.devexpert.tablero" && trash ~/Library/LaunchAgents/io.devexpert.tablero.plist
set -euo pipefail

LABEL=io.devexpert.tablero
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/tablero"
KEY_FILE="$HOME/.config/tablero/clave"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")" "$(dirname "$KEY_FILE")"
if [ ! -s "$KEY_FILE" ]; then
  (umask 077 && openssl rand -hex 24 > "$KEY_FILE")
  echo "Clave para otros dispositivos creada en $KEY_FILE"
fi
# The service starts with a bare environment: carry over this shell's configuration
# (TABLERO_CUENTAS, TABLERO_TIEMPO, TAREAS_DIR, COMIDAS_DIR…) so it sees the same settings.
EXTRA=""
while IFS='=' read -r name value; do
  EXTRA+="    <key>$name</key><string>$value</string>"$'\n'
done < <(env | grep -E '^(TABLERO_[A-Z_]+|TAREAS_DIR|COMIDAS_DIR)=' | grep -v '^TABLERO_HOST=' || true)
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/bin/tablero.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TABLERO_HOST</key><string>0.0.0.0</string>
$EXTRA  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/tablero.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/tablero.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the old instance is gone; bootstrapping too early fails with error 5.
for _ in $(seq 1 20); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Tablero instalado en http://127.0.0.1:4747 y en la red local para los dispositivos emparejados (logs en $LOG_DIR/tablero.log)"
