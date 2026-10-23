import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockTimes, createBlocks } from '../src/blocks.mjs';
import { createCalendar } from '../src/calendar.mjs';

const BLOCKS_ID = 'c_bloques@group.calendar.google.com';

function fakeGoogle() {
  const log = [];
  const run = async (account, args) => {
    log.push(args);
    const [, action] = args;
    if (action === 'calendars') return [{ id: BLOCKS_ID, summary: 'Bloques Trabajo', backgroundColor: '#92e1c0' }];
    if (action === 'create' || action === 'update') {
      const at = (flag) => args[args.indexOf(flag) + 1];
      const tarea = args.includes('--private-prop') ? at('--private-prop').split('=')[1] : 'T-001';
      return { id: 'abc123', summary: 'Llamar al taller', start: { dateTime: at('--from') }, end: { dateTime: at('--to') },
        transparency: 'transparent', extendedProperties: { private: { tarea } } };
    }
    if (action === 'events') return [];
    return {};
  };
  return { log, run };
}

test('blockTimes accepts RFC 3339 ranges and rejects nonsense', () => {
  assert.deepEqual(blockTimes('2026-10-20T10:00:00+02:00', '2026-10-20T11:30:00+02:00'), {
    inicio: '2026-10-20T10:00:00+02:00', fin: '2026-10-20T11:30:00+02:00',
  });
  assert.throws(() => blockTimes('2026-10-20 10:00', '2026-10-20 11:00'), /Hora no válida/);
  assert.throws(() => blockTimes('2026-10-20T11:00:00+02:00', '2026-10-20T10:00:00+02:00'), /después de empezar/);
  assert.throws(() => blockTimes('2026-10-20T08:00:00+02:00', '2026-10-20T21:00:00+02:00'), /más de 12 horas/);
});

test('a block is a free event in Bloques Trabajo linked to its card', async () => {
  const google = fakeGoogle();
  const calendar = createCalendar({ accounts: ['a@x'], run: google.run });
  const blocks = createBlocks({ calendar });
  const block = await blocks.create({ tarea: '2', titulo: 'Llamar al taller', inicio: '2026-10-20T10:00:00+02:00', fin: '2026-10-20T11:00:00+02:00' });
  const create = google.log.find((args) => args[1] === 'create');
  assert.equal(create[2], BLOCKS_ID);
  assert.deepEqual(create.slice(create.indexOf('--transparency'), create.indexOf('--transparency') + 2), ['--transparency', 'transparent']);
  assert.ok(create.includes('tarea=T-002'));
  assert.equal(block.tarea, 'T-002');
  assert.equal(block.libre, true);
  assert.equal(block.id, `${BLOCKS_ID}/abc123`);

  await blocks.update('abc123', { inicio: '2026-10-21T09:00:00+02:00', fin: '2026-10-21T10:00:00+02:00' });
  assert.deepEqual(google.log.at(-1).slice(0, 4), ['calendar', 'update', BLOCKS_ID, 'abc123']);
  await blocks.remove('abc123');
  assert.deepEqual(google.log.at(-1).slice(0, 5), ['calendar', 'delete', BLOCKS_ID, 'abc123', '--force']);
  await assert.rejects(blocks.remove('../x'), /Bloque no válido/);

  await blocks.forTask('T-002', '2026-10-19');
  assert.ok(google.log.at(-1).includes('tarea=T-002'));
});

test('writing a block drops the cached weeks so the calendar shows it', async () => {
  const google = fakeGoogle();
  const calendar = createCalendar({ accounts: ['a@x'], run: google.run });
  const blocks = createBlocks({ calendar });
  await calendar.week('2026-10-19');
  const reads = () => google.log.filter((args) => args[1] === 'events').length;
  const before = reads();
  await blocks.create({ tarea: 'T-001', titulo: 'x', inicio: '2026-10-20T10:00:00+02:00', fin: '2026-10-20T11:00:00+02:00' });
  await calendar.week('2026-10-19');
  assert.equal(reads(), before + 1);
});

test('a missing blocks calendar is a clear error', async () => {
  const calendar = createCalendar({ accounts: ['a@x'], run: async () => [] });
  const blocks = createBlocks({ calendar, name: 'No existe' });
  await assert.rejects(blocks.forTask('T-001'), /No encuentro el calendario «No existe»/);
});

test('the index tells planned tasks from those whose blocks are over', async () => {
  const at = Date.parse('2026-10-19T12:00:00+02:00');
  const ev = (id, tarea, inicio, fin) => ({ id, summary: tarea, start: { dateTime: inicio }, end: { dateTime: fin }, extendedProperties: { private: { tarea } } });
  let reads = 0;
  const run = async (account, args) => {
    if (args[1] === 'calendars') return [{ id: BLOCKS_ID, summary: 'Bloques Trabajo' }];
    reads += 1;
    return [
      ev('a', 'T-001', '2026-10-21T10:00:00+02:00', '2026-10-21T11:00:00+02:00'),
      ev('b', 'T-001', '2026-10-20T10:00:00+02:00', '2026-10-20T11:00:00+02:00'),
      ev('c', 'T-002', '2026-10-16T10:00:00+02:00', '2026-10-16T11:00:00+02:00'),
      ev('d', 'T-002', '2026-10-17T10:00:00+02:00', '2026-10-17T11:00:00+02:00'),
      { id: 'e', summary: 'Sin tarea', start: { dateTime: '2026-10-20T09:00:00+02:00' }, end: { dateTime: '2026-10-20T10:00:00+02:00' } },
    ];
  };
  const blocks = createBlocks({ calendar: createCalendar({ accounts: ['a@x'], run, now: () => at }), now: () => at });
  const index = await blocks.index('2026-10-19');
  assert.equal(index.get('T-001').proximo.inicio, '2026-10-20T10:00:00+02:00');
  assert.equal(index.get('T-002').proximo, null);
  assert.equal(index.get('T-002').pasado, '2026-10-17');
  assert.equal(index.size, 2);
  await blocks.index('2026-10-19');
  assert.equal(reads, 1);
  blocks.invalidate();
  await blocks.index('2026-10-19');
  assert.equal(reads, 2);
});
