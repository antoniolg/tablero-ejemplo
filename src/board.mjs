// What the board shows for each card: its column, warnings, next work block and inbox priority.
// "Planificado" is not a state in the file: an open card is planned while it has a block in the
// work calendar that is not over yet. Everything else that is not in progress, delegated or
// waiting goes to the inbox, parked cards included, in recommended order.
import { columnOf, flagsOf } from './cards.mjs';
import { priorityOf } from './priority.mjs';

export const BOARD_COLUMNS = [
  { id: 'bandeja', label: 'Bandeja' },
  { id: 'planificado', label: 'Planificado' },
  { id: 'en-curso', label: 'En curso' },
  { id: 'agente', label: 'Agente' },
  { id: 'tu-ok', label: 'Necesita tu OK' },
  { id: 'esperando', label: 'Esperando' },
];
const INBOX = new Set(['bandeja', 'semana', 'mas-adelante']);

/** `plan` is the card's entry in the block index: `{ proximo, pasado }`, or nothing. */
export function boardView(card, day, plan = null) {
  const base = columnOf(card, day);
  const proximo = plan?.proximo ?? null;
  let columna = base;
  if (INBOX.has(base)) columna = proximo ? 'planificado' : 'bandeja';
  const view = {
    ...card,
    columna,
    avisos: flagsOf(card, day),
    bloque: proximo ? { inicio: proximo.inicio, fin: proximo.fin } : null,
  };
  if (columna === 'bandeja') view.prioridad = priorityOf(card, day, { pasado: plan?.pasado ?? null });
  return view;
}
