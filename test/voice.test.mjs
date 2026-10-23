import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCard, getCard, listCards } from '../src/cards.mjs';
import { readWeek, setMeals } from '../src/meals.mjs';
import { cleanPlan, createVoice, promptFor } from '../src/voice.mjs';

const tmp = (name) => mkdtemp(path.join(os.tmpdir(), `tablero-voz-${name}-`));
const NOW = new Date(2026, 9, 19, 10, 0); // Monday 19 October 2026, 10:00 local

async function setup() {
  const dir = await tmp('tareas');
  const mealsDir = await tmp('comidas');
  await createCard(dir, { titulo: 'Llamar al taller', estado: 'semana' }); // T-001
  await createCard(dir, { titulo: 'Revisar el método de pago' }); // T-002
  await createCard(dir, { titulo: 'Ya cerrada', estado: 'hecha' }); // T-003
  await setMeals(mealsDir, '2026-10-20', { comida: 'Lentejas', cena: 'Tortilla' });
  const created = [];
  const blocks = {
    create: async (b) => { created.push(['crear', b]); return b; },
    update: async (id, b) => { created.push(['mover', id, b]); return b; },
    remove: async (id) => { created.push(['quitar', id]); },
  };
  const block = { id: 'c_bloques/abc123', tarea: 'T-002', titulo: 'Revisar el método de pago', inicio: '2026-10-21T10:00:00+02:00', fin: '2026-10-21T11:00:00+02:00' };
  const calendar = { week: async (monday) => ({ eventos: monday === '2026-10-19' ? [block, { id: 'otro', titulo: 'Reunión', inicio: block.inicio, fin: block.fin }] : [] }) };
  return { dir, mealsDir, blocks, calendar, created };
}

test('the prompt resolves days, and lists open cards, the menu and upcoming blocks', async () => {
  const { dir, mealsDir, calendar } = await setup();
  let prompt = '';
  const voice = createVoice({ dir, mealsDir, calendar, now: () => NOW, transcribe: async () => 'hola', interpret: async (p) => { prompt = p; return { acciones: [] }; } });
  await voice.plan(Buffer.from('a'));
  assert.match(prompt, /lunes, 19 de octubre de 2026, son las 10:00/);
  assert.match(prompt, /jue 22\/10 = 2026-10-22/);
  assert.match(prompt, /T-001 \[Esta semana\] Llamar al taller/);
  assert.doesNotMatch(prompt, /Ya cerrada/);
  assert.match(prompt, /mar 20\/10 \(2026-10-20\): comida «Lentejas», cena «Tortilla»/);
  assert.match(prompt, /B1: «Revisar el método de pago» \(T-002\) mié 21\/10 10:00–11:00/);
  assert.doesNotMatch(prompt, /Reunión/);
  assert.match(promptFor('x', { day: '2026-10-19', openCards: [], meals: [], blockList: [] }, NOW), /\(ninguna\)/);
});

test('only what can be applied survives, with a sentence for each', () => {
  const cards = new Map([['T-001', { id: 'T-001', titulo: 'Llamar al taller' }]]);
  const block = { id: 'c/abc', ref: 'B1', tarea: 'T-001', titulo: 'Llamar al taller', inicio: '2026-10-21T10:00:00+02:00', fin: '2026-10-21T11:00:00+02:00' };
  const { acciones } = cleanPlan({
    acciones: [
      { tipo: 'crear', titulo: 'Comprar pilas', fecha: 'mañana' },
      { tipo: 'editar', id: 't-001', fecha: '2026-10-22' },
      { tipo: 'editar', id: 'T-001' },
      { tipo: 'cerrar', id: 'T-099' },
      { tipo: 'mover', id: 'T-001', estado: 'esperando', responsable: 'el taller', revisar: '2026-10-23' },
      { tipo: 'comida', fecha: '2026-10-24', hueco: 'cena', plato: 'Pizza' },
      { tipo: 'comida', fecha: '2026-10-22', hueco: 'cena', plato: '' },
      { tipo: 'bloque', id: 'T-001', fecha: '2026-10-20', hora: '9:30', minutos: 90 },
      { tipo: 'mover_bloque', bloque: 'B1', hora: '16:00' },
      { tipo: 'quitar_bloque', bloque: 'B7' },
      { tipo: 'borrar_todo' },
    ],
  }, { cards, blocks: new Map([['B1', block]]) });
  assert.deepEqual(acciones.map((a) => a.descripcion), [
    'Crear «Comprar pilas»',
    'Cambiar T-001 «Llamar al taller»: planeada el jue 22/10',
    'Mover T-001 «Llamar al taller» a Esperando, la tiene el taller, revisar el vie 23/10',
    'Dejar libre la cena del jue 22/10',
    'Reservar un bloque para T-001 «Llamar al taller» el mar 20/10 de 09:30 a 11:00',
    'Mover el bloque de «Llamar al taller» al mié 21/10 de 16:00 a 17:00',
  ]);
});

test('a confirmed plan changes cards, meals and blocks; an unconfirmed one changes nothing', async () => {
  const { dir, mealsDir, blocks, calendar, created } = await setup();
  const voice = createVoice({
    dir, mealsDir, calendar, blocks, now: () => NOW,
    transcribe: async () => 'muchas cosas',
    interpret: async () => ({
      acciones: [
        { tipo: 'cerrar', id: 'T-002' },
        { tipo: 'crear', titulo: 'Comprar pilas', fecha: '2026-10-20' },
        { tipo: 'cambiar_comidas', fecha: '2026-10-20', hueco: 'comida', fecha2: '2026-10-20', hueco2: 'cena' },
        { tipo: 'bloque', titulo: 'Preparar charla', fecha: '2026-10-22', hora: '10:00' },
        { tipo: 'quitar_bloque', bloque: 'B1' },
      ],
    }),
  });
  const plan = await voice.plan(Buffer.from('a'));
  assert.equal(plan.acciones.length, 5);
  assert.equal((await listCards(dir)).length, 3);
  assert.equal(created.length, 0);

  const { hechas, calendario } = await voice.apply(plan.id);
  assert.deepEqual(hechas.map((h) => h.ok), [true, true, true, true, true]);
  assert.equal(calendario, true);
  assert.equal((await getCard(dir, 'T-002')).estado, 'hecha');
  const titles = (await listCards(dir)).map((c) => c.titulo);
  assert.ok(titles.includes('Comprar pilas') && titles.includes('Preparar charla'));
  const tuesday = (await readWeek(mealsDir, '2026-10-20')).dias.find((d) => d.fecha === '2026-10-20');
  assert.deepEqual([tuesday.comida, tuesday.cena], ['Tortilla', 'Lentejas']);
  assert.equal(created[0][0], 'crear');
  assert.equal(created[0][1].inicio, '2026-10-22T10:00:00+02:00');
  assert.deepEqual(created[1], ['quitar', 'abc123']);
  await assert.rejects(voice.apply(plan.id), /Ese plan ya no está/);
});

test('silence or a failing transcriber is reported, not turned into a plan', async () => {
  const { dir } = await setup();
  const silent = createVoice({ dir, transcribe: async () => '', interpret: async () => assert.fail('no debería llamar a Claude') });
  await assert.rejects(silent.plan(Buffer.from('a')), /No he entendido nada/);
  const broken = createVoice({ dir, transcribe: async () => { throw new Error('sin modelo'); }, interpret: async () => ({}) });
  await assert.rejects(broken.plan(Buffer.from('a')), /No he podido transcribir el audio: sin modelo/);
  await assert.rejects(silent.plan(Buffer.alloc(0)), /No ha llegado audio/);
});
