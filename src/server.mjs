// HTTP server for the board: static UI, a small JSON API over the card files and
// server-sent events so the page refreshes when an agent changes a card.
import http from 'node:http';
import { watch } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CLOSED_VISIBLE_DAYS, CardError, EDITABLE, STATES, STATE_LABELS, addNote, createCard,
  editCard, getCard, listCards, moveCard, today,
} from './cards.mjs';
import { blockTimes, planCardOn } from './blocks.mjs';
import { MAX_AUDIO } from './voice.mjs';
import { BOARD_COLUMNS, boardView } from './board.mjs';
import { deviceAccess, isLoopback, pairingResponse } from './devices.mjs';
import { mealsDir as defaultMealsDir, mondayOf, readWeek, recentDishes, setMeals, swapMeals } from './meals.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  ...Object.fromEntries(['app.js', 'dom.js', 'tasks.js', 'calendar.js', 'weeks.js', 'swipe.js', 'theme.js', 'voice.js', 'blocks.js', 'meals.js', 'drag.js', 'home.js', 'weather-icons.js', 'markdown.js']
    .map((file) => [`/${file}`, [file, 'text/javascript; charset=utf-8']])),
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/panels.css': ['panels.css', 'text/css; charset=utf-8'],
  '/home.css': ['home.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};
const MAX_BODY = 64 * 1024;
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
  + "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const WHO = 'antonio';

// Private IPv4 literals (home network, Tailscale's 100.64/10). A DNS-rebinding page always sends its
// own domain name as Host, never an IP literal, so these are as safe as loopback here.
const PRIVATE_IPV4 = /^(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d+\.\d+$/;

/** Only loopback, tailnet names and private IPs: blocks DNS rebinding from arbitrary sites. */
export function hostAllowed(hostHeader, extra = []) {
  if (!hostHeader) return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return ['localhost', '127.0.0.1', '::1'].includes(hostname) || hostname.endsWith('.ts.net')
    || PRIVATE_IPV4.test(hostname) || extra.includes(hostname);
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new CardError('Se esperaba JSON', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new CardError('Petición demasiado grande', 413);
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new CardError('JSON no válido');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CardError('JSON no válido');
  return value;
}

/** The raw body (the audio of a voice command), up to `limit` bytes. */
async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new CardError('El audio es demasiado largo', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const text = (value) => (value === undefined ? undefined : value === null ? '' : String(value));


export function createBoardServer({
  dir, allowedHosts = [], mealsDir = defaultMealsDir(), calendar = null, blocks = null, deviceKey = '',
  weather = null, aiUsage = null, voice = null,
  trusted = (req) => isLoopback(req.socket.remoteAddress),
}) {
  const clients = new Set();
  const watchers = [];
  const pending = {};
  let ping;

  // `cambio` is a card change, `comidas` a change to the meal plan, `calendario` a block written from
  // here or a week that changed in Google since it was served.
  function broadcast(event) {
    clearTimeout(pending[event]);
    pending[event] = setTimeout(() => {
      for (const res of clients) res.write(`event: ${event}\ndata: {}\n\n`);
    }, 150);
  }
  const stopListening = calendar?.onChange?.(() => broadcast('calendario')) ?? (() => {});

  function checkMutation(req) {
    if (req.headers['x-tablero'] !== '1') throw new CardError('Falta la cabecera X-Tablero', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new CardError('Origen no permitido', 403);
    const { origin } = req.headers;
    if (!origin) return;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new CardError('Origen no permitido', 403);
    }
    // Writes only come from the board's own page: same host and port as the request.
    if (host.toLowerCase() !== String(req.headers.host).toLowerCase()) throw new CardError('Origen no permitido', 403);
  }

  // Work blocks per task, for the Planificado column. The board waits for it (it is cached);
  // single-card answers use whatever is cached. Without Google the board still works.
  let lastPlans = new Map();
  let planWarning = '';
  async function plans(day) {
    if (!blocks) return lastPlans;
    try {
      lastPlans = await blocks.index(day);
      planWarning = '';
    } catch (err) {
      planWarning = `No he podido leer los bloques de trabajo: ${err.message}`;
    }
    return lastPlans;
  }
  const withView = (card, day) => boardView(card, day, lastPlans.get(card.id));

  async function api(req, res, url) {
    const day = today();
    if (req.method !== 'GET') checkMutation(req);
    if (req.method === 'GET' && url.pathname === '/api/tablero') {
      const all = url.searchParams.get('todo') === '1';
      const byTask = await plans(day);
      const cards = (await listCards(dir)).map((card) => boardView(card, day, byTask.get(card.id)))
        .filter((c) => all || c.columna !== 'archivo');
      return send(res, 200, {
        hoy: day,
        columnas: BOARD_COLUMNS,
        aviso: planWarning,
        estados: STATES.map((id) => ({ id, label: STATE_LABELS[id] })),
        diasCerradas: CLOSED_VISIBLE_DAYS,
        tareas: cards,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/tareas') {
      const body = await readJson(req);
      const card = await createCard(dir, { titulo: text(body.titulo), siguiente: text(body.siguiente), estado: text(body.estado) }, { who: WHO });
      return send(res, 201, withView(card, day));
    }
    if (url.pathname.startsWith('/api/bloques')) return workBlocks(req, res, url, day);
    if (url.pathname.startsWith('/api/calendario') || url.pathname.startsWith('/api/comidas')) return dashboard(req, res, url, day);
    // Home panel extras: weather (Open-Meteo) and the AI plan limits (CodexBar), both cached.
    if (req.method === 'GET' && url.pathname === '/api/tiempo') {
      if (!weather) throw new CardError('El tiempo no está configurado', 503);
      return send(res, 200, await weather.get());
    }
    if (req.method === 'GET' && url.pathname === '/api/ia') {
      return send(res, 200, aiUsage ? await aiUsage.get() : { disponible: false });
    }
    // Voice commands: audio → a plan to confirm; the confirmed plan → applied here, never by Claude.
    if (req.method === 'POST' && url.pathname.startsWith('/api/voz')) {
      if (!voice) throw new CardError('Los comandos de voz no están configurados', 503);
      if (url.pathname === '/api/voz') {
        const type = String(req.headers['content-type'] || '');
        if (!type.startsWith('audio/')) throw new CardError('Se esperaba audio', 415);
        return send(res, 200, await voice.plan(await readRaw(req, MAX_AUDIO), type));
      }
      if (url.pathname === '/api/voz/aplicar') {
        const result = await voice.apply((await readJson(req)).plan);
        if (result.calendario) broadcast('calendario');
        return send(res, 200, result);
      }
    }
    const match = url.pathname.match(/^\/api\/tareas\/([^/]+)(?:\/(mover|nota))?$/);
    if (!match) throw new CardError('No encontrado', 404);
    const [, id, action] = match;
    if (req.method === 'GET' && !action) return send(res, 200, withView(await getCard(dir, id), day));
    if (req.method === 'POST' && action === 'mover') {
      const body = await readJson(req);
      const card = await moveCard(dir, id, text(body.estado), {
        note: text(body.nota), revisar: text(body.revisar), responsable: text(body.responsable),
        evidencia: text(body.evidencia), expectedVersion: text(body.version), who: WHO,
      });
      return send(res, 200, withView(card, day));
    }
    if (req.method === 'POST' && action === 'nota') {
      const body = await readJson(req);
      return send(res, 200, withView(await addNote(dir, id, text(body.texto), { who: WHO }), day));
    }
    if (req.method === 'PATCH' && !action) {
      const body = await readJson(req);
      const changes = Object.fromEntries(EDITABLE.filter((k) => body[k] !== undefined).map((k) => [k, text(body[k])]));
      const card = await editCard(dir, id, changes, { expectedVersion: text(body.version), who: WHO });
      return send(res, 200, withView(card, day));
    }
    throw new CardError('Método no permitido', 405);
  }

  async function dashboard(req, res, url, day) {
    if (req.method === 'GET' && url.pathname === '/api/calendario') {
      if (!calendar) throw new CardError('El calendario no está configurado', 503);
      const desde = url.searchParams.get('desde') || day;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || Number.isNaN(Date.parse(desde))) throw new CardError('Fecha no válida (AAAA-MM-DD)');
      const refresh = url.searchParams.get('refrescar') === '1';
      if (refresh) blocks?.invalidate();
      return send(res, 200, await calendar.week(mondayOf(desde), { refresh }));
    }
    if (req.method === 'GET' && url.pathname === '/api/comidas') {
      const week = await readWeek(mealsDir, url.searchParams.get('desde') || day);
      return send(res, 200, { hoy: day, ...week, recientes: await recentDishes(mealsDir) });
    }
    if (req.method === 'POST' && url.pathname === '/api/comidas/mover') {
      const body = await readJson(req);
      const point = (value) => ({ fecha: text(value?.fecha), hueco: text(value?.hueco) });
      const week = await swapMeals(mealsDir, point(body.de), point(body.a));
      return send(res, 200, { hoy: day, ...week, recientes: await recentDishes(mealsDir) });
    }
    const match = url.pathname.match(/^\/api\/comidas\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === 'PATCH' && match) {
      const body = await readJson(req);
      const week = await setMeals(mealsDir, match[1], { comida: text(body.comida), cena: text(body.cena) });
      return send(res, 200, { hoy: day, ...week, recientes: await recentDishes(mealsDir) });
    }
    throw new CardError(match ? 'Método no permitido' : 'No encontrado', match ? 405 : 404);
  }

  const planOn = (tarea, inicio) => planCardOn(dir, tarea, inicio, { who: WHO });

  // A block for something that is not on the board yet creates its card first, in the inbox:
  // its block is what makes it show as planned.
  async function newCardFor(titulo, inicio, fin) {
    blockTimes(inicio, fin);
    const blockDay = today(new Date(inicio));
    return createCard(dir, { titulo, estado: 'bandeja', fecha: blockDay, nota: `creada desde el calendario con un bloque el ${blockDay}` }, { who: WHO });
  }

  async function workBlocks(req, res, url, day) {
    if (!blocks) throw new CardError('Los bloques de trabajo no están configurados', 503);
    if (req.method === 'GET' && url.pathname === '/api/bloques') {
      return send(res, 200, { calendario: blocks.name, bloques: await blocks.forTask(url.searchParams.get('tarea'), day) });
    }
    if (req.method === 'POST' && url.pathname === '/api/bloques') {
      const body = await readJson(req);
      const card = text(body.nueva) ? await newCardFor(text(body.nueva), text(body.inicio), text(body.fin)) : await getCard(dir, text(body.tarea));
      const block = await blocks.create({ tarea: card.id, titulo: card.titulo, inicio: text(body.inicio), fin: text(body.fin) });
      await planOn(card.id, block.inicio);
      broadcast('calendario');
      return send(res, 201, block);
    }
    const match = url.pathname.match(/^\/api\/bloques\/([^/]+)$/);
    if (!match) throw new CardError('No encontrado', 404);
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const tarea = text(body.tarea);
      const titulo = tarea ? (await getCard(dir, tarea)).titulo : undefined;
      const block = await blocks.update(match[1], { inicio: text(body.inicio), fin: text(body.fin), titulo });
      await planOn(block.tarea, block.inicio);
      broadcast('calendario');
      return send(res, 200, block);
    }
    if (req.method === 'DELETE') {
      await blocks.remove(match[1]);
      broadcast('calendario');
      return send(res, 200, { ok: true });
    }
    throw new CardError('Método no permitido', 405);
  }

  // Open pages reload themselves when the page's files change or the server restarts, so the wall
  // tablet never keeps running an old version.
  const bootId = Date.now().toString(36);
  let assetsVersion = bootId;
  async function refreshVersion() {
    const stats = await Promise.all(Object.values(STATIC).map(([file]) => stat(path.join(PUBLIC_DIR, file)).catch(() => null)));
    const newest = Math.max(0, ...stats.filter(Boolean).map((s) => Math.floor(s.mtimeMs)));
    assetsVersion = `${bootId}.${newest.toString(36)}`;
  }
  function announceVersion(res) {
    res.write(`event: version\ndata: ${JSON.stringify({ v: assetsVersion })}\n\n`);
  }

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host, allowedHosts)) return send(res, 403, { error: 'Host no permitido' });
    const url = new URL(req.url, 'http://tablero.local');
    if (!trusted(req)) {
      const access = deviceAccess(req, url, deviceKey);
      if (access === 'pair') return pairingResponse(res, url, deviceKey, BASE_HEADERS);
      if (access === 'deny') {
        if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Este dispositivo no está autorizado' });
        res.writeHead(401, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Este dispositivo no está autorizado. Ábrelo con el enlace de emparejamiento: scripts/tablet-kiosk.sh enlace\n');
      }
    }
    const asset = req.method === 'GET' && STATIC[url.pathname];
    if (asset) {
      const [file, type] = asset;
      const body = await readFile(path.join(PUBLIC_DIR, file));
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Security-Policy': CSP });
      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/api/eventos') {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      announceVersion(res);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
    return send(res, 404, { error: 'No encontrado' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof CardError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Error interno' });
    });
  });

  return {
    server,
    async listen(port, host) {
      await mkdir(dir, { recursive: true });
      await mkdir(mealsDir, { recursive: true });
      watchers.push(watch(dir, { persistent: false }, () => broadcast('cambio')));
      watchers.push(watch(mealsDir, { persistent: false }, () => broadcast('comidas')));
      await refreshVersion();
      watchers.push(watch(PUBLIC_DIR, { persistent: false }, () => {
        clearTimeout(pending.version);
        pending.version = setTimeout(async () => {
          await refreshVersion();
          for (const res of clients) announceVersion(res);
        }, 300);
      }));
      ping = setInterval(() => {
        // A heartbeat the page can see (comments cannot be): it reconnects when these stop.
        for (const res of clients) res.write('event: latido\ndata: {}\n\n');
      }, 25_000);
      ping.unref();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    async stop() {
      stopListening();
      for (const watcher of watchers.splice(0)) watcher.close();
      clearInterval(ping);
      for (const timer of Object.values(pending)) clearTimeout(timer);
      for (const res of clients) res.end();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
