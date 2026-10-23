// Task cards: one Markdown file per task (T-NNN.md) with a flat frontmatter,
// a "## Contexto" section and a "## Bitácora" log. Shared by the CLI and the board.
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DIR = path.join(os.homedir(), 'tablero/tareas');

export const STATES = [
  'bandeja', 'semana', 'en-curso', 'agente', 'tu-ok', 'esperando', 'mas-adelante', 'hecha', 'soltada',
];
export const STATE_LABELS = {
  bandeja: 'Bandeja',
  semana: 'Esta semana',
  'en-curso': 'En curso',
  agente: 'Agente',
  'tu-ok': 'Necesita tu OK',
  esperando: 'Esperando',
  'mas-adelante': 'Más adelante',
  hecha: 'Hecha',
  soltada: 'Soltada',
};
export const COLUMNS = [
  { id: 'bandeja', label: 'Bandeja' },
  { id: 'semana', label: 'Esta semana' },
  { id: 'en-curso', label: 'En curso' },
  { id: 'agente', label: 'Agente' },
  { id: 'tu-ok', label: 'Necesita tu OK' },
  { id: 'esperando', label: 'Esperando' },
  { id: 'cerrado', label: 'Cerrado' },
];
export const CLOSED = new Set(['hecha', 'soltada']);
// Closed cards stay visible on the board this many days; older ones live in the archive view.
export const CLOSED_VISIBLE_DAYS = 14;

const FIELD_ORDER = [
  'id', 'titulo', 'estado', 'responsable', 'siguiente', 'area', 'ambito', 'fecha', 'limite',
  'revisar', 'origen', 'agente', 'evidencia', 'creada', 'actualizada', 'cerrada',
];
// Free text is always written JSON-quoted, which every YAML parser reads back unchanged.
const QUOTED = new Set(['titulo', 'siguiente', 'origen', 'evidencia']);
export const EDITABLE = [
  'titulo', 'responsable', 'siguiente', 'area', 'ambito', 'fecha', 'limite', 'revisar', 'origen', 'evidencia',
];
const MAX_LENGTH = { titulo: 160, siguiente: 400, responsable: 80, area: 40, ambito: 20, origen: 400, evidencia: 400, agente: 40 };
export const MAX_NOTE = 4000;
const DATE_FIELDS = new Set(['fecha', 'revisar']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/;
const TZ = 'Europe/Madrid';

export class CardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function tasksDir() {
  return process.env.TAREAS_DIR || DEFAULT_DIR;
}

// ---------- dates (Europe/Madrid) ----------

function madridParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

export function today(date = new Date()) {
  const p = madridParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function stamp(date = new Date()) {
  const p = madridParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function shortDate(value) {
  const [, m, d] = value.slice(0, 10).split('-');
  return `${d}/${m}`;
}

// ---------- parsing and writing ----------

function parseScalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.replace(/^"|"$/g, '');
    }
  }
  if (v.startsWith("'")) {
    const end = v.length > 1 && v.endsWith("'") ? v.length - 1 : v.length;
    return v.slice(1, end).replace(/''/g, "'");
  }
  return v === '~' || v === 'null' ? '' : v;
}

export function parseCard(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
    if (kv) fields[kv[1]] = parseScalar(kv[2]);
  }
  return { fields, body: text.slice(match[0].length) };
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function formatScalar(key, value) {
  const plain = !QUOTED.has(key)
    && /^[\w.:+/-]+(?: [\w.:+/-]+)?$/.test(value)
    && !value.includes(': ')
    && !value.endsWith(':')
    && !/^(true|false|null|yes|no|on|off)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

export function serializeCard(fields, body) {
  const keys = [
    ...FIELD_ORDER.filter((k) => k in fields),
    ...Object.keys(fields).filter((k) => !FIELD_ORDER.includes(k)),
  ];
  const lines = [];
  for (const key of keys) {
    const value = oneLine(fields[key]);
    if (value) lines.push(`${key}: ${formatScalar(key, value)}`);
  }
  const rest = body.replace(/^\s*\n/, '');
  return `---\n${lines.join('\n')}\n---\n\n${rest.replace(/\s*$/, '')}\n`;
}

export function appendLog(body, entry) {
  const line = `- ${oneLine(entry)}`;
  const trimmed = body.replace(/\s*$/, '');
  if (/^## Bitácora[ \t]*$/m.test(trimmed)) return `${trimmed}\n${line}\n`;
  return `${trimmed}\n\n## Bitácora\n\n${line}\n`;
}

export function versionOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// ---------- the card model ----------

export function normalizeId(input) {
  const m = String(input ?? '').trim().match(/^(?:T-?)?(\d{1,6})$/i);
  if (!m) throw new CardError(`Id de tarea no válido: ${input}`);
  return `T-${m[1].padStart(3, '0')}`;
}

function idNumber(id) {
  return Number(id.slice(2));
}

export function displayName(who) {
  const name = oneLine(who) || 'agente';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function toCard(fields, file) {
  const card = { id: fields.id || path.basename(file, '.md') };
  for (const key of FIELD_ORDER.slice(1)) card[key] = oneLine(fields[key]);
  card.estado ||= 'bandeja';
  return card;
}

export function columnOf(card, day = today()) {
  if (CLOSED.has(card.estado)) {
    const closedOn = card.cerrada || card.actualizada.slice(0, 10);
    return !closedOn || closedOn >= addDays(day, -CLOSED_VISIBLE_DAYS) ? 'cerrado' : 'archivo';
  }
  if (card.estado === 'mas-adelante') {
    return card.revisar && card.revisar.slice(0, 10) <= day ? 'bandeja' : 'mas-adelante';
  }
  return STATES.includes(card.estado) ? card.estado : 'bandeja';
}

export function flagsOf(card, day = today()) {
  const flags = [];
  if (!STATES.includes(card.estado)) flags.push({ tipo: 'estado', texto: `Estado desconocido: ${card.estado}` });
  const review = card.revisar.slice(0, 10);
  if (card.estado === 'mas-adelante' && review && review <= day) {
    flags.push({ tipo: 'vuelve', texto: review === day ? 'Vuelve hoy' : `Tocaba revisarla el ${shortDate(review)}` });
  }
  if (card.estado === 'esperando' && review && review <= day) flags.push({ tipo: 'revisar', texto: 'Toca revisar' });
  if (card.limite && !CLOSED.has(card.estado)) {
    const due = card.limite.slice(0, 10);
    const left = daysBetween(day, due);
    if (left <= 3) {
      const text = left < 0 ? `Venció el ${shortDate(due)}` : left === 0 ? 'Vence hoy' : `Vence el ${shortDate(due)}`;
      flags.push({ tipo: 'limite', texto: text });
    }
  }
  return flags;
}

function cleanValue(key, value) {
  const text = oneLine(value);
  if (text.length > (MAX_LENGTH[key] ?? 200)) throw new CardError(`«${key}» es demasiado largo`);
  if (text && DATE_FIELDS.has(key) && !DATE_RE.test(text)) throw new CardError(`«${key}» debe ser AAAA-MM-DD`);
  if (text && key === 'limite' && !DEADLINE_RE.test(text)) throw new CardError('«limite» debe ser AAAA-MM-DD o AAAA-MM-DD HH:MM');
  if (key === 'ambito' && text && !['pro', 'personal'].includes(text)) throw new CardError('«ambito» debe ser pro o personal');
  return text;
}

export function assertState(estado) {
  if (!STATES.includes(estado)) throw new CardError(`Estado no válido: ${estado}. Usa: ${STATES.join(', ')}`);
}

// ---------- files ----------

async function cardFiles(dir) {
  try {
    return (await readdir(dir)).filter((name) => /^T-\d+\.md$/.test(name));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readCardFile(dir, name) {
  const text = await readFile(path.join(dir, name), 'utf8');
  const { fields, body } = parseCard(text);
  return { ...toCard(fields, name), cuerpo: body, version: versionOf(text) };
}

export async function listCards(dir = tasksDir(), { withBody = false } = {}) {
  const cards = [];
  for (const name of await cardFiles(dir)) {
    const card = await readCardFile(dir, name);
    if (!withBody) delete card.cuerpo;
    cards.push(card);
  }
  return cards.sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

export async function getCard(dir, id) {
  const name = `${normalizeId(id)}.md`;
  try {
    return await readCardFile(dir, name);
  } catch (err) {
    if (err.code === 'ENOENT') throw new CardError(`No existe la tarea ${normalizeId(id)}`, 404);
    throw err;
  }
}

async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await open(tmp, 'w');
    await handle.writeFile(text, 'utf8');
    await handle.close();
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Reads a card, applies `change(fields)` (which returns the log line) and writes it back. */
export async function updateCard(dir, id, change, { who, expectedVersion } = {}) {
  const cardId = normalizeId(id);
  const file = path.join(dir, `${cardId}.md`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new CardError(`No existe la tarea ${cardId}`, 404);
    throw err;
  }
  if (expectedVersion && expectedVersion !== versionOf(text)) {
    throw new CardError('La tarea ha cambiado mientras tanto. Recarga y vuelve a intentarlo.', 409);
  }
  const { fields, body } = parseCard(text);
  const entry = change(fields);
  fields.id ||= cardId;
  fields.actualizada = stamp();
  const nextBody = entry ? appendLog(body, `${stamp()} · ${displayName(who)}: ${entry}`) : body;
  await writeAtomic(file, serializeCard(fields, nextBody));
  return getCard(dir, cardId);
}

export async function createCard(dir, input, { who } = {}) {
  const titulo = cleanValue('titulo', input.titulo);
  if (!titulo) throw new CardError('La tarea necesita un título');
  const estado = input.estado || 'bandeja';
  assertState(estado);
  const fields = { titulo, estado };
  for (const key of EDITABLE) {
    if (key !== 'titulo' && input[key]) fields[key] = cleanValue(key, input[key]);
  }
  fields.responsable ||= estado === 'agente' ? 'agente' : estado === 'esperando' ? '' : 'antonio';
  if (CLOSED.has(estado)) fields.cerrada = today();
  fields.creada = today();
  fields.actualizada = stamp();
  const context = String(input.contexto ?? '').trim();
  let body = `## Contexto\n\n${context}\n`;
  body = appendLog(body, `${stamp()} · ${displayName(who)}: ${input.nota ? oneLine(input.nota) : `creada en ${STATE_LABELS[estado]}`}`);

  await mkdir(dir, { recursive: true });
  const taken = (await cardFiles(dir)).map((name) => idNumber(name.slice(0, -3)));
  let next = Math.max(0, ...taken) + 1;
  for (let attempt = 0; attempt < 20; attempt += 1, next += 1) {
    const id = `T-${String(next).padStart(3, '0')}`;
    try {
      // 'wx' fails if another writer took this id first.
      const handle = await open(path.join(dir, `${id}.md`), 'wx');
      await handle.writeFile(serializeCard({ id, ...fields }, body), 'utf8');
      await handle.close();
      return getCard(dir, id);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new CardError('No he podido reservar un id libre', 500);
}

export async function moveCard(dir, id, estado, opts = {}) {
  assertState(estado);
  const { note, revisar, responsable, evidencia } = opts;
  return updateCard(dir, id, (fields) => {
    const from = fields.estado || 'bandeja';
    fields.estado = estado;
    fields.cerrada = CLOSED.has(estado) ? today() : '';
    if (responsable !== undefined) fields.responsable = cleanValue('responsable', responsable);
    else if (estado === 'agente') fields.responsable = 'agente';
    else if (['bandeja', 'semana', 'en-curso', 'tu-ok'].includes(estado)) fields.responsable = 'antonio';
    if (revisar !== undefined) fields.revisar = cleanValue('revisar', revisar);
    else if (!['esperando', 'mas-adelante'].includes(estado)) fields.revisar = '';
    if (evidencia !== undefined) fields.evidencia = cleanValue('evidencia', evidencia);
    if (opts.agente !== undefined) fields.agente = cleanValue('agente', opts.agente);
    const move = from === estado ? STATE_LABELS[estado] : `${STATE_LABELS[from] ?? from} → ${STATE_LABELS[estado]}`;
    return note ? `${move}. ${oneLine(note)}` : move;
  }, opts);
}

export async function editCard(dir, id, changes, opts = {}) {
  const keys = Object.keys(changes).filter((key) => changes[key] !== undefined);
  const unknown = keys.filter((key) => !EDITABLE.includes(key));
  if (unknown.length) throw new CardError(`No se puede editar: ${unknown.join(', ')}`);
  if (!keys.length) throw new CardError('No hay cambios');
  const clean = Object.fromEntries(keys.map((key) => [key, cleanValue(key, changes[key])]));
  if ('titulo' in clean && !clean.titulo) throw new CardError('La tarea necesita un título');
  return updateCard(dir, id, (fields) => {
    const changed = keys.filter((key) => oneLine(fields[key]) !== clean[key]);
    Object.assign(fields, clean);
    if (!changed.length) return '';
    return opts.note ? `Edita ${changed.join(', ')}. ${oneLine(opts.note)}` : `Edita ${changed.join(', ')}`;
  }, opts);
}

export async function addNote(dir, id, text, opts = {}) {
  const note = oneLine(text);
  if (!note) throw new CardError('La nota está vacía');
  if (note.length > MAX_NOTE) throw new CardError('La nota es demasiado larga');
  return updateCard(dir, id, () => note, opts);
}

export function summaryMarkdown(cards, day = today()) {
  const groups = new Map([...COLUMNS.map((c) => [c.id, []]), ['mas-adelante', []]]);
  for (const card of cards) groups.get(columnOf(card, day))?.push(card);
  const line = (card) => {
    const bits = [`${card.id} · ${card.titulo}`];
    if (card.siguiente && !CLOSED.has(card.estado)) bits.push(`siguiente: ${card.siguiente}`);
    if (card.responsable && !['antonio', 'agente'].includes(card.responsable)) bits.push(`espera a ${card.responsable}`);
    if (card.agente && card.estado === 'agente') bits.push(`la lleva ${displayName(card.agente)}`);
    if (card.fecha) bits.push(`plan ${shortDate(card.fecha)}`);
    if (card.limite) bits.push(`límite ${card.limite}`);
    if (card.revisar && !CLOSED.has(card.estado)) bits.push(`revisar ${shortDate(card.revisar)}`);
    if (CLOSED.has(card.estado)) bits.push(`${STATE_LABELS[card.estado].toLowerCase()} ${card.cerrada ? shortDate(card.cerrada) : ''}`.trim());
    for (const flag of flagsOf(card, day)) bits.push(`⚠ ${flag.texto}`);
    return `- ${bits.join(' · ')}`;
  };
  const out = [`# Tablero · ${shortDate(day)}/${day.slice(0, 4)}`];
  const sections = [...COLUMNS.filter((c) => c.id !== 'cerrado'), { id: 'mas-adelante', label: 'Más adelante' },
    { id: 'cerrado', label: `Cerrado (últimos ${CLOSED_VISIBLE_DAYS} días)` }];
  for (const { id, label } of sections) {
    const list = groups.get(id);
    out.push('', `## ${label} (${list.length})`);
    out.push(...(list.length ? list.map(line) : ['- (vacía)']));
  }
  return `${out.join('\n')}\n`;
}
