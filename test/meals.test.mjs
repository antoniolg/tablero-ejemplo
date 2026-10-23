import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mondayOf, parseWeek, readWeek, recentDishes, serializeWeek, setMeals, swapMeals } from '../src/meals.mjs';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'tablero-comidas-'));

test('mondayOf finds the Monday of any day', () => {
  assert.equal(mondayOf('2026-10-19'), '2026-10-19');
  assert.equal(mondayOf('2026-10-25'), '2026-10-19');
  assert.equal(mondayOf('2026-11-01'), '2026-10-26');
});

test('a week round-trips through Markdown', () => {
  const days = parseWeek('', '2026-10-19');
  days[0].comida = 'Lentejas: con chorizo';
  days[4].cena = 'Pizza';
  const text = serializeWeek('2026-10-19', days);
  assert.match(text, /^## Lunes 19\/10 · 2026-10-19$/m);
  assert.match(text, /^- Comida: Lentejas: con chorizo$/m);
  assert.deepEqual(parseWeek(text, '2026-10-19'), days);
});

test('hand-written files are read leniently', () => {
  const days = parseWeek('## Martes · 2026-10-20\n* cena:  Tortilla \nnotas sueltas\n- Merienda: fruta\n', '2026-10-19');
  assert.equal(days[1].cena, 'Tortilla');
  assert.equal(days[1].comida, '');
});

test('setMeals writes one file per week and recentDishes ranks by frequency', async () => {
  const dir = await tempDir();
  assert.deepEqual((await readWeek(dir, '2026-10-21')).dias.map((d) => d.comida), Array(5).fill(''));
  await setMeals(dir, '2026-10-21', { comida: '  Lentejas   con verduras ' });
  await setMeals(dir, '2026-10-22', { cena: 'Tortilla' });
  await setMeals(dir, '2026-10-27', { comida: 'Tortilla' });
  const week = await setMeals(dir, '2026-10-21', { cena: 'Crema de calabaza' });
  assert.equal(week.semana, '2026-10-19');
  assert.deepEqual(week.dias[2], { fecha: '2026-10-21', comida: 'Lentejas con verduras', cena: 'Crema de calabaza' });
  assert.match(await readFile(path.join(dir, '2026-10-19.md'), 'utf8'), /- Cena: Tortilla/);
  const recent = await recentDishes(dir);
  assert.equal(recent[0], 'Tortilla'); // planned twice
  assert.deepEqual(recent.slice(1).sort(), ['Crema de calabaza', 'Lentejas con verduras']);
  await setMeals(dir, '2026-10-21', { comida: '' });
  assert.equal((await readWeek(dir, '2026-10-21')).dias[2].comida, '');
});

test('setMeals rejects bad dates, empty changes and very long dishes', async () => {
  const dir = await tempDir();
  await assert.rejects(setMeals(dir, '2026-13-40', { comida: 'x' }), /Fecha no válida/);
  await assert.rejects(setMeals(dir, '../etc', { comida: 'x' }), /Fecha no válida/);
  await assert.rejects(setMeals(dir, '2026-10-19', {}), /Nada que cambiar/);
  await assert.rejects(setMeals(dir, '2026-10-19', { comida: 'x'.repeat(201) }), /demasiado largo/);
  await writeFile(path.join(dir, 'otro.md'), '- Comida: no cuenta');
  assert.deepEqual(await recentDishes(dir), []);
});

test('swapMeals moves a dish, swaps with a filled slot and works across weeks', async () => {
  const dir = await tempDir();
  await setMeals(dir, '2026-10-19', { comida: 'Lentejas', cena: 'Tortilla' });
  let week = await swapMeals(dir, { fecha: '2026-10-19', hueco: 'comida' }, { fecha: '2026-10-21', hueco: 'cena' });
  assert.equal(week.dias[0].comida, '');
  assert.equal(week.dias[2].cena, 'Lentejas');
  week = await swapMeals(dir, { fecha: '2026-10-19', hueco: 'cena' }, { fecha: '2026-10-21', hueco: 'cena' });
  assert.equal(week.dias[0].cena, 'Lentejas');
  assert.equal(week.dias[2].cena, 'Tortilla');
  week = await swapMeals(dir, { fecha: '2026-10-21', hueco: 'cena' }, { fecha: '2026-10-26', hueco: 'comida' });
  assert.equal(week.semana, '2026-10-26');
  assert.equal(week.dias[0].comida, 'Tortilla');
  assert.equal((await readWeek(dir, '2026-10-21')).dias[2].cena, '');
  await assert.rejects(setMeals(dir, '2026-10-24', { comida: 'Paella' }), /de lunes a viernes/);
  await assert.rejects(swapMeals(dir, { fecha: '2026-10-19', hueco: 'comida' }, { fecha: '2026-10-25', hueco: 'cena' }), /de lunes a viernes/);
  await assert.rejects(swapMeals(dir, { fecha: '2026-10-19', hueco: 'merienda' }, { fecha: '2026-10-20', hueco: 'cena' }), /Hueco no válido/);
});
