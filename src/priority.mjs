// Recommended order for the inbox: a score per card from its deadline, review date, plan date,
// whether a past block was missed and how long it has waited. The biggest contribution is shown
// as the reason, so the order can be explained.
import { addDays } from './cards.mjs';

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const short = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/**
 * `{ puntos, motivo }` for an open card on `day`. `pasado` is the last block it had, when every
 * block it had is already over (it was planned and slipped).
 */
export function priorityOf(card, day, { pasado = null } = {}) {
  const parts = [];
  const add = (points, reason) => parts.push({ points, reason });

  if (card.limite) {
    const left = daysBetween(day, card.limite.slice(0, 10));
    if (left < 0) add(100 + Math.min(-left, 10) * 2, `Venció el ${short(card.limite)}`);
    else if (left === 0) add(80, 'Vence hoy');
    else if (left <= 10) add(70 - left * 6, `Vence en ${left} día${left === 1 ? '' : 's'}`);
  }

  const review = card.revisar?.slice(0, 10);
  let parked = null;
  if (review && review <= day) add(30, review === day ? 'Toca revisarla hoy' : `Tocaba revisarla el ${short(review)}`);
  else if (review) {
    // Parked for later: it waits at the bottom until its date gets close.
    const left = daysBetween(day, review);
    parked = `Para más adelante (${short(review)})`;
    add(left <= 2 ? -10 : -60, parked);
  } else if (card.estado === 'mas-adelante') {
    parked = 'Para más adelante';
    add(-60, parked);
  }

  if (pasado) add(35, `Su bloque del ${short(pasado)} ya pasó`);
  if (card.estado === 'semana') add(20, 'Elegida para esta semana');
  if (card.fecha && card.fecha <= day) add(card.fecha < day ? 25 : 18, card.fecha < day ? `Planeada para el ${short(card.fecha)}` : 'Planeada para hoy');
  else if (card.fecha && card.fecha <= addDays(day, 3)) add(8, `Planeada para el ${short(card.fecha)}`);

  if (card.creada) {
    const age = Math.max(0, daysBetween(card.creada, day));
    if (age >= 7) add(Math.min(age, 40) * 0.4, `Lleva ${age} días esperando`);
  }

  const puntos = Math.round(parts.reduce((sum, p) => sum + p.points, 0));
  const top = parts.filter((p) => p.points > 0).sort((a, b) => b.points - a.points)[0];
  return { puntos, motivo: parked && puntos < 0 ? parked : top?.reason ?? '' };
}
