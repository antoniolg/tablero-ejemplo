#!/usr/bin/env node
// The demo board: bin/tablero.mjs on made-up data (demo/datos, from datos.mjs) at port 4949, open to
// the house Wi-Fi with the real board's device key, so the paired tablet needs nothing else. Google is
// fake-oprun.mjs, the Claude and Codex limits come from the fake CodexBar below, the weather is Madrid's
// and voice commands are the real ones (Whisper and claude -p) over the demo's cards, meals and blocks.
// Start it with demo/demo.sh arrancar: launchd gives it a clean environment, like the real service.
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'datos');
if (!existsSync(path.join(DATA, 'google.json'))) throw new Error('No hay datos de la demo: ejecuta demo/demo.sh datos');
const CODEXBAR_PORT = Number(process.env.DEMO_CODEXBAR_PORT || 4950);

Object.assign(process.env, {
  TAREAS_DIR: path.join(DATA, 'tareas'),
  COMIDAS_DIR: path.join(DATA, 'comidas'),
  TABLERO_PORT: process.env.TABLERO_PORT || '4949',
  TABLERO_HOST: '0.0.0.0',
  TABLERO_OPRUN: path.join(HERE, 'fake-oprun.mjs'),
  TABLERO_CUENTAS: 'demo@ejemplo.com',
  TABLERO_FONDO: 'Turno de Marta',
  TABLERO_TIEMPO: 'Madrid|40.4168|-3.7038',
  TABLERO_TIEMPO_CACHE: path.join(DATA, 'tiempo.json'),
  TABLERO_CODEXBAR_URL: `http://127.0.0.1:${CODEXBAR_PORT}/usage`,
  TABLERO_CODEXBAR_CACHE: path.join(DATA, 'sin-cache.json'),
  // fake-oprun.mjs starts with `env node`: make it find this same node.
  PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(':'),
});

/**
 * CodexBar's payload, made up from the clock so it never goes stale: Claude a bit ahead of the even
 * pace (the ring passes its mark; in the session's last hour it stops at 85%), Codex behind it.
 * Five-hour windows from midnight; the week always resets in three days at 15:00, so whenever you
 * record it is about half gone.
 */
function usage(now = Date.now()) {
  const HOUR = 3_600_000;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const session = midnight + (Math.floor((now - midnight) / (5 * HOUR)) + 1) * 5 * HOUR;
  const week = new Date(now);
  week.setDate(week.getDate() + 3);
  week.setHours(15, 0, 0, 0);
  const pct = (x) => Math.max(2, Math.min(97, Math.round(x)));
  const sessionPace = 100 * (1 - (session - now) / (5 * HOUR));
  const weekPace = pct(100 * (1 - (week.getTime() - now) / (168 * HOUR)));
  const updatedAt = new Date(now).toISOString();
  const provider = (id, plan, sessionUsed, weekDelta) => {
    const weekUsed = pct(weekPace + weekDelta);
    const left = weekUsed > weekPace ? ((100 - weekUsed) / weekUsed) * (now - (week.getTime() - 168 * HOUR)) / 1000 : null;
    return {
      provider: id,
      usage: {
        loginMethod: plan, updatedAt,
        primary: { usedPercent: pct(sessionUsed), resetsAt: new Date(session).toISOString(), windowMinutes: 300 },
        secondary: { usedPercent: weekUsed, resetsAt: week.toISOString(), windowMinutes: 10080 },
      },
      pace: { secondary: { expectedUsedPercent: weekPace, deltaPercent: weekUsed - weekPace,
        willLastToReset: weekUsed <= weekPace, ...(left ? { etaSeconds: Math.max(3600, Math.round(left)) } : {}) } },
    };
  };
  return [provider('claude', 'Claude Max 5x', Math.min(sessionPace + 12, 85), 9), provider('codex', 'plus', sessionPace - 18, -7)];
}

const codexbar = http.createServer((req, res) => {
  if (req.url !== '/usage') {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(usage()));
});
await new Promise((resolve, reject) => codexbar.once('error', reject).listen(CODEXBAR_PORT, '127.0.0.1', resolve));

await import('../bin/tablero.mjs');
