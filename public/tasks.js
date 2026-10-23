// Tasks panel: columns with drag and drop, a detail sheet per card and live refresh.
import { inline, renderMarkdown } from './markdown.js';
import { blocksSection, newBlock, unplan } from './blocks.js';
import { $, addDays, api, ask, h, html, notify, short } from './dom.js';

const state = { data: null, text: '', detail: null, dirty: false };
const CLOSED = ['hecha', 'soltada'];
// States that live in the inbox or in Planificado, depending on whether the card has a block.
const INBOX = ['bandeja', 'semana', 'mas-adelante'];
// "Esta semana" is still a valid state for the CLI, but on the board planning means a block.
const HIDDEN_STATES = ['semana'];
const HINTS = {
  bandeja: 'Todo lo pendiente, en el orden que te recomiendo.',
  planificado: 'Lo que tiene un hueco en el calendario. Arrastra aquí una tarea para reservarle uno.',
  'en-curso': 'Lo que tienes entre manos.',
  agente: 'Arrastra aquí lo que quieras delegar y dile a Claude o a Codex: «ponte con lo de Agente».',
  'tu-ok': 'Aquí deja el agente lo que solo necesita tu aprobación.',
  esperando: 'Lo que depende de otra persona.',
};
const blockDay = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric' });
const blockTime = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
const blockLabel = (bloque) => {
  const from = new Date(bloque.inicio);
  return `Bloque ${blockDay.format(from).replace('.', '')} · ${blockTime.format(from)}`;
};

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const label = (estado) => state.data.estados.find((s) => s.id === estado)?.label ?? estado;
const idNumber = (card) => Number(card.id.slice(2));

async function load({ onlyIfChanged = false } = {}) {
  try {
    const data = await api('/api/tablero');
    const text = JSON.stringify(data);
    // Polls and repeated change events often bring nothing new: rebuilding 50 cards then is wasted work.
    if (onlyIfChanged && text === state.text) return;
    state.text = text;
    state.data = data;
    render();
  } catch (err) {
    notify(`No he podido cargar el tablero: ${err.message}`);
  }
}

function sortCards(cards, column) {
  const byId = (a, b) => idNumber(a) - idNumber(b);
  if (column === 'bandeja') return cards.sort((a, b) => (b.prioridad?.puntos ?? 0) - (a.prioridad?.puntos ?? 0) || byId(a, b));
  if (column === 'planificado') return cards.sort((a, b) => a.bloque.inicio.localeCompare(b.bloque.inicio) || byId(a, b));
  return cards.sort((a, b) => (a.limite || '9999').localeCompare(b.limite || '9999')
    || (a.fecha || '9999').localeCompare(b.fecha || '9999') || byId(a, b));
}

function render() {
  const { tareas } = state.data;
  // Closed cards stay on disk for the CLI and the agents, but on screen they are only noise.
  const columnas = state.data.columnas.filter((c) => c.id !== 'cerrado');
  if (state.data.aviso && state.data.aviso !== state.aviso) notify(state.data.aviso);
  state.aviso = state.data.aviso;

  const board = $('#board');
  const scroll = board.scrollLeft;
  board.replaceChildren();
  $('#jump').replaceChildren();
  for (const column of columnas) {
    const cards = sortCards(tareas.filter((t) => t.columna === column.id), column.id);
    const section = h('section', { class: 'column', id: `col-${column.id}`, 'aria-label': column.label },
      h('header', {}, h('h2', {}, column.label), h('span', { class: 'count' }, cards.length)),
      cards.length ? cards.map(cardView) : h('p', { class: 'hint' }, HINTS[column.id]));
    addDropTarget(section, column.id);
    board.append(section);
    $('#jump').append(h('a', { href: `#col-${column.id}` }, column.label, h('span', {}, cards.length)));
  }
  board.scrollLeft = scroll;
}

function chips(card) {
  const closed = CLOSED.includes(card.estado);
  const list = [];
  if (closed) list.push([`closed-${card.estado}`, `${label(card.estado)}${card.cerrada ? ` ${short(card.cerrada)}` : ''}`]);
  for (const flag of card.avisos) list.push([`flag-${flag.tipo}`, flag.texto]);
  if (!closed) {
    const flagged = new Set(card.avisos.map((f) => f.tipo));
    if (card.agente && card.estado === 'agente') list.push(['', `La lleva ${capitalize(card.agente)}`]);
    if (card.agente && card.estado === 'tu-ok') list.push(['', `Preparada por ${capitalize(card.agente)}`]);
    if (card.responsable && !['antonio', 'agente'].includes(card.responsable)) list.push(['', `Espera a ${card.responsable}`]);
    if (card.bloque) list.push(['block', blockLabel(card.bloque)]);
    else if (card.fecha) list.push(['', `Plan ${short(card.fecha)}`]);
    if (card.limite && !flagged.has('limite')) list.push(['', `Límite ${short(card.limite)}`]);
    if (card.revisar && !flagged.has('vuelve') && !flagged.has('revisar')) list.push(['', `Revisar ${short(card.revisar)}`]);
  }
  if (card.area) list.push(['area', card.area]);
  return list.map(([kind, text]) => h('span', { class: `chip ${kind}`.trim() }, text));
}

function cardView(card) {
  const closed = CLOSED.includes(card.estado);
  const meta = chips(card);
  const check = closed ? null : h('button', {
    type: 'button', class: 'check', title: 'Marcar como hecha', 'aria-label': `Marcar como hecha: ${card.titulo}`,
    onclick: (event) => {
      event.stopPropagation();
      quickClose(card, el);
    },
  });
  const parked = card.columna === 'bandeja' && card.revisar && card.revisar > state.data.hoy && card.estado === 'mas-adelante';
  const el = h('article', {
    class: `card${closed ? ' closed' : ''}${parked ? ' parked' : ''}`, draggable: 'true', tabindex: '0', dataset: { id: card.id },
    'aria-label': `${card.id}: ${card.titulo}`, title: card.prioridad?.motivo || null,
  },
  h('div', { class: 'title' }, check, h('h3', {}, card.titulo)),
  card.siguiente && !closed ? h('p', { class: 'next' }, card.siguiente) : null,
  meta.length ? h('div', { class: 'meta' }, meta) : null,
  h('span', { class: 'id' }, card.id));
  el.addEventListener('click', () => openDetail(card.id));
  el.addEventListener('keydown', (event) => {
    if (event.target !== el) return; // keys on the check button are its own
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openDetail(card.id);
    }
  });
  el.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', card.id);
    event.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

function addDropTarget(section, column) {
  section.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    section.classList.add('drop');
  });
  section.addEventListener('dragleave', (event) => {
    if (!section.contains(event.relatedTarget)) section.classList.remove('drop');
  });
  section.addEventListener('drop', (event) => {
    event.preventDefault();
    section.classList.remove('drop');
    const card = state.data.tareas.find((t) => t.id === event.dataTransfer.getData('text/plain'));
    if (!card || card.columna === column) return;
    if (column === 'planificado') planCard(card);
    else if (column === 'bandeja' && card.columna === 'planificado') askUnplan(card);
    else requestMove(card, column);
  });
}

// ---------- planning ----------

/** Planning a card means reserving a block for it in the calendar. */
function planCard(card) {
  const now = new Date();
  const next = Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30;
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const day = card.fecha && card.fecha > todayLocal ? card.fecha : todayLocal;
  const start = day === todayLocal && next < 21 * 60 ? next : 9 * 60;
  // A card in progress, delegated or waiting that gets planned goes back to being yours to do.
  const after = INBOX.includes(card.estado) ? null : () => api(`/api/tareas/${card.id}/mover`, {
    method: 'POST', body: { estado: 'bandeja', version: card.version, nota: 'Planificada con un bloque' },
  }).catch((err) => notify(err.message));
  newBlock({ day, start, task: card, after });
}

function askUnplan(card) {
  ask({
    title: `¿Quitar del calendario los bloques pendientes de ${card.id}?`,
    fields: [],
    confirm: 'Quitar bloques',
    async onSubmit() {
      try {
        const removed = await unplan(card);
        notify(`${card.id} vuelve a la Bandeja (${removed} bloque${removed === 1 ? '' : 's'} quitado${removed === 1 ? '' : 's'})`);
      } catch (err) {
        notify(err.message);
      }
      await load();
    },
  });
}

// ---------- moves ----------

function requestMove(card, estado) {
  if (estado === 'esperando') return askMove(card, estado, { responsable: true, revisar: true });
  if (estado === 'mas-adelante') return askMove(card, estado, { revisar: true });
  if (estado === 'hecha') return askMove(card, estado, { evidencia: true });
  if (estado === 'soltada') return askMove(card, estado, {});
  return move(card, estado, {});
}

async function move(card, estado, extra) {
  try {
    await api(`/api/tareas/${card.id}/mover`, { method: 'POST', body: { estado, version: card.version, ...extra } });
    notify(`${card.id} → ${label(estado)}`);
  } catch (err) {
    notify(err.message);
  }
  await load();
  if (state.detail?.id === card.id && $('#detail').open) await openDetail(card.id);
}

/** Closes a card as done, with a few seconds to undo; false if it could not (it changed meanwhile, say). */
export async function closeTask(card) {
  let closed;
  try {
    closed = await api(`/api/tareas/${card.id}/mover`, { method: 'POST', body: { estado: 'hecha', version: card.version } });
  } catch (err) {
    notify(err.message);
    await load();
    return false;
  }
  notify(`${card.id} marcada como hecha`, { label: 'Deshacer', run: () => reopen(card, closed) });
  await load();
  return true;
}

// One click on the card's check.
async function quickClose(card, el) {
  el.classList.add('closing');
  if (!(await closeTask(card))) el.classList.remove('closing');
}

async function reopen(before, closed) {
  try {
    await api(`/api/tareas/${before.id}/mover`, {
      method: 'POST',
      body: {
        estado: before.estado, version: closed.version, responsable: before.responsable,
        revisar: before.revisar, nota: 'Se deshace el cierre',
      },
    });
    notify(`${before.id} vuelve a ${label(before.estado)}`);
  } catch (err) {
    notify(err.message);
  }
  await load();
}

const keepFilled = (values) => Object.fromEntries(
  Object.entries(values).filter(([key, value]) => value !== '' || ['revisar', 'responsable'].includes(key)),
);

function askMove(card, estado, { responsable, revisar, evidencia }) {
  const fields = [];
  if (responsable) {
    const current = ['antonio', 'agente'].includes(card.responsable) ? '' : card.responsable;
    fields.push({ name: 'responsable', label: '¿A quién esperas?', value: current });
  }
  if (revisar) {
    fields.push({ name: 'revisar', label: '¿Cuándo lo vuelves a mirar?', type: 'date', value: card.revisar || addDays(state.data.hoy, 7) });
  }
  if (evidencia) fields.push({ name: 'evidencia', label: 'Evidencia (opcional)', value: card.evidencia, placeholder: 'Commit, correo, enlace…' });
  fields.push({ name: 'nota', label: 'Nota para la bitácora (opcional)', type: 'textarea' });
  ask({ title: `${card.id} → ${label(estado)}`, fields, confirm: 'Mover', onSubmit: (values) => move(card, estado, keepFilled(values)) });
}

// ---------- detail ----------

const EDIT_FIELDS = ['titulo', 'siguiente', 'limite', 'revisar', 'responsable', 'area'];

async function openDetail(id) {
  let card;
  try {
    card = await api(`/api/tareas/${id}`);
  } catch (err) {
    return notify(err.message);
  }
  state.detail = card;
  state.dirty = false;
  const dialog = $('#detail');
  const input = (name, text, type = 'text', extra = {}) => h('label', {}, text, h('input', { name, type, value: card[name] || '', ...extra }));
  const facts = [['Prioridad', card.prioridad?.motivo], ['Origen', card.origen], ['Evidencia', card.evidencia]]
    .filter(([, value]) => value);
  const notes = h('textarea', { name: 'nota', rows: '2', placeholder: 'Por ejemplo: «hazte cargo; el PDF está en Descargas»' });

  const form = h('form', { method: 'dialog', class: 'form detail' },
    h('div', { class: 'row between' },
      h('span', { class: 'id' }, `${card.id} · ${label(card.estado)}`),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Cerrar', onclick: () => dialog.close() }, '×')),
    h('input', { name: 'titulo', value: card.titulo, class: 'title-input', 'aria-label': 'Título', required: true }),
    h('label', {}, 'Siguiente paso', h('textarea', { name: 'siguiente', rows: '2' }, card.siguiente || '')),
    // Only the fields that mean something in this state: planning is done with blocks, the review
    // date matters while waiting or parked, and the person only while waiting.
    h('div', { class: 'grid' },
      card.limite.length > 10
        ? input('limite', 'Fecha límite', 'text', { placeholder: 'AAAA-MM-DD HH:MM' })
        : input('limite', 'Fecha límite', 'date'),
      card.estado === 'esperando' ? input('responsable', '¿A quién esperas?') : null,
      ['esperando', 'mas-adelante'].includes(card.estado) ? input('revisar', '¿Cuándo la vuelves a mirar?', 'date') : null,
      input('area', 'Área', 'text', { placeholder: 'formaciones, desarrollo…' })),
    h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, 'Guardar cambios')),
    h('section', { class: 'moves' }, h('h3', {}, 'Mover a'),
      h('div', { class: 'pills' }, state.data.estados.filter((s) => s.id !== card.estado && !HIDDEN_STATES.includes(s.id))
        .map((s) => h('button', { type: 'button', onclick: () => requestMove(card, s.id) }, s.label)))),
    blocksSection(card),
    card.estado === 'agente'
      ? h('p', { class: 'hint' }, 'Para que se ponga, dile a Claude o a Codex: «ponte con las tareas de Agente».')
      : null,
    facts.length ? h('dl', { class: 'facts' }, facts.map(([term, value]) => [h('dt', {}, term), html('dd', {}, inline(value))])) : null,
    html('section', { class: 'body' }, renderMarkdown(card.cuerpo || '')),
    h('label', {}, 'Añadir a la bitácora', notes),
    h('div', { class: 'row end' }, h('button', { type: 'button', onclick: () => addNote(card, notes.value) }, 'Añadir nota')));

  form.addEventListener('input', () => { state.dirty = true; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save(card, form);
  });
  dialog.replaceChildren(form);
  if (!dialog.open) dialog.showModal();
}

async function save(card, form) {
  const values = Object.fromEntries(new FormData(form));
  // Fields not shown for this state are not in the form and stay as they are.
  const changes = Object.fromEntries(EDIT_FIELDS.filter((key) => key in values && values[key].trim() !== (card[key] || ''))
    .map((key) => [key, values[key].trim()]));
  if (!Object.keys(changes).length) return notify('No hay cambios que guardar');
  try {
    await api(`/api/tareas/${card.id}`, { method: 'PATCH', body: { ...changes, version: card.version } });
    notify('Guardado');
  } catch (err) {
    return notify(err.message);
  }
  await load();
  await openDetail(card.id);
}

async function addNote(card, text) {
  if (!text.trim()) return notify('Escribe la nota primero');
  try {
    await api(`/api/tareas/${card.id}/nota`, { method: 'POST', body: { texto: text } });
    notify('Nota añadida');
  } catch (err) {
    return notify(err.message);
  }
  await openDetail(card.id);
}

// ---------- start ----------

function newCard() {
  const columns = state.data.estados.filter((s) => !CLOSED.includes(s.id) && !HIDDEN_STATES.includes(s.id)).map((s) => [s.id, s.label]);
  ask({
    title: 'Nueva tarea',
    fields: [
      { name: 'titulo', label: 'Título', required: true, placeholder: 'Corto: qué hay que hacer' },
      { name: 'siguiente', label: 'Siguiente paso (opcional)' },
      { name: 'estado', label: 'Columna', type: 'select', value: 'bandeja', options: columns },
    ],
    confirm: 'Crear',
    async onSubmit(values) {
      try {
        const card = await api('/api/tareas', { method: 'POST', body: values });
        notify(`${card.id} creada`);
      } catch (err) {
        notify(err.message);
      }
      await load();
    },
  });
}

/** Wires the panel once; `refresh` is called again on every card change pushed by the server. */
export function initTasks() {
  $('#new-card').addEventListener('click', newCard);
  $('#detail').addEventListener('close', () => {
    state.detail = null;
    state.dirty = false;
  });
  return load();
}

export async function refreshTasks() {
  await load({ onlyIfChanged: true });
  const busy = $('#ask').open || state.dirty;
  if (state.detail && $('#detail').open && !busy) openDetail(state.detail.id);
}

/** The cards of the last load, for other panels (the calendar shows planned ones). */
export const openTask = (id) => openDetail(id);

export const currentTasks = () => state.data?.tareas ?? [];
