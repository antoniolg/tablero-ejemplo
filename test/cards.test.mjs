import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addNote, appendLog, columnOf, createCard, editCard, flagsOf, getCard, listCards, moveCard, normalizeId,
  parseCard, serializeCard, summaryMarkdown, toCard,
} from '../src/cards.mjs';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'tablero-'));
const card = (fields) => toCard(fields, 'T-001.md');

test('serialize and parse round-trip free text, accents and colons', () => {
  const fields = {
    id: 'T-001', titulo: 'Factura: «F-0042» de 1.250 €', estado: 'semana', responsable: 'antonio',
    siguiente: 'Decir "sí" y mirar el banco', fecha: '2026-10-19', limite: '2026-10-23 14:59', extra: 'se conserva',
  };
  const text = serializeCard(fields, '## Contexto\n\nAlgo.\n');
  assert.match(text, /^titulo: "Factura: «F-0042» de 1.250 €"$/m);
  assert.match(text, /^limite: 2026-10-23 14:59$/m);
  assert.match(text, /^extra: se conserva$/m);
  const parsed = parseCard(text);
  assert.deepEqual(parsed.fields, fields);
  assert.equal(parsed.body, '\n## Contexto\n\nAlgo.\n');
});

test('parse accepts hand-written YAML scalars', () => {
  const { fields } = parseCard("---\ntitulo: 'Lo de Ana''s'\nestado: semana\nresponsable:\n---\nCuerpo\n");
  assert.equal(fields.titulo, "Lo de Ana's");
  assert.equal(fields.estado, 'semana');
  assert.equal(fields.responsable, '');
});

test('serialize drops empty fields and multi-line values become one line', () => {
  const text = serializeCard({ id: 'T-002', titulo: 'Uno\ndos', revisar: '' }, '');
  assert.match(text, /^titulo: "Uno dos"$/m);
  assert.doesNotMatch(text, /revisar/);
});

test('appendLog adds the Bitácora section when it is missing', () => {
  assert.equal(appendLog('## Contexto\n\nX\n', 'nota'), '## Contexto\n\nX\n\n## Bitácora\n\n- nota\n');
  assert.equal(appendLog('## Bitácora\n\n- a\n\n', 'b'), '## Bitácora\n\n- a\n- b\n');
});

test('normalizeId accepts short forms and rejects junk', () => {
  assert.equal(normalizeId('12'), 'T-012');
  assert.equal(normalizeId('t-7'), 'T-007');
  assert.equal(normalizeId('T-1234'), 'T-1234');
  assert.throws(() => normalizeId('../etc'), /no válido/);
});

test('createCard assigns sequential ids and a body with Contexto and Bitácora', async () => {
  const dir = await tempDir();
  const first = await createCard(dir, { titulo: 'Llamar al taller', siguiente: 'Pedir fecha' }, { who: 'claude' });
  const second = await createCard(dir, { titulo: 'Otra', estado: 'agente', contexto: 'Hilo `1a0f8483bb900fd5`' });
  assert.equal(first.id, 'T-001');
  assert.equal(first.responsable, 'antonio');
  assert.equal(second.id, 'T-002');
  assert.equal(second.responsable, 'agente');
  const text = await readFile(path.join(dir, 'T-002.md'), 'utf8');
  assert.match(text, /## Contexto\n\nHilo `1a0f8483bb900fd5`\n\n## Bitácora\n\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · Agente: creada en Agente\n$/);
  assert.match(await readFile(path.join(dir, 'T-001.md'), 'utf8'), /· Claude: creada en Bandeja/);
});

test('concurrent creates never reuse an id', async () => {
  const dir = await tempDir();
  const cards = await Promise.all(Array.from({ length: 6 }, (_, i) => createCard(dir, { titulo: `T${i}` })));
  assert.equal(new Set(cards.map((c) => c.id)).size, 6);
});

test('createCard validates title, state and dates', async () => {
  const dir = await tempDir();
  await assert.rejects(createCard(dir, { titulo: ' ' }), /título/);
  await assert.rejects(createCard(dir, { titulo: 'x', estado: 'quizá' }), /Estado no válido/);
  await assert.rejects(createCard(dir, { titulo: 'x', fecha: '19/10' }), /AAAA-MM-DD/);
});

test('moveCard updates owner, review date, closing date and logs who did it', async () => {
  const dir = await tempDir();
  const { id } = await createCard(dir, { titulo: 'Contestar a Marta' });
  let moved = await moveCard(dir, id, 'esperando', { responsable: 'Marta (Acme)', revisar: '2026-10-23', note: 'Le pregunté días', who: 'codex' });
  assert.equal(moved.estado, 'esperando');
  assert.equal(moved.responsable, 'Marta (Acme)');
  assert.equal(moved.revisar, '2026-10-23');
  moved = await moveCard(dir, id, 'agente', { agente: 'claude', who: 'claude' });
  assert.equal(moved.responsable, 'agente');
  assert.equal(moved.agente, 'claude');
  assert.equal(moved.revisar, '');
  moved = await moveCard(dir, id, 'hecha', { evidencia: 'Respondido el 16/10', who: 'claude' });
  assert.equal(moved.estado, 'hecha');
  assert.match(moved.cerrada, /^\d{4}-\d{2}-\d{2}$/);
  const text = await readFile(path.join(dir, `${id}.md`), 'utf8');
  assert.match(text, /· Codex: Bandeja → Esperando\. Le pregunté días/);
  assert.match(text, /· Claude: Esperando → Agente/);
  assert.match(text, /· Claude: Agente → Hecha/);
});

test('updates with a stale version are rejected with 409', async () => {
  const dir = await tempDir();
  const created = await createCard(dir, { titulo: 'x' });
  await addNote(dir, created.id, 'cambio de otro agente', { who: 'hermes' });
  await assert.rejects(moveCard(dir, created.id, 'semana', { expectedVersion: created.version }), (err) => err.status === 409);
});

test('editCard validates fields and only logs real changes', async () => {
  const dir = await tempDir();
  const { id } = await createCard(dir, { titulo: 'x', siguiente: 'a' });
  await assert.rejects(editCard(dir, id, { estado: 'hecha' }), /No se puede editar/);
  await assert.rejects(editCard(dir, id, { limite: 'mañana' }), /limite/);
  const edited = await editCard(dir, id, { siguiente: 'b', fecha: '2026-10-20' }, { who: 'antonio' });
  assert.equal(edited.siguiente, 'b');
  await editCard(dir, id, { siguiente: 'b' });
  const log = (await readFile(path.join(dir, `${id}.md`), 'utf8')).match(/· Antonio: Edita/g);
  assert.equal(log.length, 1);
});

test('getCard reports missing cards as 404 and hand-edited cards still load', async () => {
  const dir = await tempDir();
  await assert.rejects(getCard(dir, 'T-404'), (err) => err.status === 404);
  await writeFile(path.join(dir, 'T-009.md'), '---\ntitulo: A mano\nestado: semana\n---\n\nSin bitácora\n');
  const [loaded] = await listCards(dir);
  assert.equal(loaded.id, 'T-009');
  const noted = await addNote(dir, 'T-009', 'primera nota', { who: 'codex' });
  assert.match(noted.cuerpo, /## Bitácora\n\n- .* · Codex: primera nota/);
  assert.match(await readFile(path.join(dir, 'T-009.md'), 'utf8'), /^id: T-009$/m);
});

test('columns: later cards come back on their review day, old closed cards go to the archive', () => {
  const day = '2026-10-16';
  assert.equal(columnOf(card({ estado: 'mas-adelante', revisar: '2026-10-19' }), day), 'mas-adelante');
  assert.equal(columnOf(card({ estado: 'mas-adelante', revisar: '2026-10-16' }), day), 'bandeja');
  assert.equal(columnOf(card({ estado: 'hecha', cerrada: '2026-10-10' }), day), 'cerrado');
  assert.equal(columnOf(card({ estado: 'soltada', cerrada: '2026-09-20' }), day), 'archivo');
  assert.equal(columnOf(card({ estado: 'rarísimo' }), day), 'bandeja');
});

test('flags: review due, waiting due and close deadlines', () => {
  const day = '2026-10-16';
  assert.deepEqual(flagsOf(card({ estado: 'mas-adelante', revisar: '2026-10-16' }), day), [{ tipo: 'vuelve', texto: 'Vuelve hoy' }]);
  assert.deepEqual(flagsOf(card({ estado: 'esperando', revisar: '2026-10-15' }), day), [{ tipo: 'revisar', texto: 'Toca revisar' }]);
  assert.deepEqual(flagsOf(card({ estado: 'semana', limite: '2026-10-19 10:00' }), day), [{ tipo: 'limite', texto: 'Vence el 19/10' }]);
  assert.deepEqual(flagsOf(card({ estado: 'semana', limite: '2026-10-30' }), day), []);
  assert.deepEqual(flagsOf(card({ estado: 'hecha', limite: '2026-10-10' }), day), []);
});

test('summaryMarkdown groups cards by column', () => {
  const md = summaryMarkdown([
    card({ id: 'T-001', titulo: 'A', estado: 'semana', siguiente: 'hacer A', fecha: '2026-10-19' }),
    card({ id: 'T-002', titulo: 'B', estado: 'mas-adelante', revisar: '2026-11-02' }),
    card({ id: 'T-003', titulo: 'C', estado: 'hecha', cerrada: '2026-10-16' }),
  ], '2026-10-16');
  assert.match(md, /## Esta semana \(1\)\n- T-001 · A · siguiente: hacer A · plan 19\/10/);
  assert.match(md, /## Más adelante \(1\)\n- T-002 · B · revisar 02\/11/);
  assert.match(md, /## Cerrado \(últimos 14 días\) \(1\)\n- T-003 · C · hecha 16\/10/);
});
