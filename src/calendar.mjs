// Read-only Google Calendar view by weeks, fetched with `gog` for each account and cached in memory
// so the page (and a wall tablet polling it) almost never waits on Google. Each call to Google
// brings four weeks (the one asked for, the one before and the two after): it costs the same as
// one, since most of the ~3 s is starting gog and 1Password.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CardError, addDays } from './cards.mjs';

export const DEFAULT_ACCOUNTS = []; // set TABLERO_CUENTAS; with no account the calendar is off
const EVENTS_TTL = 5 * 60_000; // younger than this, a week is served as it is
const STALE_LIMIT = 60 * 60_000; // older than this, wait for Google rather than show it
const WINDOW = [-1, 0, 1, 2]; // weeks around the one asked for that come in the same call
const KEEP_WEEKS = 26;
const CALENDARS_TTL = 6 * 60 * 60_000;
const SKIPPED_TYPES = new Set(['workingLocation', 'birthday']);

/** Contacts' birthdays (all-day, often imported) are noise on the board; a party at a set time is a plan and stays. */
const isBirthday = (raw) => Boolean(raw.start?.date) && /cumpleaños/i.test(raw.summary || '');

/** Calendars drawn as a background band by default (each device can change it): context, not my time. */
export function backgroundCalendars() {
  const list = (process.env.TABLERO_FONDO ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list;
}

export function calendarAccounts() {
  const list = (process.env.TABLERO_CUENTAS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ACCOUNTS;
}

/** Runs `oprun gog -a <account> … -j --results-only` and parses its JSON. */
export function gogRunner({ bin = process.env.TABLERO_OPRUN || path.join(os.homedir(), '.local/bin/oprun') } = {}) {
  return (account, args) => new Promise((resolve, reject) => {
    const argv = ['gog', '-a', account, ...args, '-j', '--results-only', '--no-input'];
    // LaunchAgents start with a bare PATH; gog and op live in Homebrew.
    const env = { ...process.env, PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':') };
    execFile(bin, argv, { timeout: 45_000, maxBuffer: 16 * 1024 * 1024, cwd: os.tmpdir(), env }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
      try {
        resolve(JSON.parse(stdout || '[]'));
      } catch {
        reject(new Error('gog no ha devuelto JSON'));
      }
    });
  });
}

function declined(event) {
  return (event.attendees || []).some((a) => a.self && a.responseStatus === 'declined');
}

export function toEvent(raw, calendar) {
  const allDay = Boolean(raw.start?.date);
  return {
    id: `${raw.CalendarID}/${raw.id}`,
    calendario: raw.CalendarID,
    color: calendar?.color || '#8a8a8a',
    titulo: raw.summary || '(sin título)',
    inicio: raw.start?.dateTime || raw.start?.date,
    fin: raw.end?.dateTime || raw.end?.date,
    diaCompleto: allDay,
    libre: raw.transparency === 'transparent',
    tipo: raw.eventType || 'default',
    ubicacion: raw.location || '',
    enlace: raw.htmlLink || '',
    uid: raw.iCalUID || `${raw.CalendarID}/${raw.id}`,
    tarea: raw.extendedProperties?.private?.tarea || '',
  };
}

/**
 * The same event can be visible from two calendars (an invite in a shared calendar, the copy in your
 * own). Those share Google's iCalUID and show once; different events stay even if they look alike.
 */
function dedupe(events) {
  const seen = new Map();
  for (const event of events) {
    const key = `${event.uid}|${Date.parse(event.inicio)}`;
    const kept = seen.get(key);
    if (!kept || (kept.tipo === 'outOfOffice' && event.tipo !== 'outOfOffice')) seen.set(key, event);
  }
  return [...seen.values()].sort((a, b) => a.inicio.localeCompare(b.inicio) || a.titulo.localeCompare(b.titulo));
}

const midnight = (day) => new Date(`${day}T00:00:00`).getTime(); // local time: the Mac's

/** Whether an event touches the week that starts on `monday` (an all-day `fin` is exclusive). */
function inWeek(event, monday) {
  const next = addDays(monday, 7);
  if (event.diaCompleto) return event.inicio < next && event.fin > monday;
  const start = Date.parse(event.inicio);
  const end = Math.max(Date.parse(event.fin) || 0, start + 1); // an event with no length still shows
  return start < midnight(next) && end > midnight(monday);
}

/** Changes only when what a week shows changes: pages repaint, and other screens hear of it, only then. */
function fingerprint(...parts) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export function createCalendar({ accounts = calendarAccounts(), run = gogRunner(), now = Date.now, background = backgroundCalendars() } = {}) {
  const weeks = new Map(); // monday → { at, value }, the most recently fetched last
  const pending = new Map(); // monday → the fetch on its way that covers it
  const listeners = new Set();
  let calendars = { at: 0, value: null };
  let generation = 0; // bumped by invalidate(), so a fetch that started before a write is not cached

  async function loadCalendars(refresh) {
    if (!refresh && calendars.value && now() - calendars.at < CALENDARS_TTL) return calendars.value;
    const byId = new Map();
    const results = await Promise.allSettled(accounts.map((account) => run(account, ['calendar', 'calendars'])));
    results.forEach((result, i) => {
      if (result.status !== 'fulfilled') return;
      for (const c of result.value) {
        if (c.selected === false || byId.has(c.id)) continue;
        const nombre = c.summaryOverride || c.summary || c.id;
        byId.set(c.id, { id: c.id, nombre, color: c.backgroundColor, cuenta: accounts[i], fondo: background.includes(nombre) });
      }
    });
    if (byId.size) calendars = { at: now(), value: [...byId.values()] };
    return [...byId.values()];
  }

  /** One call per account for all of `mondays`, split back into weeks. */
  async function fetchWeeks(mondays, refresh) {
    const list = await loadCalendars(refresh);
    const byId = new Map(list.map((c) => [c.id, c]));
    const args = ['calendar', 'events', '--all', '--from', mondays[0], '--to', addDays(mondays.at(-1), 6), '--all-pages', '--max', '250'];
    const results = await Promise.allSettled(accounts.map((account) => run(account, args)));
    const errores = [];
    const events = [];
    results.forEach((result, i) => {
      if (result.status !== 'fulfilled') return errores.push(`${accounts[i]}: ${result.reason.message}`);
      for (const raw of result.value) {
        if (raw.status === 'cancelled' || SKIPPED_TYPES.has(raw.eventType) || isBirthday(raw) || declined(raw)) continue;
        if (byId.size && !byId.has(raw.CalendarID)) continue;
        events.push(toEvent(raw, byId.get(raw.CalendarID)));
      }
    });
    if (errores.length === accounts.length) throw new CardError(`No he podido leer el calendario. ${errores[0]}`, 502);
    const all = dedupe(events);
    const actualizado = new Date(now()).toISOString();
    return new Map(mondays.map((monday) => {
      const eventos = all.filter((event) => inWeek(event, monday));
      return [monday, {
        desde: monday, hasta: addDays(monday, 7), calendarios: list, eventos, errores, actualizado,
        huella: fingerprint(list, eventos, errores),
      }];
    }));
  }

  /** Keeps fetched weeks and tells listeners which of the ones already served changed in Google. */
  function store(values) {
    const changed = [];
    for (const [monday, value] of values) {
      const old = weeks.get(monday);
      if (old && old.value.huella !== value.huella) changed.push(monday);
      weeks.delete(monday);
      weeks.set(monday, { at: now(), value });
    }
    while (weeks.size > KEEP_WEEKS) weeks.delete(weeks.keys().next().value);
    if (changed.length) for (const listener of listeners) listener(changed);
  }

  /** Fetches the weeks around `monday`; whoever asks for any of them meanwhile waits for this same call. */
  function fetchAround(monday, refresh) {
    const mondays = WINDOW.map((offset) => addDays(monday, 7 * offset));
    const started = generation;
    const fetching = fetchWeeks(mondays, refresh).then((values) => {
      if (started === generation) store(values);
      return values;
    });
    for (const m of mondays) pending.set(m, fetching);
    const forget = () => {
      for (const m of mondays) if (pending.get(m) === fetching) pending.delete(m);
    };
    fetching.then(forget, forget);
    return fetching;
  }

  return {
    /**
     * One week starting on `monday`. Up to 5 minutes old it is served as it is; up to an hour, too,
     * while a fetch brings it up to date behind (listeners hear if it changed); older, it waits for
     * Google. `refresh` skips both caches (events and the calendar list).
     */
    async week(monday, { refresh = false } = {}) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(monday || '')) throw new CardError('Fecha no válida (AAAA-MM-DD)');
      const cached = weeks.get(monday);
      const age = cached ? now() - cached.at : Infinity;
      if (!refresh) {
        if (age < EVENTS_TTL) return cached.value;
        if (age < STALE_LIMIT) {
          if (!pending.has(monday)) fetchAround(monday, false).catch(() => {});
          return cached.value;
        }
        if (pending.has(monday)) return (await pending.get(monday)).get(monday);
      }
      return (await fetchAround(monday, refresh)).get(monday);
    },
    /** The visible calendars, `{ id, nombre, color, cuenta }`. */
    calendars: (refresh = false) => loadCalendars(refresh),
    /** `listener(mondays)` runs when a fetch finds that weeks already served changed in Google. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Forgets cached weeks (and fetches on their way) after the board writes to Google. */
    invalidate() {
      generation += 1;
      weeks.clear();
      pending.clear();
    },
    run,
  };
}
