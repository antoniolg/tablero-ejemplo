#!/usr/bin/env bash
# The demo board on made-up data, for videos and screenshots (see demo/servidor.mjs). It runs as a
# launchd job next to the real board, on its own port and its own data, and never touches either.
#
#   demo/demo.sh datos [AAAA-MM-DD]   # made-up data around that day (today by default), from scratch
#   demo/demo.sh arrancar             # start it on :4949
#   demo/demo.sh parar                # stop it
#   demo/demo.sh estado               # whether it runs, with which day's data and where
#   demo/demo.sh tablet               # open the demo on the wall tablet
#   demo/demo.sh volver               # put the real board back on the tablet
#   demo/demo.sh terminal             # a shell where `tareas` (and any agent) works on the demo's cards
#
# The tablet needs no pairing: the demo uses the real board's device key, and the tablet already has
# it as a cookie for the Mac's address (cookies do not depend on the port).
set -euo pipefail

LABEL=io.devexpert.tablero-demo
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
DATA="$HERE/datos"
PORT="${TABLERO_PORT:-4949}"
REAL_PORT=4747
NODE="$(command -v node)"
ADB="${ADB:-adb}"
FIREFOX=org.mozilla.firefox
DOMAIN="gui/$(id -u)"

die() { echo "$*" >&2; exit 1; }
loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
answers() { curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; }

data() {
  "$NODE" "$HERE/datos.mjs" "$@"
  if loaded; then stop && start; fi
}

start() {
  [[ -s "$DATA/google.json" ]] || "$NODE" "$HERE/datos.mjs"
  if answers; then echo "La demo ya está en marcha: http://127.0.0.1:$PORT"; return; fi
  loaded && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  local plist="$DATA/$LABEL.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$HERE/servidor.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>TABLERO_PORT</key><string>$PORT</string></dict>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DATA/servidor.log</string>
  <key>StandardErrorPath</key><string>$DATA/servidor.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "$DOMAIN" "$plist"
  for _ in $(seq 1 40); do answers && break; sleep 0.25; done
  answers || die "La demo no arranca: mira $DATA/servidor.log"
  echo "Demo en http://127.0.0.1:$PORT con los datos del $(cat "$DATA/dia.txt")"
}

stop() {
  if loaded; then launchctl bootout "$DOMAIN/$LABEL"; fi
  for _ in $(seq 1 20); do answers || break; sleep 0.25; done
  echo "Demo parada"
}

status() {
  if answers; then echo "En marcha: http://127.0.0.1:$PORT"; else echo "Parada"; fi
  [[ -s "$DATA/dia.txt" ]] && echo "Datos del $(cat "$DATA/dia.txt") en $DATA" || echo "Sin datos (demo/demo.sh datos)"
}

# The tablet over adb: the first authorized device (it can show up twice, by USB and by Wi-Fi).
tablet_shell() {
  command -v "$ADB" >/dev/null || die "No encuentro adb"
  export ANDROID_SERIAL="${ANDROID_SERIAL:-$("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')}"
  [[ -n "$ANDROID_SERIAL" ]] || die "No hay ninguna tablet autorizada por adb"
  "$ADB" shell "$@" | tr -d '\r'
}

# The Mac's address as the tablet reaches it, as scripts/tablet-kiosk.sh does.
mac_url() {
  local tablet_ip iface mac_ip
  tablet_ip=$(tablet_shell ip -4 addr show wlan0 | awk '/inet /{split($2, a, "/"); print a[1]}')
  [[ -n "$tablet_ip" ]] || die "La tablet no tiene Wi-Fi"
  iface=$(route -n get "$tablet_ip" | awk '/interface:/{print $2}')
  mac_ip=$(ipconfig getifaddr "$iface" || true)
  [[ -n "$mac_ip" ]] || die "No sé por qué IP llega la tablet al Mac"
  echo "http://$mac_ip:$1"
}

open_on_tablet() {
  local url
  url="$(mac_url "$1")"
  tablet_shell am start -a android.intent.action.VIEW -d "'$url/?kiosco=1'" "$FIREFOX" >/dev/null
  echo "Abierto en la tablet: $url (tócala una vez para la pantalla completa)"
}

tablet() {
  answers || die "La demo no está en marcha: demo/demo.sh arrancar"
  open_on_tablet "$PORT"
}

terminal() {
  echo "Terminal de la demo: «tareas» y los agentes que lances aquí trabajan sobre $DATA/tareas. Sal con exit."
  TAREAS_DIR="$DATA/tareas" COMIDAS_DIR="$DATA/comidas" exec "${SHELL:-/bin/zsh}" -i
}

case "${1:-}" in
  datos) shift; data "$@" ;;
  arrancar) start ;;
  parar) stop ;;
  estado) status ;;
  tablet) tablet ;;
  volver) open_on_tablet "$REAL_PORT" ;;
  terminal) terminal ;;
  *) die "Uso: $0 datos [AAAA-MM-DD]|arrancar|parar|estado|tablet|volver|terminal" ;;
esac
