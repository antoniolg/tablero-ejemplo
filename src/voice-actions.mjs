// What a voice command can change, in one place: the schema Claude answers with, the check that keeps
// only what can be applied (against the open cards, the meal plan and the upcoming work blocks), the
// sentence the tablet shows for each action, and how it is applied once Antonio confirms it.
import { CLOSED, STATES, STATE_LABELS, addNote, createCard, editCard, getCard, moveCard } from './cards.mjs';
import { SLOTS, setMeals, swapMeals } from './meals.mjs';
import { planCardOn } from './blocks.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}( ([01]\d|2[0-3]):[0-5]\d)?$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const NOTE = 'por voz desde el tablero';

export const TYPES = ['crear', 'editar', 'cerrar', 'soltar', 'mover', 'nota', 'comida', 'cambiar_comidas', 'bloque', 'mover_bloque', 'quitar_bloque'];

const str = (description) => ({ type: 'string', description });
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    acciones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { enum: TYPES },
          id: str('T-NNN de una tarea de la lista'),
          titulo: str('Título corto (crear, editar, o bloque para una tarea nueva)'),
          siguiente: str('Siguiente paso concreto'),
          fecha: str('AAAA-MM-DD: día planeado de la tarea, día de la comida o día del bloque'),
          limite: str('AAAA-MM-DD o AAAA-MM-DD HH:MM: fecha límite de la tarea'),
          estado: { enum: STATES, description: 'Estado al que moverla (mover)' },
          revisar: str('AAAA-MM-DD: cuándo revisarla (mover a esperando o más adelante)'),
          responsable: str('Quién la tiene (mover a esperando)'),
          texto: str('Texto de la nota'),
          hueco: { enum: SLOTS, description: 'comida o cena' },
          plato: str('Plato; vacío para dejar el hueco libre'),
          fecha2: str('AAAA-MM-DD del otro hueco (cambiar_comidas)'),
          hueco2: { enum: SLOTS, description: 'El otro hueco (cambiar_comidas)' },
          hora: str('HH:MM de inicio del bloque'),
          minutos: { type: 'integer', description: 'Duración del bloque en minutos' },
          bloque: str('Referencia B1, B2… de un bloque de la lista'),
        },
        required: ['tipo'],
      },
    },
    dudas: str('Lo que no está claro o no se puede hacer, en una o dos frases; vacío si nada'),
  },
  required: ['acciones'],
};

const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' });
/** "jue 22/10". */
export const dayLabel = (day) => fmt.format(new Date(`${day}T12:00:00Z`)).replace(',', '').replace('.', '');
const isWorkday = (day) => DAY_RE.test(day || '') && [1, 2, 3, 4, 5].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** RFC 3339 with the Mac's local offset (Madrid), as the blocks calendar expects. */
export function localStamp(day, minutes) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d, 0, minutes);
  const offset = -date.getTimezoneOffset();
  return `${dayOf(date)}T${hhmm(date)}:00${offset < 0 ? '-' : '+'}${pad(Math.trunc(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
const minutesOf = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const text = (value) => String(value ?? '').trim();
const quoted = (card) => `${card.id} «${card.titulo}»`;
const mealLabel = (day, slot) => `${slot === 'cena' ? 'la cena' : 'la comida'} del ${dayLabel(day)}`;

/**
 * One action as Claude wrote it → the action the server can apply, with `descripcion` for the
 * tablet, or null when it cannot be applied. `ctx`: `{ cards: Map, blocks: Map }` (blocks by B-ref and id).
 */
export function cleanAction(raw, { cards, blocks }) {
  const card = cards.get(text(raw.id).toUpperCase());
  const fecha = text(raw.fecha);
  switch (raw.tipo) {
    case 'crear': {
      const titulo = text(raw.titulo);
      if (!titulo) return null;
      const a = { tipo: 'crear', titulo, siguiente: text(raw.siguiente), fecha: DAY_RE.test(fecha) ? fecha : '', limite: DEADLINE_RE.test(text(raw.limite)) ? text(raw.limite) : '' };
      return { ...a, descripcion: `Crear «${titulo}»${a.fecha ? ` para el ${dayLabel(a.fecha)}` : ''}${a.limite ? `, con límite el ${dayLabel(a.limite.slice(0, 10))}` : ''}` };
    }
    case 'editar': {
      if (!card) return null;
      const changes = {};
      if (text(raw.titulo)) changes.titulo = text(raw.titulo);
      if (text(raw.siguiente)) changes.siguiente = text(raw.siguiente);
      if (DAY_RE.test(fecha)) changes.fecha = fecha;
      if (DEADLINE_RE.test(text(raw.limite))) changes.limite = text(raw.limite);
      if (!Object.keys(changes).length) return null;
      const said = { titulo: (v) => `título «${v}»`, siguiente: (v) => `siguiente paso «${v}»`, fecha: (v) => `planeada el ${dayLabel(v)}`, limite: (v) => `límite el ${dayLabel(v.slice(0, 10))}` };
      return { tipo: 'editar', id: card.id, cambios: changes, descripcion: `Cambiar ${quoted(card)}: ${Object.entries(changes).map(([k, v]) => said[k](v)).join(', ')}` };
    }
    case 'cerrar':
    case 'soltar':
      return card ? { tipo: raw.tipo, id: card.id, descripcion: `${raw.tipo === 'cerrar' ? 'Marcar como hecha' : 'Soltar'} ${quoted(card)}` } : null;
    case 'mover': {
      if (!card || !STATES.includes(raw.estado) || CLOSED.has(raw.estado)) return null;
      const revisar = DAY_RE.test(text(raw.revisar)) ? text(raw.revisar) : '';
      const responsable = text(raw.responsable);
      return {
        tipo: 'mover', id: card.id, estado: raw.estado, revisar, responsable,
        descripcion: `Mover ${quoted(card)} a ${STATE_LABELS[raw.estado]}${responsable ? `, la tiene ${responsable}` : ''}${revisar ? `, revisar el ${dayLabel(revisar)}` : ''}`,
      };
    }
    case 'nota':
      return card && text(raw.texto) ? { tipo: 'nota', id: card.id, texto: text(raw.texto), descripcion: `Nota en ${quoted(card)}: ${text(raw.texto)}` } : null;
    case 'comida': {
      if (!isWorkday(fecha) || !SLOTS.includes(raw.hueco)) return null;
      const plato = text(raw.plato);
      const where = mealLabel(fecha, raw.hueco);
      return { tipo: 'comida', fecha, hueco: raw.hueco, plato, descripcion: plato ? `Poner en ${where}: ${plato}` : `Dejar libre ${where}` };
    }
    case 'cambiar_comidas': {
      const fecha2 = text(raw.fecha2);
      if (!isWorkday(fecha) || !isWorkday(fecha2) || !SLOTS.includes(raw.hueco) || !SLOTS.includes(raw.hueco2)) return null;
      return { tipo: 'cambiar_comidas', fecha, hueco: raw.hueco, fecha2, hueco2: raw.hueco2, descripcion: `Intercambiar ${mealLabel(fecha, raw.hueco)} con ${mealLabel(fecha2, raw.hueco2)}` };
    }
    case 'bloque': {
      const titulo = text(raw.titulo);
      const minutos = Number.isInteger(raw.minutos) && raw.minutos >= 15 && raw.minutos <= 600 ? raw.minutos : 60;
      if ((!card && !titulo) || !DAY_RE.test(fecha) || !TIME_RE.test(text(raw.hora))) return null;
      const start = minutesOf(text(raw.hora));
      const what = card ? quoted(card) : `la tarea nueva «${titulo}»`;
      const until = localStamp(fecha, start + minutos).slice(11, 16);
      return {
        tipo: 'bloque', id: card?.id || '', titulo: card ? '' : titulo, inicio: localStamp(fecha, start), fin: localStamp(fecha, start + minutos),
        descripcion: `Reservar un bloque para ${what} el ${dayLabel(fecha)} de ${localStamp(fecha, start).slice(11, 16)} a ${until}`,
      };
    }
    case 'mover_bloque': {
      const block = blocks.get(text(raw.bloque));
      if (!block) return null;
      const from = new Date(block.inicio);
      const length = Math.round((Date.parse(block.fin) - Date.parse(block.inicio)) / 60_000);
      const day = DAY_RE.test(fecha) ? fecha : dayOf(from);
      const start = TIME_RE.test(text(raw.hora)) ? minutesOf(text(raw.hora)) : from.getHours() * 60 + from.getMinutes();
      const minutos = Number.isInteger(raw.minutos) && raw.minutos >= 15 && raw.minutos <= 600 ? raw.minutos : length;
      const inicio = localStamp(day, start);
      const fin = localStamp(day, start + minutos);
      if (inicio === block.inicio && fin === block.fin) return null;
      return { tipo: 'mover_bloque', bloque: block.id, tarea: block.tarea, inicio, fin, descripcion: `Mover el bloque de «${block.titulo}» al ${dayLabel(day)} de ${inicio.slice(11, 16)} a ${fin.slice(11, 16)}` };
    }
    case 'quitar_bloque': {
      const block = blocks.get(text(raw.bloque));
      return block ? { tipo: 'quitar_bloque', bloque: block.id, descripcion: `Quitar el bloque de «${block.titulo}» del ${dayLabel(dayOf(new Date(block.inicio)))} a las ${hhmm(new Date(block.inicio))}` } : null;
    }
    default:
      return null;
  }
}

export function cleanPlan(plan, ctx) {
  const acciones = (Array.isArray(plan?.acciones) ? plan.acciones : []).map((a) => cleanAction(a ?? {}, ctx)).filter(Boolean);
  return { acciones, dudas: text(plan?.dudas) };
}

/** Applies one confirmed action; returns the sentence for the notice. */
export async function applyAction(a, { dir, mealsDir, blocks, who }) {
  switch (a.tipo) {
    case 'crear': {
      const card = await createCard(dir, { titulo: a.titulo, siguiente: a.siguiente, fecha: a.fecha, limite: a.limite, nota: `creada ${NOTE}` }, { who });
      return `Creada ${card.id}: ${card.titulo}`;
    }
    case 'editar':
      await editCard(dir, a.id, a.cambios, { who, note: NOTE });
      return `${a.id} cambiada`;
    case 'cerrar':
      await moveCard(dir, a.id, 'hecha', { note: NOTE, evidencia: 'Antonio la dio por hecha por voz', who });
      return `${a.id} marcada como hecha`;
    case 'soltar':
      await moveCard(dir, a.id, 'soltada', { note: NOTE, who });
      return `${a.id} soltada`;
    case 'mover':
      await moveCard(dir, a.id, a.estado, { note: NOTE, who, ...(a.revisar ? { revisar: a.revisar } : {}), ...(a.responsable ? { responsable: a.responsable } : {}) });
      return `${a.id} → ${STATE_LABELS[a.estado]}`;
    case 'nota':
      await addNote(dir, a.id, a.texto, { who });
      return `Nota en ${a.id}`;
    case 'comida':
      await setMeals(mealsDir, a.fecha, { [a.hueco]: a.plato });
      return `${a.hueco === 'cena' ? 'Cena' : 'Comida'} del ${dayLabel(a.fecha)} ${a.plato ? 'puesta' : 'libre'}`;
    case 'cambiar_comidas':
      await swapMeals(mealsDir, { fecha: a.fecha, hueco: a.hueco }, { fecha: a.fecha2, hueco: a.hueco2 });
      return 'Comidas intercambiadas';
    case 'bloque': {
      if (!blocks) throw new Error('los bloques no están configurados');
      const card = a.id ? await getCard(dir, a.id)
        : await createCard(dir, { titulo: a.titulo, fecha: a.inicio.slice(0, 10), nota: `creada ${NOTE} con un bloque` }, { who });
      await blocks.create({ tarea: card.id, titulo: card.titulo, inicio: a.inicio, fin: a.fin });
      await planCardOn(dir, card.id, a.inicio, { who });
      return `Bloque reservado para ${card.id}`;
    }
    case 'mover_bloque':
      if (!blocks) throw new Error('los bloques no están configurados');
      await blocks.update(a.bloque.split('/').pop(), { inicio: a.inicio, fin: a.fin });
      await planCardOn(dir, a.tarea, a.inicio, { who });
      return 'Bloque movido';
    case 'quitar_bloque':
      if (!blocks) throw new Error('los bloques no están configurados');
      await blocks.remove(a.bloque.split('/').pop());
      return 'Bloque quitado';
    default:
      throw new Error(`acción desconocida: ${a.tipo}`);
  }
}

export const touchesCalendar = (a) => ['bloque', 'mover_bloque', 'quitar_bloque'].includes(a.tipo);
