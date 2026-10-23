#!/usr/bin/env node
// Made-up data for demos and recordings, around one day (today, or the AAAA-MM-DD given): cards,
// meals for this week and the next, calendar events and work blocks (the fake Google that
// fake-oprun.mjs serves). Everything goes to demo/datos/, which it wipes first. Nothing here is real.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, createCard, editCard, moveCard, today } from '../src/cards.mjs';
import { mondayOf, setMeals } from '../src/meals.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'datos');
const DAY = process.argv[2] || today();
if (!/^\d{4}-\d{2}-\d{2}$/.test(DAY)) throw new Error(`Día no válido: ${DAY} (usa AAAA-MM-DD)`);

const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
const isWorkday = (day) => weekday(day) >= 1 && weekday(day) <= 5;
/** The nth working day after `day` (n = 1 is the next one). */
function workday(day, n) {
  let d = day;
  for (let left = n; left > 0;) {
    d = addDays(d, 1);
    if (isWorkday(d)) left--;
  }
  return d;
}
/** RFC 3339 with this Mac's offset for that day (Madrid: +02:00 or +01:00). */
function at(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const offset = -new Date(y, m - 1, d, h, min).getTimezoneOffset();
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  return `${day}T${hhmm}:00${offset >= 0 ? '+' : '-'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

const W1 = workday(DAY, 1);
const W2 = workday(DAY, 2);
const MONDAY = mondayOf(DAY);
const NEXT_MONDAY = addDays(MONDAY, 7);

await rm(DATA, { recursive: true, force: true });
const TAREAS = path.join(DATA, 'tareas');
const COMIDAS = path.join(DATA, 'comidas');
await mkdir(TAREAS, { recursive: true });
await mkdir(COMIDAS, { recursive: true });

// --- Cards ---------------------------------------------------------------------------------------
const who = { who: 'antonio' };
const cards = [
  ['Revisar la propuesta de Acme', 'semana', { siguiente: 'Comentar el presupuesto con Laura', area: 'admin' }],
  ['Guion del vídeo sobre agentes', 'en-curso', { siguiente: 'Cerrar la estructura y los ejemplos', area: 'contenido' }],
  ['Preparar la clase en directo', 'en-curso', { limite: `${DAY} 19:00`, siguiente: 'Repasar las diapositivas', area: 'formación' }],
  ['Responder a Nexo Labs sobre el patrocinio', 'tu-ok', { siguiente: 'Revisar el borrador y enviarlo', agente: 'claude' }],
  ['Factura de octubre a Formación Plus', 'agente', { siguiente: 'Generar y dejar lista para enviar', agente: 'codex', area: 'admin' }],
  ['Contrato firmado de Acme', 'esperando', { responsable: 'Acme', revisar: addDays(DAY, 2), area: 'admin' }],
  ['Renovar el dominio de la web', 'bandeja', { limite: addDays(DAY, 2), area: 'admin' }],
  ['Pedir presupuesto de la reforma', 'bandeja', { revisar: DAY, area: 'casa' }],
  ['Comprar el regalo de Lucía', 'bandeja', { fecha: DAY, area: 'personal' }],
  ['Ordenar las fotos del verano', 'mas-adelante', { revisar: addDays(DAY, 25), area: 'personal' }],
  ['Actualizar el temario del curso', 'semana', { area: 'formación' }],
  ['Llamar al seguro del coche', 'bandeja', { area: 'personal' }],
  ['Revisar las métricas de la newsletter', 'semana', { area: 'contenido' }],
  ['Publicar el episodio 42 del podcast', 'en-curso', { siguiente: 'Subir el audio y escribir las notas', area: 'contenido' }],
  ['Preparar el taller presencial de Madrid', 'semana', { limite: W1, area: 'formación' }],
  ['Copias de seguridad del NAS', 'mas-adelante', { revisar: addDays(DAY, 13), area: 'casa' }],
  ['Notas de la entrevista para RR. HH.', 'agente', { agente: 'claude', siguiente: 'Resumir y mandar a Marta' }],
];
const MOVED = new Set(['tu-ok', 'agente', 'esperando']);
const ids = new Map();
for (const [titulo, estado, extra] of cards) {
  const { agente, ...rest } = extra;
  const card = await createCard(TAREAS, { titulo, estado: MOVED.has(estado) ? 'bandeja' : estado, ...rest }, who);
  if (MOVED.has(estado)) await moveCard(TAREAS, card.id, estado, { ...who, responsable: rest.responsable, revisar: rest.revisar, agente });
  ids.set(titulo, card.id);
}

// --- Meals: this week and the next, Monday to Friday; today's dinner is left for a voice command --
const dishes = [
  ['Lentejas con verduras', 'Crema de calabaza con picatostes'],
  ['Curry de garbanzos con arroz', 'Salteado de tofu y brócoli'],
  ['Pasta con tomate y berenjena', 'Hamburguesas de lentejas'],
  ['Garbanzos con espinacas', 'Wok de tallarines con setas'],
  ['Paella de verduras', 'Tacos de alubias negras'],
  ['Arroz con verduras', 'Sopa de miso con tofu'],
  ['Potaje de alubias', 'Ensalada de quinoa y aguacate'],
  ['Fideuá de verduras', 'Crema de puerros'],
  ['Cuscús con verduras asadas', 'Hummus con crudités'],
  ['Espaguetis con pesto', 'Fajitas de seitán'],
];
for (let i = 0; i < 10; i++) {
  const day = addDays(i < 5 ? MONDAY : NEXT_MONDAY, i % 5);
  const [comida, cena] = dishes[i];
  await setMeals(COMIDAS, day, { comida, cena: day === DAY ? '' : cena });
}

// --- Google: calendars, events and work blocks, from the week before to two weeks ahead ----------
const W = 'trabajo@demo', P = 'personal@demo', F = 'c_formacion@demo', B = 'c_bloques@demo', M = 'c_marta@demo';
const calendarios = [
  { id: W, summary: 'Trabajo', backgroundColor: '#7986cb' },
  { id: P, summary: 'Personal', backgroundColor: '#33b679' },
  { id: F, summary: 'Formación', backgroundColor: '#e67c73' },
  { id: B, summary: 'Bloques Trabajo', backgroundColor: '#4fb38a' },
  { id: M, summary: 'Turno de Marta', backgroundColor: '#d06b64' },
];
const eventos = [];
let seq = 0;
const ev = (cal, summary, day, from, to, extra = {}) => {
  const id = `demo${String(++seq).padStart(4, '0')}`;
  eventos.push({ CalendarID: cal, id, iCalUID: `${id}@demo`, status: 'confirmed', summary,
    start: { dateTime: at(day, from) }, end: { dateTime: at(day, to) }, ...extra });
};
const allDay = (cal, summary, day) => {
  const id = `demo${String(++seq).padStart(4, '0')}`;
  eventos.push({ CalendarID: cal, id, iCalUID: `${id}@demo`, status: 'confirmed', summary,
    start: { date: day }, end: { date: addDays(day, 1) }, transparency: 'transparent' });
};
// A block also plans its card for that day, as the board does when you reserve one.
const block = async (titulo, day, from, to) => {
  const id = ids.get(titulo);
  ev(B, titulo, day, from, to, { transparency: 'transparent', description: `Tarea ${id} del tablero`, extendedProperties: { private: { tarea: id } } });
  await editCard(TAREAS, id, { fecha: day }, who);
};

// The usual week: daily, Marta's shifts (a background calendar), pilates and the live class.
for (let i = -7; i < 21; i++) {
  const day = addDays(MONDAY, i);
  const wd = weekday(day);
  if (isWorkday(day)) ev(W, 'Daily del equipo', day, '09:00', '09:30');
  if (wd === 1 || wd === 2) ev(M, 'Turno de Marta', day, '14:30', '22:00');
  if (wd === 3 || wd === 4) ev(M, 'Turno de Marta', day, '08:00', '15:00');
  if (wd === 2 || wd === 4) ev(P, 'Pilates', day, '07:30', '08:30');
  if (wd === 1 || wd === 4 || day === DAY) ev(F, 'Clase en directo · Curso de IA', day, '19:00', '21:00');
}
// Today and the next days, so "what's next" always has something.
ev(W, '1:1 con Laura', DAY, '10:00', '10:45');
ev(W, 'Llamada con Nexo Labs', DAY, '12:30', '13:15');
ev(P, 'Comida con Carlos', DAY, '14:00', '15:30');
ev(P, 'Dentista', DAY, '17:45', '18:30');
ev(F, 'Taller presencial en Madrid', W1, '10:00', '14:00');
ev(W, 'Entrevista: diseñadora de producto', W2, '11:00', '12:00');
ev(W, 'Grabación del podcast', W2, '16:00', '17:30');
allDay(W, 'Cierre de mes', W2);
ev(W, 'Revisión trimestral', addDays(NEXT_MONDAY, 1), '10:00', '12:00');
ev(W, 'Llamada con Acme', addDays(NEXT_MONDAY, 2), '16:00', '17:00');
ev(F, 'Q&A con alumnos', addDays(DAY, -1), '19:00', '20:00');
// The weekend after today.
const saturday = addDays(MONDAY, weekday(DAY) === 0 ? 12 : 5);
ev(P, 'Mercado con la familia', saturday, '11:00', '13:00');
ev(P, 'Cena de cumpleaños de Lucía', saturday, '21:00', '23:30');
ev(P, 'Cine', addDays(saturday, 1), '19:00', '21:30');
// Work blocks: one already over (its card goes back to the inbox with that reason) and the rest ahead.
await block('Actualizar el temario del curso', addDays(DAY, -1), '09:30', '11:00');
await block('Guion del vídeo sobre agentes', DAY, '11:00', '12:30');
await block('Preparar el taller presencial de Madrid', DAY, '16:00', '17:30');
await block('Revisar la propuesta de Acme', W1, '16:00', '17:00');
await block('Revisar las métricas de la newsletter', W2, '12:30', '13:30');

await writeFile(path.join(DATA, 'google.json'), `${JSON.stringify({ calendarios, eventos }, null, 2)}\n`);
await writeFile(path.join(DATA, 'dia.txt'), `${DAY}\n`);
console.log(`Datos de la demo listos para el ${DAY} en ${DATA}: ${cards.length} tareas, ${eventos.length} eventos`);
