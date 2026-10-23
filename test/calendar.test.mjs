import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar, toEvent } from '../src/calendar.mjs';

const CALENDARS = {
  'a@x': [{ id: 'a@x', summary: 'Trabajo', backgroundColor: '#cd74e6' }, { id: 'shared', summary: 'Compartido', backgroundColor: '#92e1c0' }],
  'b@x': [{ id: 'shared', summary: 'Compartido (copia)', backgroundColor: '#000' }, { id: 'old', summary: 'Oculto', selected: false }],
};
const EVENTS = {
  'a@x': [
    // One event seen from two calendars (same iCalUID): shown once, preferring the copy that is not out of office.
    { CalendarID: 'a@x', id: '1', iCalUID: 'clase@google.com', summary: 'Clase', start: { dateTime: '2026-10-19T19:00:00+02:00' }, end: { dateTime: '2026-10-19T23:00:00+02:00' }, eventType: 'outOfOffice' },
    { CalendarID: 'shared', id: '2', iCalUID: 'clase@google.com', summary: 'CLASE', start: { dateTime: '2026-10-19T19:00:00+02:00' }, end: { dateTime: '2026-10-19T23:00:00+02:00' } },
    // A different event that only looks the same: it stays.
    { CalendarID: 'a@x', id: '10', iCalUID: 'otra@google.com', summary: 'Clase', start: { dateTime: '2026-10-19T19:00:00+02:00' }, end: { dateTime: '2026-10-19T23:00:00+02:00' } },
    { CalendarID: 'a@x', id: '3', summary: 'Home', start: { date: '2026-10-23' }, end: { date: '2026-10-24' }, eventType: 'workingLocation' },
    { CalendarID: 'a@x', id: '4', summary: 'Rechazada', start: { dateTime: '2026-10-20T10:00:00+02:00' }, end: { dateTime: '2026-10-20T11:00:00+02:00' }, attendees: [{ self: true, responseStatus: 'declined' }] },
  ],
  'b@x': [
    { CalendarID: 'shared', id: '7', summary: 'Ana Pérez Cumpleaños', start: { date: '2026-10-22' }, end: { date: '2026-10-23' } },
    { CalendarID: 'shared', id: '8', summary: 'Ana Pérez - Cumpleaños', start: { date: '2026-10-22' }, end: { date: '2026-10-23' }, eventType: 'birthday' },
    { CalendarID: 'shared', id: '9', summary: 'Fiesta de cumpleaños de Emma', start: { dateTime: '2026-10-24T17:00:00+02:00' }, end: { dateTime: '2026-10-24T19:00:00+02:00' } },
    { CalendarID: 'shared', id: '5', summary: 'Festivo', start: { date: '2026-10-24' }, end: { date: '2026-10-25' }, transparency: 'transparent', htmlLink: 'https://calendar.google.com/x' },
    { CalendarID: 'old', id: '6', summary: 'No se ve', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } },
  ],
};

function fakeRun(log = []) {
  return async (account, args) => {
    log.push([account, ...args]);
    return args[1] === 'calendars' ? CALENDARS[account] : EVENTS[account];
  };
}

test('toEvent keeps what the view needs', () => {
  const event = toEvent(EVENTS['b@x'].find((e) => e.id === '5'), { color: '#92e1c0' });
  assert.equal(event.diaCompleto, true);
  assert.equal(event.libre, true);
  assert.equal(event.color, '#92e1c0');
  assert.equal(event.enlace, 'https://calendar.google.com/x');
});

test('a week merges accounts, drops noise and duplicates, and is cached', async () => {
  const log = [];
  let clock = 0;
  const calendar = createCalendar({ accounts: ['a@x', 'b@x'], run: fakeRun(log), now: () => clock, background: ['Compartido'] });
  const week = await calendar.week('2026-10-19');
  assert.deepEqual(week.calendarios.map((c) => c.nombre), ['Trabajo', 'Compartido']);
  assert.deepEqual(week.calendarios.map((c) => c.fondo), [false, true]);
  assert.deepEqual(week.eventos.map((e) => e.titulo).sort(), ['CLASE', 'Clase', 'Festivo', 'Fiesta de cumpleaños de Emma'].sort());
  const clase = week.eventos.filter((e) => e.uid === 'clase@google.com');
  assert.equal(clase.length, 1);
  assert.equal(clase[0].tipo, 'default');
  assert.equal(clase[0].calendario, 'shared');
  // One call brings the week before and the two after too.
  assert.ok(log.some((call) => call.includes('--from') && call.includes('2026-10-12') && call.includes('2026-11-08')));
  const calls = log.length;
  clock += 60_000;
  await calendar.week('2026-10-19');
  assert.equal(log.length, calls);
  await calendar.week('2026-10-19', { refresh: true });
  // A refresh also reloads the calendar list, so renamed or new calendars show up.
  assert.equal(log.length, calls + 4);
  assert.equal(log.filter((call) => call[2] === 'calendars').length, 4);
});

test('one failing account is reported; all failing is an error', async () => {
  const partial = createCalendar({
    accounts: ['a@x', 'b@x'],
    run: async (account, args) => {
      if (account === 'b@x') throw new Error('token caducado');
      return args[1] === 'calendars' ? CALENDARS[account] : EVENTS[account];
    },
  });
  const week = await partial.week('2026-10-19');
  assert.equal(week.errores.length, 1);
  assert.match(week.errores[0], /b@x: token caducado/);
  const broken = createCalendar({ accounts: ['a@x'], run: async () => { throw new Error('sin red'); } });
  await assert.rejects(broken.week('2026-10-19'), /No he podido leer el calendario/);
  await assert.rejects(broken.week('19/10/2026'), /Fecha no válida/);
});

const at = (day, time) => ({ dateTime: `${day}T${time}:00+01:00` });

function changingRun(events, log = []) {
  return async (account, args) => {
    log.push(args);
    return args[1] === 'calendars' ? CALENDARS['a@x'] : events.map((event) => ({ ...event }));
  };
}

test('one call to Google covers the week before and the two after, split by week', async () => {
  const log = [];
  const events = [
    { CalendarID: 'a@x', id: 's1', summary: 'Viaje', start: { date: '2026-10-24' }, end: { date: '2026-10-28' } },
    { CalendarID: 'a@x', id: 's2', summary: 'Dentista', start: at('2026-10-27', '10:00'), end: at('2026-10-27', '11:00') },
    { CalendarID: 'a@x', id: 's3', summary: 'Guardia', start: at('2026-10-25', '20:00'), end: at('2026-10-26', '12:00') },
  ];
  const calendar = createCalendar({ accounts: ['a@x'], run: changingRun(events, log), background: [] });
  const eventCalls = () => log.filter((args) => args[1] === 'events').length;
  // Two weeks asked for at once share the same call.
  const [week, next] = await Promise.all([calendar.week('2026-10-19'), calendar.week('2026-10-26')]);
  assert.equal(eventCalls(), 1);
  assert.deepEqual(week.eventos.map((e) => e.titulo).sort(), ['Guardia', 'Viaje']);
  assert.deepEqual(next.eventos.map((e) => e.titulo).sort(), ['Dentista', 'Guardia', 'Viaje']);
  assert.deepEqual((await calendar.week('2026-10-12')).eventos, []);
  await calendar.week('2026-11-02');
  assert.equal(eventCalls(), 1);
  await calendar.week('2026-11-09');
  assert.equal(eventCalls(), 2);
});

test('a week a few minutes old is served at once and brought up to date behind', async () => {
  let clock = 0;
  const log = [];
  const events = [{ CalendarID: 'a@x', id: '1', summary: 'Antes', start: at('2026-10-20', '10:00'), end: at('2026-10-20', '11:00') }];
  const calendar = createCalendar({ accounts: ['a@x'], run: changingRun(events, log), now: () => clock, background: [] });
  const changes = [];
  calendar.onChange((mondays) => changes.push(mondays));
  const first = await calendar.week('2026-10-19');
  events[0].summary = 'Después';
  clock += 6 * 60_000;
  assert.equal((await calendar.week('2026-10-19')).eventos[0].titulo, 'Antes');
  await new Promise((resolve) => setImmediate(resolve));
  // Only the week that changed is announced, once.
  assert.deepEqual(changes, [['2026-10-19']]);
  const fresh = await calendar.week('2026-10-19');
  assert.equal(fresh.eventos[0].titulo, 'Después');
  assert.notEqual(fresh.huella, first.huella);
  // Nothing new in Google: same fingerprint, nobody is told.
  clock += 6 * 60_000;
  await calendar.week('2026-10-19');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changes.length, 1);
  assert.equal((await calendar.week('2026-10-19')).huella, fresh.huella);
  // Too old to show (the Mac slept): it waits for Google.
  events[0].summary = 'Mucho después';
  clock += 61 * 60_000;
  assert.equal((await calendar.week('2026-10-19')).eventos[0].titulo, 'Mucho después');
});

test('a write to Google drops cached weeks and fetches that started before it', async () => {
  const events = [{ CalendarID: 'a@x', id: '1', summary: 'Antes', start: at('2026-10-20', '10:00'), end: at('2026-10-20', '11:00') }];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = changingRun(events);
  const calendar = createCalendar({
    accounts: ['a@x'], background: [],
    run: async (account, args) => {
      const answer = await run(account, args);
      if (args[1] === 'events') await gate;
      return answer;
    },
  });
  const before = calendar.week('2026-10-19');
  await new Promise((resolve) => setImmediate(resolve));
  calendar.invalidate();
  events[0].summary = 'Bloque nuevo';
  const after = calendar.week('2026-10-19');
  release();
  assert.equal((await before).eventos[0].titulo, 'Antes');
  assert.equal((await after).eventos[0].titulo, 'Bloque nuevo');
  assert.equal((await calendar.week('2026-10-19')).eventos[0].titulo, 'Bloque nuevo');
});
