#!/usr/bin/env bash
# Prepares the wall tablet (a generic "Tab_9", MediaTek MT6750, Android 8.1) as a kiosk for the
# board: screen always on while plugged in, landscape, no screensaver or system animations, Madrid
# time, Firefox full screen, and the vendor, preinstalled and Google apps disabled. Everything is
# reversible: apps are disabled, not uninstalled, and `deshacer` turns them back on.
#
#   scripts/tablet-kiosk.sh aplicar     # apply (idempotent)
#   scripts/tablet-kiosk.sh enlace      # open the board on the tablet with the device key (pairs it)
#   scripts/tablet-kiosk.sh deshacer    # re-enable the apps and restore the settings
#   scripts/tablet-kiosk.sh estado      # show what is disabled and the relevant settings
#
# Firefox itself is installed by hand from Mozilla's official APK (see README, "Tablet de pared").
set -euo pipefail

ADB="${ADB:-adb}"
FIREFOX=org.mozilla.firefox
GECKO_CONFIG="/data/local/tmp/$FIREFOX-geckoview-config.yaml"

# Apps a kiosk does not need. Phone stack, providers, launcher, keyboard, settings and WebView are
# left alone on purpose.
DISABLE=(
  # Preinstalled as user apps by the vendor
  com.google.android.apps.classroom com.google.android.apps.meetings com.google.android.youtube
  com.netflix.mediaclient us.zoom.videomeetings
  # Vendor ("Shcy") tools with SMS, contacts, mic, camera and location permissions
  com.android.custom com.example com.example.getinfodemo com.example.shcyfingerstylesel
  com.example.shcymedia com.example.shcysmartwake com.shcy.agingtest com.shcy.fingerprint
  com.shcy.floatball com.shcy.select com.android.shcy.version com.mediatek.factorymode
  com.baidu.map.location
  # MediaTek logging, test and location tools
  com.mediatek.mtklogger com.mediatek.mtklogger.proxy com.mediatek.engineermode com.mediatek.ygps
  com.mediatek.lbs.em2.ui com.mediatek.location.lppe.main com.mediatek.sensorhub.ui
  com.mediatek.bluetooth.dtt com.mediatek.mdmlsample com.mediatek.mdmconfig com.mtk.telephony
  # Telephony front-ends (there is no SIM)
  com.android.dialer com.android.mms com.android.stk com.mediatek.callrecorder com.mediatek.omacp
  # Everyday apps nobody will open on the wall
  com.android.email com.android.exchange com.android.calendar com.mediatek.calendarimporter
  com.android.contacts com.android.deskclock com.android.music com.android.fmradio
  com.android.soundrecorder com.android.gallery3d com.mediatek.camera com.mediatek.filemanager
  com.android.calculator2 com.google.android.apps.maps com.google.android.feedback
  com.google.android.tts jp.co.omronsoft.openwnn com.android.facelock com.android.egg
  com.android.dreams.basic com.android.wallpaper.livepicker com.android.bips
  com.google.android.printservice.recommendation
)

# Only once Firefox is there: the old browsers (Chrome 64 cannot run the board) and Google's
# services, which without a Google account only use memory. WebView falls back to the system one.
DISABLE_WITH_FIREFOX=(
  com.android.chrome com.android.browser com.android.vending com.google.android.gms
  com.google.android.gsf com.google.android.partnersetup com.google.android.onetimeinitializer
  com.google.android.backuptransport com.google.android.configupdater
  com.google.android.syncadapters.calendar com.google.android.syncadapters.contacts
)

# setting, kiosk value, value found on the tablet ("null" means it was not set)
SETTINGS=(
  "global stay_on_while_plugged_in|7|0"
  "system screen_off_timeout|1800000|60000"
  "secure screensaver_enabled|0|1"
  "secure screensaver_activate_on_dock|0|1"
  "secure screensaver_activate_on_sleep|0|0"
  "global window_animation_scale|0|null"
  "global transition_animation_scale|0|null"
  "global animator_duration_scale|0|null"
  "global heads_up_notifications_enabled|0|1"
  "global wifi_sleep_policy|2|2"
  "global auto_time_zone|0|1"
  "system time_12_24|24|null"
  # Landscape, whatever the accelerometer says (rotation 1 = 90°; use 3 if it hangs upside down)
  "system accelerometer_rotation|0|1"
  "system user_rotation|1|0"
  # No status or navigation bar over Firefox (swipe from an edge shows them for a moment)
  "global policy_control|immersive.full=$FIREFOX|null"
)

die() { echo "$*" >&2; exit 1; }

check_device() {
  command -v "$ADB" >/dev/null || die "No encuentro adb"
  local state
  state=$("$ADB" get-state 2>/dev/null || true)
  [[ "$state" == "device" ]] || die "No hay ninguna tablet autorizada por adb (estado: ${state:-ninguna})"
}

shell() { "$ADB" shell "$@" | tr -d '\r'; }

installed() { shell pm list packages "$1" | grep -qx "package:$1"; }

disable_all() {
  for pkg in "$@"; do
    if shell pm list packages -e "$pkg" | grep -qx "package:$pkg"; then
      shell pm disable-user --user 0 "$pkg" >/dev/null && echo "Desactivada $pkg"
    fi
  done
}

enable_all() {
  for pkg in "$@"; do
    if shell pm list packages -d "$pkg" | grep -qx "package:$pkg"; then
      shell pm enable "$pkg" >/dev/null && echo "Reactivada $pkg"
    fi
  done
}

# The shell user cannot change the time zone on this build (no SET_TIME_ZONE), so it is picked by
# hand in Settings; this only checks it and opens the screen when it is wrong.
check_timezone() {
  local zone
  zone=$(shell getprop persist.sys.timezone)
  if [[ "$zone" == "Europe/Madrid" ]]; then
    echo "Zona horaria: $zone"
  else
    shell am start -a android.settings.DATE_SETTINGS >/dev/null
    echo "Zona horaria: $zone. Elige Madrid en la tablet (Seleccionar zona horaria); se ha abierto la pantalla."
  fi
}

# Software rendering. Firefox's GPU renderer is about three times smoother on this Mali-T860 (measured
# 2026-10: ~30 fps against 7-14 when sliding the calendar), but its driver breaks anything drawn
# through an intermediate layer: `opacity`, `will-change` and compositor animations leave elements
# undrawn, unmoved or with square notches in rounded corners. Even with a flat page (the board avoids
# all of those), parts that scroll into view come out without backgrounds or with grey bars. Firefox
# already blocks the known Mali-T workarounds (partial present, optimized shaders); turning off
# scissored cache clears only helps in part. GeckoView reads these prefs because Firefox is set as the
# debug app.
configure_firefox() {
  local tmp
  tmp=$(mktemp)
  # The two media prefs let the board use the microphone (voice commands) over plain HTTP on the
  # home network; Firefox only allows it on HTTPS otherwise. It still asks once per site.
  printf 'prefs:\n  gfx.webrender.software: true\n  browser.translations.enable: false\n  media.getusermedia.insecure.enabled: true\n  media.devices.insecure.enabled: true\n' > "$tmp"
  "$ADB" push "$tmp" "$GECKO_CONFIG" >/dev/null 2>&1
  rm -f "$tmp"
  shell am set-debug-app --persistent "$FIREFOX"
  shell pm grant "$FIREFOX" android.permission.RECORD_AUDIO
  echo "Firefox: renderizado por software, sin traducciones y con micrófono en la red local (se aplica al reabrirlo)"
}

apply() {
  disable_all "${DISABLE[@]}"
  if installed "$FIREFOX"; then
    disable_all "${DISABLE_WITH_FIREFOX[@]}"
    configure_firefox
  else
    echo "Firefox no está instalado: Chrome y los servicios de Google se quedan como están."
  fi
  for entry in "${SETTINGS[@]}"; do
    IFS='|' read -r key value _ <<<"$entry"
    shell settings put $key "$value"
  done
  check_timezone
  echo "Listo: pantalla siempre encendida mientras esté enchufada, en horizontal y sin animaciones."
}

undo() {
  enable_all "${DISABLE[@]}" "${DISABLE_WITH_FIREFOX[@]}"
  for entry in "${SETTINGS[@]}"; do
    IFS='|' read -r key _ original <<<"$entry"
    if [[ "$original" == "null" ]]; then shell settings delete $key >/dev/null; else shell settings put $key "$original"; fi
  done
  shell am clear-debug-app
  shell rm -f "$GECKO_CONFIG"
  echo "Deshecho. La zona horaria (Madrid), el idioma y Firefox se quedan como están."
}

# Opens the board in Firefox with the device key, which the server keeps as a cookie on the tablet.
# The key never shows on screen or in this output.
pair() {
  local key_file="${TABLERO_CLAVE_FILE:-$HOME/.config/tablero/clave}" port="${TABLERO_PORT:-4747}"
  [[ -s "$key_file" ]] || die "No hay clave en $key_file: instala el servicio con scripts/instalar-servicio.sh"
  installed "$FIREFOX" || die "Firefox no está instalado en la tablet"
  local tablet_ip iface mac_ip
  tablet_ip=$(shell ip -4 addr show wlan0 | awk '/inet /{split($2, a, "/"); print a[1]}')
  [[ -n "$tablet_ip" ]] || die "La tablet no tiene Wi-Fi"
  iface=$(route -n get "$tablet_ip" | awk '/interface:/{print $2}')
  mac_ip=$(ipconfig getifaddr "$iface" || true)
  [[ -n "$mac_ip" ]] || die "No sé por qué IP llega la tablet al Mac"
  shell am start -a android.intent.action.VIEW -d "'http://$mac_ip:$port/?clave=$(cat "$key_file")&kiosco=1'" "$FIREFOX" >/dev/null
  echo "Tablero abierto en la tablet: http://$mac_ip:$port (toca la pantalla una vez para el modo kiosco)"
}

status() {
  echo "Apps desactivadas:"
  shell pm list packages -d | sed 's/^package:/  /' | sort
  echo "Ajustes:"
  for entry in "${SETTINGS[@]}"; do
    IFS='|' read -r key _ _ <<<"$entry"
    printf '  %-45s %s\n' "$key" "$(shell settings get $key)"
  done
  printf '  %-45s %s\n' "zona horaria" "$(shell getprop persist.sys.timezone)"
  printf '  %-45s %s\n' "idioma" "$(shell getprop persist.sys.locale)"
  printf '  %-45s %s\n' "firefox" "$(shell dumpsys package "$FIREFOX" | awk -F= '/versionName/{print $2; exit}')"
}

check_device
case "${1:-}" in
  aplicar) apply ;;
  enlace) pair ;;
  deshacer) undo ;;
  estado) status ;;
  *) die "Uso: $0 aplicar|enlace|deshacer|estado" ;;
esac
