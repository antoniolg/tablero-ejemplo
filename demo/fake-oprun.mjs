#!/usr/bin/env node
// Stands in for `oprun` in the demo (TABLERO_OPRUN): answers the board's `gog … calendar` calls from
// demo/datos/google.json, writes included, so work blocks can be reserved, moved and removed.
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos', 'google.json');
const args = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const out = (value) => process.stdout.write(JSON.stringify(value));

const i = args.indexOf('calendar');
if (args[0] !== 'gog' || i < 0) fail(`La demo no sabe hacer: ${args.slice(0, 3).join(' ')}`);
const action = args[i + 1];
const positional = [];
const flags = {};
for (let k = i + 2; k < args.length; k++) {
  const a = args[k];
  if (!a.startsWith('-')) positional.push(a);
  else if (['-j', '--results-only', '--no-input', '--all', '--all-pages', '--force'].includes(a)) flags[a] = true;
  else flags[a] = args[++k];
}

const google = JSON.parse(readFileSync(FILE, 'utf8'));
const save = () => {
  writeFileSync(`${FILE}.tmp`, `${JSON.stringify(google, null, 2)}\n`);
  renameSync(`${FILE}.tmp`, FILE);
};
const startDay = (e) => (e.start.dateTime || e.start.date).slice(0, 10);
const inRange = (e) => (!flags['--from'] || startDay(e) >= flags['--from'].slice(0, 10))
  && (!flags['--to'] || startDay(e) <= flags['--to'].slice(0, 10));
const find = (calendar, id) => google.eventos.find((e) => e.CalendarID === calendar && e.id === id)
  || fail(`No existe el evento ${id}`);

if (action === 'calendars') out(google.calendarios);
else if (action === 'events') {
  const [calendar] = positional;
  const [key, value] = (flags['--private-prop-filter'] || '').split('=');
  out(google.eventos.filter((e) => (flags['--all'] || e.CalendarID === calendar) && inRange(e)
    && (!key || e.extendedProperties?.private?.[key] === value)));
} else if (action === 'create') {
  const [calendar] = positional;
  const id = `demo${randomBytes(6).toString('hex')}`;
  const [key, value] = (flags['--private-prop'] || '').split('=');
  const event = { CalendarID: calendar, id, iCalUID: `${id}@demo`, status: 'confirmed', summary: flags['--summary'] || '',
    start: { dateTime: flags['--from'] }, end: { dateTime: flags['--to'] },
    ...(flags['--transparency'] ? { transparency: flags['--transparency'] } : {}),
    ...(flags['--description'] ? { description: flags['--description'] } : {}),
    ...(key ? { extendedProperties: { private: { [key]: value } } } : {}) };
  google.eventos.push(event);
  save();
  out(event);
} else if (action === 'update') {
  const [calendar, id] = positional;
  const event = find(calendar, id);
  if (flags['--from']) event.start = { dateTime: flags['--from'] };
  if (flags['--to']) event.end = { dateTime: flags['--to'] };
  if (flags['--summary']) event.summary = flags['--summary'];
  save();
  out(event);
} else if (action === 'delete') {
  const [calendar, id] = positional;
  const event = find(calendar, id);
  google.eventos = google.eventos.filter((e) => e !== event);
  save();
  out({});
} else fail(`La demo no sabe hacer: calendar ${action}`);
