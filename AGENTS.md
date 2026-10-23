# AGENTS.md

A personal day dashboard (wall tablet + Mac): task board (Markdown cards + the `tareas` CLI), a read-only Google Calendar week and a weekly meal plan.

## Commands

- `npm test` — node:test suite (cards, CLI, server, Markdown rendering). Run it after any change.
- `node bin/tablero.mjs` — serve the board on 127.0.0.1:4747 (`TABLERO_PORT`, `TABLERO_HOST`, `TABLERO_HOSTS`, `TAREAS_DIR`).
- `node bin/tareas.mjs --help` — the CLI (installed as `~/.local/bin/tareas`).

## Live board and testing

- A LaunchAgent (`io.devexpert.tablero`) keeps `bin/tablero.mjs` running on port 4747 (all interfaces) against the real cards in `TAREAS_DIR` (default `~/tablero/tareas`). Logs: `~/Library/Logs/tablero/tablero.log`. The Mac gets in over loopback; other devices need the key in `~/.config/tablero/clave` (see `src/devices.mjs`). Never print or log that key.
- The wall tablet (Android 8.1, Firefox in kiosk mode) shows the live board. `scripts/tablet-kiosk.sh` (adb) applies and undoes its setup and pairs it (`enlace`). It shows real data: inspect it with screenshots, but never tap cards or buttons there.
- Files in `public/` are read on every request, and open pages (the tablet too) reload themselves when they change, so UI changes show up on their own. Changes to `src/` or `bin/tablero.mjs` need a restart: `launchctl kickstart -k gui/$(id -u)/io.devexpert.tablero`.
- Never test against the real cards: no clicks on the board at 4747 and no CLI writes without `TAREAS_DIR`, or you close or move real tasks. Copy the cards to a scratch folder and run a second instance there, e.g. `cp -R ~/tablero/tareas "$SCRATCH/tareas"`, then `TAREAS_DIR="$SCRATCH/tareas" COMIDAS_DIR="$SCRATCH/comidas" TABLERO_PORT=4848 node bin/tablero.mjs` (and the same `TAREAS_DIR` for `bin/tareas.mjs`). To try it on the tablet, add `TABLERO_HOST=0.0.0.0` and a scratch `TABLERO_CLAVE_FILE`, and open `http://<mac-ip>:4848/?clave=<scratch key>&kiosco=1` there.
- For videos, screenshots and UI checks with nothing real on screen, use the demo board instead: `demo/demo.sh datos` (made-up data in `demo/datos/`, ignored by git) and `demo/demo.sh arrancar` (launchd job `io.devexpert.tablero-demo` on port 4949). It shares the real device key, so `demo/demo.sh tablet` opens it on the tablet without re-pairing and `demo/demo.sh volver` puts the real board back. Voice commands there are real and act only on the demo's data.

## Layout

- `src/cards.mjs` — card format, states, columns and all file operations. The CLI and the server go through it; never write card files any other way.
- `src/server.mjs` — HTTP API, static files and server-sent events (`cambio` for cards, `comidas` for meals).
- `src/calendar.mjs` — weeks of events via `oprun gog` for each account: one call brings four weeks (one before, two after), cached in memory; stale weeks (5 min–1 h) are served while refreshed behind, and `onChange` tells the server (SSE `calendario`) when Google changed. Tests inject a fake `run`.
- `src/board.mjs` — what the board shows per card: column (Planificado = open inbox card with a block not over yet), next block and, in the inbox, `src/priority.mjs`'s score and reason.
- `src/blocks.mjs` — work blocks: free events in «Bloques Trabajo» linked to a card by the private property `tarea`. Google is the source of truth.
- `src/devices.mjs` — device key for clients that are not the Mac: pairing link (`/?clave=`) → cookie.
- `src/weather.mjs` — Open-Meteo forecast for the home panel (Madrid by default, `TABLERO_TIEMPO`), cached in memory and on disk; keeps the last good one when the service fails.
- `src/ai-usage.mjs` — Claude and Codex plan limits from CodexBar (`codexbar serve` on 127.0.0.1:8080, falling back to showy-quota's cache). Never read Claude credentials or tokens for this.
- `src/voice-actions.mjs` — what a voice command can change (tasks, meals, work blocks): Claude's JSON schema, the check against current data, the sentence shown for each action and how it is applied.
- `src/voice.mjs` — voice commands: `mlx_whisper` transcribes on the Mac, then the official `claude -p` (the owner's own subscription; Haiku, `--tools ""`, `--safe-mode`, `--json-schema`) turns the text into a plan that the page shows for confirmation; only the server applies it, through `cards.mjs`. Never run it through `oprun` or with `ANTHROPIC_API_KEY` (that would bill the API), never use `--bare` (API key only), and keep it for the subscription's owner alone (the subscription's terms). Tests inject fake `transcribe` and `interpret`.
- `src/meals.mjs` — meal plan: one Markdown file per week in `COMIDAS_DIR` (default `~/tablero/comidas`).
- `public/` — the page (vanilla JS, no build step): `app.js` (rail + panels, version-driven reload), `theme.js` (light/dark per device: a classic script in `<head>` that sets `data-theme` before the first paint; dark styles hang off `:root[data-theme="dark"]`, never `prefers-color-scheme`), `home.js` (+ `weather-icons.js`, `home.css`), `tasks.js`, `calendar.js`, `weeks.js` (weeks shared by calendar and home, prefetch of the neighbours), `voice.js` (mic button and the plan sheet), `blocks.js`, `meals.js`, shared `dom.js` and `drag.js` (pointer-event drag and drop: mouse drags at once, touch after a short hold). `markdown.js` escapes everything before rendering.
- `bin/` — `tareas` (CLI) and `tablero` (server).
- `scripts/` — `instalar-servicio.sh` (LaunchAgent + device key), `tablet-kiosk.sh` (wall tablet over adb), `generar-iconos.py`.
- `demo/` — the demo board: `datos.mjs` (made-up cards, meals and Google around a day), `fake-oprun.mjs` (answers `gog` from `demo/datos/google.json`, writes included), `servidor.mjs` (the demo's environment and a fake CodexBar, then `bin/tablero.mjs`) and `demo.sh` (data, start/stop, tablet).

## Rules

- No runtime dependencies; keep it runnable with plain `node`.
- The card format is a contract with other readers: agents and scripts may parse the flat frontmatter with regexes. Keep keys flat and values on one line.
- User-facing text is Spanish; code and comments are English.
- Keep files under ~500 lines.
- Class names are global across panels: prefix new ones (`home-…`) so they do not collide with another panel's styles.
- No left accent borders (they read as AI slop) and no all-caps labels; tell sections apart by form and colour.
- Touch first: the main screen is an Android tablet. Targets of at least 44px on `pointer: coarse`, nothing that needs hover, swipe as a shortcut only.
- The tablet's Firefox renders in software: its Mali-T GPU renderer is ~3× smoother but draws wrong, even on a flat page (see `scripts/tablet-kiosk.sh`). Painting is the cost: rebuild DOM only when the data changed (calendar, home and board compare before repainting; the calendar's minute tick only moves the "now" line), and keep the page flat: no `opacity` below 1, no `will-change`, transitions or animations (the week swipe changes on release, without following the finger), `filter` only behind `@media (hover: hover)`. Tell states apart by colour and border.
- Test meals against a scratch `COMIDAS_DIR` too, never the real one.
- The scratch instance still writes blocks to the real Google calendar. For UI tests point `TABLERO_OPRUN` at a fake `oprun` that answers `gog` from a local JSON file, such as `demo/fake-oprun.mjs`.
