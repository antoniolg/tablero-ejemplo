import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorityOf } from '../src/priority.mjs';

const DAY = '2026-10-19';
const card = (fields) => ({ estado: 'bandeja', revisar: '', limite: '', fecha: '', creada: DAY, ...fields });

test('deadlines dominate: overdue, today, soon, far', () => {
  const overdue = priorityOf(card({ limite: '2026-10-15' }), DAY);
  const todayDue = priorityOf(card({ limite: '2026-10-19 14:00' }), DAY);
  const soon = priorityOf(card({ limite: '2026-10-22' }), DAY);
  const far = priorityOf(card({ limite: '2026-12-01' }), DAY);
  assert.ok(overdue.puntos > todayDue.puntos && todayDue.puntos > soon.puntos && soon.puntos > far.puntos);
  assert.equal(overdue.motivo, 'Venció el 15/10');
  assert.equal(soon.motivo, 'Vence en 3 días');
});

test('a missed block, the weekly pick and the plan date push a card up', () => {
  const plain = priorityOf(card({}), DAY).puntos;
  assert.equal(priorityOf(card({}), DAY, { pasado: '2026-10-16' }).motivo, 'Su bloque del 16/10 ya pasó');
  assert.ok(priorityOf(card({ estado: 'semana' }), DAY).puntos > plain);
  assert.ok(priorityOf(card({ fecha: '2026-10-17' }), DAY).puntos > priorityOf(card({ fecha: '2026-10-21' }), DAY).puntos);
});

test('parked cards sink until their date is close, then come back up', () => {
  const parked = priorityOf(card({ estado: 'mas-adelante', revisar: '2026-11-20' }), DAY);
  assert.ok(parked.puntos < 0);
  assert.equal(parked.motivo, 'Para más adelante (20/11)');
  assert.ok(priorityOf(card({ revisar: '2026-10-20' }), DAY).puntos > parked.puntos);
  assert.equal(priorityOf(card({ revisar: '2026-10-19' }), DAY).motivo, 'Toca revisarla hoy');
  const undated = priorityOf(card({ estado: 'mas-adelante' }), DAY);
  assert.ok(undated.puntos < priorityOf(card({}), DAY).puntos);
  assert.equal(undated.motivo, 'Para más adelante');
});

test('old cards slowly rise', () => {
  const old = priorityOf(card({ creada: '2026-09-01' }), DAY);
  assert.ok(old.puntos > priorityOf(card({}), DAY).puntos);
  assert.equal(old.motivo, 'Lleva 48 días esperando');
});
