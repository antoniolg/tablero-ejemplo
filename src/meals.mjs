// Weekly meal plan: one Markdown file per week (named after its Monday) with lunch and dinner from
// Monday to Friday. Weekends are never planned.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CardError, addDays } from './cards.mjs';

export const DEFAULT_MEALS_DIR = path.join(os.homedir(), 'tablero/comidas');
export const SLOTS = ['comida', 'cena'];
const SLOT_LABELS = { comida: 'Comida', cena: 'Cena' };
const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
const MAX_DISH = 200;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function mealsDir() {
  return process.env.COMIDAS_DIR || DEFAULT_MEALS_DIR;
}

export function mondayOf(day) {
  const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

function assertDay(day) {
  if (!DAY_RE.test(day || '') || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) throw new CardError('Fecha no válida (AAAA-MM-DD)');
}

function assertWorkday(day) {
  assertDay(day);
  if (new Date(`${day}T12:00:00Z`).getUTCDay() % 6 === 0) throw new CardError('Las comidas se planifican de lunes a viernes');
}

export function emptyWeek(monday) {
  return Array.from({ length: DAY_NAMES.length }, (_, i) => ({ fecha: addDays(monday, i), comida: '', cena: '' }));
}

/** Reads the days of a week file; lines it does not understand are ignored. */
export function parseWeek(text, monday) {
  const days = emptyWeek(monday);
  let current = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s.*?(\d{4}-\d{2}-\d{2})/);
    if (heading) {
      current = days.find((d) => d.fecha === heading[1]) || null;
      continue;
    }
    const slot = line.match(/^[-*]\s*(comida|cena)\s*:\s*(.*)$/i);
    if (slot && current) current[slot[1].toLowerCase()] = slot[2].trim();
  }
  return days;
}

export function serializeWeek(monday, days) {
  const [y, m, d] = monday.split('-');
  const lines = [`# Comidas · semana del ${d}/${m}/${y}`, ''];
  days.forEach((day, i) => {
    lines.push(`## ${DAY_NAMES[i]} ${day.fecha.slice(8, 10)}/${day.fecha.slice(5, 7)} · ${day.fecha}`, '');
    for (const slot of SLOTS) lines.push(`- ${SLOT_LABELS[slot]}: ${day[slot]}`.trimEnd());
    lines.push('');
  });
  return lines.join('\n');
}

const weekFile = (dir, monday) => path.join(dir, `${monday}.md`);

export async function readWeek(dir, day) {
  assertDay(day);
  const monday = mondayOf(day);
  try {
    return { semana: monday, dias: parseWeek(await readFile(weekFile(dir, monday), 'utf8'), monday) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { semana: monday, dias: emptyWeek(monday) };
  }
}

function cleanDish(value) {
  const dish = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (dish.length > MAX_DISH) throw new CardError(`El plato es demasiado largo (máximo ${MAX_DISH} caracteres)`);
  return dish;
}

/** Sets lunch and/or dinner for one day; an empty string clears the slot. */
export async function setMeals(dir, day, changes) {
  assertWorkday(day);
  const updates = SLOTS.filter((slot) => changes[slot] !== undefined);
  if (!updates.length) throw new CardError('Nada que cambiar: indica comida o cena');
  const week = await readWeek(dir, day);
  const target = week.dias.find((d) => d.fecha === day);
  for (const slot of updates) target[slot] = cleanDish(changes[slot]);
  await writeWeek(dir, week);
  return week;
}

async function writeWeek(dir, week) {
  await mkdir(dir, { recursive: true });
  const file = weekFile(dir, week.semana);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, serializeWeek(week.semana, week.dias));
  await rename(tmp, file);
}

function assertSlot(slot) {
  if (!SLOTS.includes(slot)) throw new CardError('Hueco no válido: comida o cena');
}

/**
 * Moves a dish from one slot to another; whatever was in the target goes back to the source,
 * so dragging onto a filled slot swaps the two. Returns the week of the target.
 */
export async function swapMeals(dir, from, to) {
  assertWorkday(from.fecha);
  assertWorkday(to.fecha);
  assertSlot(from.hueco);
  assertSlot(to.hueco);
  const source = await readWeek(dir, from.fecha);
  const target = mondayOf(to.fecha) === source.semana ? source : await readWeek(dir, to.fecha);
  const a = source.dias.find((d) => d.fecha === from.fecha);
  const b = target.dias.find((d) => d.fecha === to.fecha);
  [a[from.hueco], b[to.hueco]] = [b[to.hueco], a[from.hueco]];
  await writeWeek(dir, source);
  if (target !== source) await writeWeek(dir, target);
  return target;
}

/** Dishes already planned, most frequent first, to fill a slot with one tap. */
export async function recentDishes(dir, limit = 30) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, 26);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const stats = new Map();
  for (const [order, file] of files.entries()) {
    const days = parseWeek(await readFile(path.join(dir, file), 'utf8'), file.slice(0, 10));
    for (const day of days) {
      for (const slot of SLOTS) {
        const dish = day[slot];
        if (!dish) continue;
        const key = dish.toLowerCase();
        const entry = stats.get(key) || { plato: dish, veces: 0, orden: order };
        entry.veces += 1;
        stats.set(key, entry);
      }
    }
  }
  return [...stats.values()].sort((a, b) => b.veces - a.veces || a.orden - b.orden).slice(0, limit).map((e) => e.plato);
}
