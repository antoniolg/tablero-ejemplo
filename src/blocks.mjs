// Work blocks: time reserved for a task, kept as "free" events in one Google calendar so they never
// block anyone booking a meeting. Google is the source of truth; the private property `tarea` links
// each event to its card.
import { CLOSED, CardError, addDays, editCard, getCard, normalizeId, today } from './cards.mjs';
import { toEvent } from './calendar.mjs';

const MAX_HOURS = 12;
const INDEX_TTL = 5 * 60_000;
const EVENT_ID = /^[a-z0-9_]{5,1024}$/i;

export function blocksCalendarName() {
  return process.env.TABLERO_BLOQUES || 'Bloques Trabajo';
}

/** Validates a start/end pair sent by the page (RFC 3339 with offset). */
export function blockTimes(inicio, fin) {
  const rfc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (!rfc.test(inicio || '') || !rfc.test(fin || '')) throw new CardError('Hora no válida: usa AAAA-MM-DDTHH:MM+02:00');
  const hours = (Date.parse(fin) - Date.parse(inicio)) / 3_600_000;
  if (!(hours > 0)) throw new CardError('El bloque tiene que acabar después de empezar');
  if (hours > MAX_HOURS) throw new CardError(`Un bloque no puede durar más de ${MAX_HOURS} horas`);
  return { inicio, fin };
}

/** Planning a block also plans its card for that day, so the board and the calendar agree. */
export async function planCardOn(dir, tarea, inicio, { who }) {
  if (!tarea) return;
  const card = await getCard(dir, tarea);
  const day = today(new Date(inicio));
  if (card.fecha !== day && !CLOSED.has(card.estado)) await editCard(dir, card.id, { fecha: day }, { who });
}

export function createBlocks({ calendar, name = blocksCalendarName(), now = Date.now }) {
  const { run } = calendar;
  let index = { at: 0, value: null, pending: null };
  const forget = () => {
    index = { at: 0, value: null, pending: null };
    calendar.invalidate();
  };

  async function target() {
    const find = (list) => list.find((c) => c.nombre === name);
    const found = find(await calendar.calendars()) || find(await calendar.calendars(true));
    if (!found) throw new CardError(`No encuentro el calendario «${name}» en Google`, 503);
    return found;
  }

  const assertId = (eventId) => {
    if (!EVENT_ID.test(eventId || '')) throw new CardError('Bloque no válido', 404);
  };
  const event = (raw, c) => toEvent({ ...raw, CalendarID: c.id }, c);

  return {
    name,
    /** Forgets the cached index, e.g. when the calendar is refreshed by hand. */
    invalidate: forget,

    async create({ tarea, titulo, inicio, fin }) {
      const id = normalizeId(tarea);
      blockTimes(inicio, fin);
      const c = await target();
      const raw = await run(c.cuenta, ['calendar', 'create', c.id, '--summary', titulo, '--from', inicio, '--to', fin,
        '--transparency', 'transparent', '--private-prop', `tarea=${id}`, '--description', `Tarea ${id} del tablero`]);
      forget();
      return event(raw, c);
    },

    async update(eventId, { inicio, fin, titulo }) {
      assertId(eventId);
      blockTimes(inicio, fin);
      const c = await target();
      const args = ['calendar', 'update', c.id, eventId, '--from', inicio, '--to', fin];
      if (titulo) args.push('--summary', titulo);
      const raw = await run(c.cuenta, args);
      forget();
      return event(raw, c);
    },

    async remove(eventId) {
      assertId(eventId);
      const c = await target();
      await run(c.cuenta, ['calendar', 'delete', c.id, eventId, '--force', '--send-updates', 'none']);
      forget();
    },

    /**
     * Per task: `proximo` (the first block not over yet) and `pasado` (the day of its last block, when
     * every block is over). From two weeks back to three months ahead, cached for a few minutes.
     */
    async index(day, { refresh = false } = {}) {
      if (!refresh && index.value && now() - index.at < INDEX_TTL) return index.value;
      if (index.pending) return index.pending;
      const pending = (async () => {
        const c = await target();
        const raw = await run(c.cuenta, ['calendar', 'events', c.id, '--from', addDays(day, -14), '--to', addDays(day, 90),
          '--all-pages', '--max', '500']);
        const byTask = new Map();
        const at = now();
        for (const e of raw) {
          const block = event(e, c);
          if (e.status === 'cancelled' || !block.tarea) continue;
          const entry = byTask.get(block.tarea) || { proximo: null, pasado: null };
          if (Date.parse(block.fin) > at) {
            if (!entry.proximo || block.inicio < entry.proximo.inicio) entry.proximo = block;
          } else if (!entry.pasado || block.inicio.slice(0, 10) > entry.pasado) entry.pasado = block.inicio.slice(0, 10);
          byTask.set(block.tarea, entry);
        }
        return byTask;
      })();
      index.pending = pending;
      try {
        const value = await pending;
        if (index.pending === pending) index = { at: now(), value, pending: null };
        return value;
      } catch (err) {
        if (index.pending === pending) index.pending = null;
        throw err;
      }
    },

    /** The task's blocks from today on, for its card. */
    async forTask(tarea, from = today()) {
      const id = normalizeId(tarea);
      const c = await target();
      const raw = await run(c.cuenta, ['calendar', 'events', c.id, '--from', from, '--to', addDays(from, 120),
        '--private-prop-filter', `tarea=${id}`, '--all-pages', '--max', '100']);
      return raw.filter((e) => e.status !== 'cancelled').map((e) => event(e, c));
    },
  };
}
