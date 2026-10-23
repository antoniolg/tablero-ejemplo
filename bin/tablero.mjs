#!/usr/bin/env node
// Starts the board on port 4747 (TABLERO_HOST picks the interface; the LaunchAgent uses 0.0.0.0).
import { createBoardServer } from '../src/server.mjs';
import { tasksDir, today } from '../src/cards.mjs';
import { calendarAccounts, createCalendar } from '../src/calendar.mjs';
import { mealsDir, mondayOf } from '../src/meals.mjs';
import { createBlocks } from '../src/blocks.mjs';
import { keyFile, readKey } from '../src/devices.mjs';
import { createWeather } from '../src/weather.mjs';
import { createAiUsage } from '../src/ai-usage.mjs';
import { createVoice } from '../src/voice.mjs';

const port = Number(process.env.TABLERO_PORT || 4747);
const host = process.env.TABLERO_HOST || '127.0.0.1';
const allowedHosts = (process.env.TABLERO_HOSTS || '')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);
const calendar = process.env.TABLERO_CALENDARIO === '0' || !calendarAccounts().length ? null : createCalendar();
const blocks = calendar && createBlocks({ calendar });
const weather = createWeather();
const aiUsage = createAiUsage();
const voice = process.env.TABLERO_VOZ === '0' ? null : createVoice({ dir: tasksDir(), mealsDir: mealsDir(), calendar, blocks });

// Other devices on the network (the wall tablet) need the key in this file; without it only the Mac gets in.
const deviceKey = readKey();
const board = createBoardServer({ dir: tasksDir(), allowedHosts, mealsDir: mealsDir(), calendar, blocks, deviceKey, weather, aiUsage, voice });
await board.listen(port, host);
console.log(`Tablero en http://${host}:${port} · fichas en ${tasksDir()} · comidas en ${mealsDir()}`
  + ` · calendario ${calendar ? `${calendarAccounts().join(', ')} (bloques en «${blocks.name}»)` : 'desactivado'}`
  + ` · otros dispositivos ${deviceKey ? `con la clave de ${keyFile()}` : 'bloqueados (no hay clave)'}`
  + ` · tiempo de ${weather.place.nombre}`);
// The page reloads itself after every restart: have this week (and its neighbours) ready for it.
calendar?.week(mondayOf(today())).catch(() => {});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    board.stop().finally(() => process.exit(0));
  });
}
