import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addNote, createCard } from '../src/cards.mjs';
import { createBoardServer, hostAllowed } from '../src/server.mjs';

let dir;
let mealsDir;
let blockTask;
let plannedIndex = new Map();
let calendarChanged = null;
let board;
let base;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tablero-server-'));
  mealsDir = await mkdtemp(path.join(os.tmpdir(), 'tablero-server-comidas-'));
  const calendar = {
    async week(monday) {
      return { desde: monday, calendarios: [], eventos: [{ titulo: 'Clase', inicio: `${monday}T19:00:00+02:00` }], errores: [] };
    },
    onChange(listener) {
      calendarChanged = listener;
      return () => { calendarChanged = null; };
    },
  };
  const blocks = {
    name: 'Bloques Trabajo',
    async create({ tarea, titulo, inicio, fin }) {
      return { id: 'cal/abc123', tarea, titulo, inicio, fin, libre: true };
    },
    async update(id, { inicio, fin }) {
      return { id: `cal/${id}`, tarea: blockTask, inicio, fin };
    },
    async remove() {},
    async forTask(tarea) {
      return [{ id: 'cal/abc123', tarea }];
    },
    async index() {
      return plannedIndex;
    },
    invalidate() {},
  };
  const weather = { async get() { return { lugar: 'Madrid', actual: { temperatura: 18 } }; } };
  const aiUsage = { async get() { return { disponible: true, fuente: 'codexbar', proveedores: [{ id: 'claude' }] }; } };
  board = createBoardServer({ dir, mealsDir, calendar, blocks, weather, aiUsage });
  const { port } = await board.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

after(() => board.stop());

const json = (body) => ({ 'Content-Type': 'application/json', 'X-Tablero': '1', body: JSON.stringify(body) });
async function call(method, route, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    const { body: payload, ...rest } = json(body);
    Object.assign(init.headers, rest);
    init.body = payload;
  }
  const res = await fetch(base + route, init);
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}

function rawGet(route, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('hostAllowed accepts loopback and tailnet names only', () => {
  assert.equal(hostAllowed('127.0.0.1:4747'), true);
  assert.equal(hostAllowed('[::1]:4747'), true);
  assert.equal(hostAllowed('mac.tail1234.ts.net'), true);
  assert.equal(hostAllowed('evil.example'), false);
  assert.equal(hostAllowed('evil.example', ['evil.example']), true);
  assert.equal(hostAllowed(undefined), false);
});

test('serves the page with a strict CSP and rejects foreign Host headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await res.text(), /<title>Tablero<\/title>/);
  assert.equal(await rawGet('/api/tablero', 'rebinding.example:4747'), 403);
});

test('serves the web app manifest and icons for "Add to Dock"', async () => {
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
  const { name, display, icons } = await manifest.json();
  assert.equal(name, 'Tablero');
  assert.equal(display, 'standalone');
  for (const { src } of icons) {
    const icon = await fetch(base + src);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  }
});

test('lists cards with their column and flags', async () => {
  await createCard(dir, { titulo: 'Vuelve hoy', estado: 'mas-adelante', revisar: '2020-01-01' });
  const { status, data } = await call('GET', '/api/tablero');
  assert.equal(status, 200);
  const card = data.tareas.find((t) => t.titulo === 'Vuelve hoy');
  assert.equal(card.columna, 'bandeja');
  assert.equal(card.avisos[0].tipo, 'vuelve');
  assert.ok(data.columnas.some((c) => c.id === 'tu-ok'));
});

test('writes need the X-Tablero header and an allowed Origin', async () => {
  const noHeader = await fetch(`${base}/api/tareas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"titulo":"x"}',
  });
  assert.equal(noHeader.status, 403);
  const foreign = await call('POST', '/api/tareas', { titulo: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  // Another allowed host is still another origin: writes must come from the board's own page.
  const otherPort = await call('POST', '/api/tareas', { titulo: 'x' }, { Origin: 'http://127.0.0.1:1' });
  assert.equal(otherPort.status, 403);
  const own = await call('POST', '/api/tareas', { titulo: 'Mismo origen' }, { Origin: base });
  assert.equal(own.status, 201);
  const plainText = await fetch(`${base}/api/tareas`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Tablero': '1' }, body: '{"titulo":"x"}',
  });
  assert.equal(plainText.status, 415);
});

test('create, move, edit and note through the API', async () => {
  const created = await call('POST', '/api/tareas', { titulo: 'Desde el tablero', siguiente: 'Probarlo' });
  assert.equal(created.status, 201);
  const { id, version } = created.data;
  const moved = await call('POST', `/api/tareas/${id}/mover`, { estado: 'esperando', responsable: 'Borja', revisar: '2026-10-23', version });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.responsable, 'Borja');
  const edited = await call('PATCH', `/api/tareas/${id}`, { siguiente: 'Escribirle', version: moved.data.version });
  assert.equal(edited.data.siguiente, 'Escribirle');
  const noted = await call('POST', `/api/tareas/${id}/nota`, { texto: 'Hazte cargo tú' });
  assert.equal(noted.status, 200);
  const text = await readFile(path.join(dir, `${id}.md`), 'utf8');
  assert.match(text, /· Antonio: Bandeja → Esperando/);
  assert.match(text, /· Antonio: Edita siguiente/);
  assert.match(text, /· Antonio: Hazte cargo tú/);
});

test('a move based on a stale version gets 409', async () => {
  const card = await createCard(dir, { titulo: 'Conflicto' });
  await addNote(dir, card.id, 'un agente la toca', { who: 'codex' });
  const res = await call('POST', `/api/tareas/${card.id}/mover`, { estado: 'semana', version: card.version });
  assert.equal(res.status, 409);
});

test('bad input returns readable errors', async () => {
  assert.equal((await call('POST', '/api/tareas/T-999/mover', { estado: 'semana' })).status, 404);
  assert.equal((await call('POST', '/api/tareas/../../etc/mover', { estado: 'semana' })).status, 404);
  const badState = await call('POST', '/api/tareas', { titulo: 'x', estado: 'quizá' });
  assert.equal(badState.status, 400);
  assert.match(badState.data.error, /Estado no válido/);
});

/** Opens the event stream, runs `trigger` and collects what arrives until `expected` shows up. */
async function streamUntil(expected, trigger) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/eventos`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // retry header
  await trigger();
  let received = '';
  const deadline = Date.now() + 3000;
  while (!received.includes(expected) && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 500)),
    ]);
    if (done) break;
    if (value) received += decoder.decode(value);
  }
  controller.abort();
  return received;
}

test('changes to the card files are pushed as server-sent events', async () => {
  const received = await streamUntil('event: cambio', () => createCard(dir, { titulo: 'Evento' }));
  assert.match(received, /event: cambio/);
});

test('a week that changed in Google is announced to every screen', async () => {
  const received = await streamUntil('event: calendario', () => calendarChanged(['2026-10-19']));
  assert.match(received, /event: calendario/);
});

test('serves every panel script and stylesheet', async () => {
  for (const file of ['app.js', 'dom.js', 'tasks.js', 'calendar.js', 'weeks.js', 'swipe.js', 'theme.js', 'voice.js', 'blocks.js', 'meals.js', 'drag.js', 'home.js', 'weather-icons.js', 'panels.css', 'home.css']) {
    assert.equal((await fetch(`${base}/${file}`)).status, 200, file);
  }
});

test('the calendar is asked for the Monday of the requested day', async () => {
  const { status, data } = await call('GET', '/api/calendario?desde=2026-10-22');
  assert.equal(status, 200);
  assert.equal(data.desde, '2026-10-19');
  assert.equal((await call('GET', '/api/calendario?desde=mañana')).status, 400);
});

test('meals are read and written through the API', async () => {
  const empty = await call('GET', '/api/comidas?desde=2026-10-21');
  assert.equal(empty.data.semana, '2026-10-19');
  assert.equal(empty.data.dias.length, 5);
  assert.equal(empty.data.dias.at(-1).fecha, '2026-10-23');
  const saved = await call('PATCH', '/api/comidas/2026-10-21', { comida: 'Lentejas' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.dias[2].comida, 'Lentejas');
  assert.deepEqual(saved.data.recientes, ['Lentejas']);
  assert.match(await readFile(path.join(mealsDir, '2026-10-19.md'), 'utf8'), /- Comida: Lentejas/);
  const noHeader = await fetch(`${base}/api/comidas/2026-10-21`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"comida":"x"}',
  });
  assert.equal(noHeader.status, 403);
  assert.equal((await call('PATCH', '/api/comidas/2026-10-99', { comida: 'x' })).status, 400);
  const swapped = await call('POST', '/api/comidas/mover', { de: { fecha: '2026-10-21', hueco: 'comida' }, a: { fecha: '2026-10-22', hueco: 'cena' } });
  assert.equal(swapped.status, 200);
  assert.equal(swapped.data.dias[3].cena, 'Lentejas');
  assert.equal(swapped.data.dias[2].comida, '');
});

test('without a calendar the endpoint says so', async () => {
  const bare = createBoardServer({ dir, mealsDir });
  const { port } = await bare.listen(0, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${port}/api/calendario`);
  assert.equal(res.status, 503);
  await bare.stop();
});

test('work blocks plan the card for the block day', async () => {
  const card = await createCard(dir, { titulo: 'Bloque', estado: 'semana' });
  blockTask = card.id;
  const created = await call('POST', '/api/bloques', { tarea: card.id, inicio: '2026-10-21T10:00:00+02:00', fin: '2026-10-21T11:00:00+02:00' });
  assert.equal(created.status, 201);
  assert.equal(created.data.titulo, 'Bloque');
  assert.equal((await call('GET', `/api/tareas/${card.id}`)).data.fecha, '2026-10-21');
  const moved = await call('PATCH', '/api/bloques/abc123', { inicio: '2026-10-22T23:30:00+02:00', fin: '2026-10-23T00:30:00+02:00' });
  assert.equal(moved.status, 200);
  assert.equal((await call('GET', `/api/tareas/${card.id}`)).data.fecha, '2026-10-22');
  assert.equal((await call('GET', `/api/bloques?tarea=${card.id}`)).data.bloques.length, 1);
  assert.equal((await call('DELETE', '/api/bloques/abc123', undefined, { 'X-Tablero': '1' })).status, 200);
  assert.equal((await fetch(`${base}/api/bloques/abc123`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('POST', '/api/bloques', { tarea: 'T-999', inicio: 'x', fin: 'y' })).status, 404);
});

test('a block for something new creates its card first', async () => {
  const thisWeek = new Date();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(thisWeek);
  const created = await call('POST', '/api/bloques', { nueva: 'Preparar la charla', inicio: `${day}T23:00:00+02:00`, fin: `${day}T23:30:00+02:00` });
  assert.equal(created.status, 201);
  const card = (await call('GET', '/api/tablero')).data.tareas.find((t) => t.titulo === 'Preparar la charla');
  assert.equal(card.estado, 'bandeja');
  assert.equal(created.data.tarea, card.id);
  const later = await call('POST', '/api/bloques', { nueva: 'Algo lejano', inicio: '2030-01-07T10:00:00+01:00', fin: '2030-01-07T11:00:00+01:00' });
  const far = (await call('GET', `/api/tareas/${later.data.tarea}`)).data;
  assert.equal(far.estado, 'bandeja');
  assert.equal(far.fecha, '2030-01-07');
  const before = (await call('GET', '/api/tablero')).data.tareas.length;
  assert.equal((await call('POST', '/api/bloques', { nueva: 'Mal', inicio: 'mañana', fin: 'luego' })).status, 400);
  assert.equal((await call('GET', '/api/tablero')).data.tareas.length, before);
});

test('the board puts cards with an upcoming block in Planificado and orders the inbox', async () => {
  const planned = await createCard(dir, { titulo: 'Con bloque', estado: 'semana' });
  const urgent = await createCard(dir, { titulo: 'Urgente', limite: '2020-01-01' });
  const parked = await createCard(dir, { titulo: 'Aparcada', estado: 'mas-adelante', revisar: '2099-01-01' });
  plannedIndex = new Map([[planned.id, { proximo: { inicio: '2099-01-01T10:00:00+01:00', fin: '2099-01-01T11:00:00+01:00' } }]]);
  const { data } = await call('GET', '/api/tablero');
  assert.deepEqual(data.columnas.map((c) => c.id), ['bandeja', 'planificado', 'en-curso', 'agente', 'tu-ok', 'esperando']);
  const byTitle = (titulo) => data.tareas.find((t) => t.titulo === titulo);
  assert.equal(byTitle('Con bloque').columna, 'planificado');
  assert.equal(byTitle('Con bloque').bloque.inicio, '2099-01-01T10:00:00+01:00');
  assert.equal(byTitle('Aparcada').columna, 'bandeja');
  assert.ok(byTitle('Urgente').prioridad.puntos > byTitle('Aparcada').prioridad.puntos);
  assert.match(byTitle('Urgente').prioridad.motivo, /Venció/);
  plannedIndex = new Map();
  assert.equal((await call('GET', `/api/tareas/${urgent.id}`)).data.columna, 'bandeja');
  assert.equal((await call('GET', `/api/tareas/${parked.id}`)).data.prioridad.motivo, 'Para más adelante (01/01)');
});

test('the home panel gets the weather and the AI plan limits', async () => {
  const weather = await call('GET', '/api/tiempo');
  assert.equal(weather.status, 200);
  assert.equal(weather.data.actual.temperatura, 18);
  const usage = await call('GET', '/api/ia');
  assert.equal(usage.data.proveedores[0].id, 'claude');
});

test('the event stream announces the page version first', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/eventos`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const deadline = Date.now() + 2000;
  while (!received.includes('event: version') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
  }
  controller.abort();
  assert.match(received, /event: version\ndata: \{"v":"[a-z0-9]+\.[a-z0-9]+"\}/);
});
