// Work blocks: reserve time for a task in the "Bloques Trabajo" calendar, from a slot of the
// calendar or from the card. Blocks are free events, so they never get in the way of a booking.
import { $, api, dayOf, h, localStamp, notify, todayLocal } from './dom.js';
import { closeTask, openTask } from './tasks.js';

const DURATIONS = [[30, '30 min'], [60, '1 h'], [90, '1 h 30'], [120, '2 h'], [180, '3 h']];
const ORDER = ['en-curso', 'semana', 'tu-ok', 'bandeja', 'agente', 'esperando', 'mas-adelante'];
const CLOSED = ['hecha', 'soltada'];
const ctx = { tasks: () => [], changed: () => {} };
const fmt = (options) => new Intl.DateTimeFormat('es-ES', options);
const longDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const timeOf = fmt({ hour: '2-digit', minute: '2-digit' });
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const toMinutes = (value) => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};

export function initBlocks({ tasks, changed }) {
  ctx.tasks = tasks;
  ctx.changed = changed;
}

export const taskOf = (event) => ctx.tasks().find((t) => t.id === event.tarea);
export const isDone = (event) => CLOSED.includes(taskOf(event)?.estado);

function closeButton(dialog) {
  return h('button', { type: 'button', class: 'icon', 'aria-label': 'Cerrar', onclick: () => dialog.close() }, '×');
}

/** Day, start and duration controls shared by the new and edit sheets. */
function whenFields({ day, start, minutes }) {
  const date = h('input', { type: 'date', value: day, 'aria-label': 'Día' });
  const time = h('input', { type: 'time', step: '900', value: hhmm(start), 'aria-label': 'Hora de inicio' });
  let duration = minutes;
  const pills = h('div', { class: 'pills big' }, DURATIONS.map(([value, text]) => h('button', {
    type: 'button', 'aria-pressed': String(value === duration),
    onclick: (event) => {
      duration = value;
      for (const pill of pills.children) pill.setAttribute('aria-pressed', String(pill === event.currentTarget));
    },
  }, text)));
  const el = h('div', { class: 'when' },
    h('div', { class: 'grid' }, h('label', {}, 'Día', date), h('label', {}, 'Empieza', time)),
    h('label', {}, 'Duración', pills));
  return {
    el,
    value() {
      if (!date.value || !time.value) throw new Error('Elige día y hora');
      const begin = toMinutes(time.value);
      return { inicio: localStamp(date.value, begin), fin: localStamp(date.value, begin + duration) };
    },
  };
}

async function send(path, method, body, done, after) {
  let ok = false;
  try {
    await api(path, { method, body });
    notify(done);
    ok = true;
  } catch (err) {
    notify(err.message);
  }
  if (ok && after) await after();
  ctx.changed();
}

function taskButton(task, pick) {
  return h('button', { type: 'button', class: 'task-pick', onclick: () => pick(task) },
    h('strong', {}, task.titulo), h('span', {}, `${task.id}${task.siguiente ? ` · ${task.siguiente}` : ''}`));
}

/**
 * New block. From the calendar you pick the task, or type something that is not on the board and
 * the task is created with the block; from a card the task is already chosen.
 */
export function newBlock({ day, start, task = null, after = null }) {
  const dialog = $('#ask');
  const when = whenFields({ day, start, minutes: 60 });
  const create = async (picked) => {
    let times;
    try {
      times = when.value();
    } catch (err) {
      return notify(err.message);
    }
    dialog.close();
    if (picked.nueva) await send('/api/bloques', 'POST', { nueva: picked.nueva, ...times }, `Tarea creada y bloque reservado: ${picked.nueva}`);
    else await send('/api/bloques', 'POST', { tarea: picked.id, ...times }, `Bloque reservado para ${picked.id}`, after);
  };
  let chooser = null;
  if (!task) {
    const open = ctx.tasks().filter((t) => !CLOSED.includes(t.estado) && t.columna !== 'archivo')
      .sort((a, b) => ORDER.indexOf(a.estado) - ORDER.indexOf(b.estado) || (a.fecha || '9').localeCompare(b.fecha || '9'));
    const list = h('div', { class: 'task-list' });
    const search = h('input', {
      type: 'search', placeholder: 'Busca una tarea o escribe una nueva…', 'aria-label': 'Buscar o crear tarea', enterkeyhint: 'done',
    });
    let shown = open;
    const typed = () => search.value.replace(/\s+/g, ' ').trim();
    const fill = () => {
      const q = typed().toLowerCase();
      shown = open.filter((t) => !q || `${t.id} ${t.titulo}`.toLowerCase().includes(q));
      // Anything typed that is not exactly an open task can become a new one.
      const fresh = q && !open.some((t) => t.titulo.toLowerCase() === q)
        ? h('button', { type: 'button', class: 'task-pick new', onclick: () => create({ nueva: typed() }) },
          h('strong', {}, `Crear «${typed()}»`), h('span', {}, 'Tarea nueva con este bloque'))
        : null;
      list.replaceChildren(...[fresh, ...shown.map((t) => taskButton(t, create))].filter(Boolean));
    };
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !typed()) return;
      event.preventDefault();
      if (shown.length === 1) create(shown[0]);
      else if (!shown.length) create({ nueva: typed() });
    });
    fill();
    chooser = h('section', { class: 'choose' }, h('h3', {}, '¿Para qué tarea?'), search, list);
  }
  dialog.replaceChildren(h('div', { class: 'form' },
    h('div', { class: 'row between' }, h('h2', {}, task ? `Reservar hueco · ${task.titulo}` : 'Nuevo bloque de trabajo'), closeButton(dialog)),
    when.el,
    chooser || h('div', { class: 'row end' },
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancelar'),
      h('button', { type: 'button', class: 'primary', onclick: () => create(task) }, 'Reservar')),
    h('p', { class: 'hint' }, 'Se guarda como «libre» en Bloques Trabajo: no bloquea a quien quiera reservarte una cita.')));
  if (!dialog.open) dialog.showModal();
}

/** Move, resize or remove a block. */
export function editBlock(event) {
  const dialog = $('#ask');
  const from = new Date(event.inicio);
  const to = new Date(event.fin);
  const task = taskOf(event);
  const when = whenFields({ day: dayOf(from), start: from.getHours() * 60 + from.getMinutes(), minutes: Math.round((to - from) / 60_000) });
  const id = event.id.split('/').pop();
  // The task behind the block: mark it done from here, without going through its card.
  const taskActions = task ? h('div', { class: 'block-actions' },
    isDone(event) ? null : h('button', {
      type: 'button', class: 'block-done',
      onclick: async () => {
        dialog.close();
        if (await closeTask(task)) ctx.changed();
      },
    }, 'Marcar como hecha'),
    h('button', { type: 'button', onclick: () => { dialog.close(); openTask(task.id); } }, 'Abrir tarea')) : null;
  dialog.replaceChildren(h('div', { class: 'form' },
    h('div', { class: 'row between' }, h('h2', {}, event.titulo), closeButton(dialog)),
    h('p', { class: 'hint' }, `${longDay.format(from)} · ${timeOf.format(from)}–${timeOf.format(to)}`
      + `${task ? ` · ${task.id}${isDone(event) ? ' (cerrada)' : ''}` : ''}`),
    taskActions,
    when.el,
    h('div', { class: 'row end' },
      h('button', {
        type: 'button', class: 'danger',
        onclick: () => {
          dialog.close();
          send(`/api/bloques/${id}`, 'DELETE', undefined, 'Bloque quitado');
        },
      }, 'Quitar'),
      h('span', { class: 'spacer' }),
      h('button', {
        type: 'button', class: 'primary',
        onclick: async () => {
          let times;
          try {
            times = when.value();
          } catch (err) {
            return notify(err.message);
          }
          dialog.close();
          await send(`/api/bloques/${id}`, 'PATCH', { ...times, tarea: event.tarea || undefined }, 'Bloque movido');
        },
      }, 'Guardar'))));
  dialog.showModal();
}

/** Removes the task's blocks that are not over yet (it goes back to the inbox). */
export async function unplan(card) {
  const { bloques } = await api(`/api/bloques?tarea=${card.id}`);
  const now = Date.now();
  const pending = bloques.filter((b) => Date.parse(b.fin) > now);
  for (const block of pending) await api(`/api/bloques/${block.id.split('/').pop()}`, { method: 'DELETE' });
  return pending.length;
}

/** The "Bloques" section of a card: its upcoming blocks and a button to reserve one more. */
export function blocksSection(card) {
  const list = h('div', { class: 'block-list' }, h('p', { class: 'hint' }, 'Cargando bloques…'));
  const now = new Date();
  const next = Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30;
  const day = card.fecha && card.fecha > todayLocal() ? card.fecha : todayLocal();
  const start = day === todayLocal() && next < 21 * 60 ? next : 9 * 60;
  const section = h('section', { class: 'blocks' },
    h('div', { class: 'row between' }, h('h3', {}, 'Bloques de trabajo'),
      CLOSED.includes(card.estado) ? null : h('button', { type: 'button', onclick: () => newBlock({ day, start, task: card }) }, 'Reservar hueco')),
    list);
  api(`/api/bloques?tarea=${card.id}`).then(({ bloques }) => {
    list.replaceChildren(...(bloques.length ? bloques.map((event) => {
      const from = new Date(event.inicio);
      return h('button', { type: 'button', class: 'block-row', onclick: () => editBlock(event) },
        `${longDay.format(from)} · ${timeOf.format(from)}–${timeOf.format(new Date(event.fin))}`);
    }) : [h('p', { class: 'hint' }, 'Sin bloques. Resérvale un hueco o toca una hora libre en el calendario.')]));
  }).catch((err) => list.replaceChildren(h('p', { class: 'hint' }, `No he podido leer los bloques: ${err.message}`)));
  return section;
}
