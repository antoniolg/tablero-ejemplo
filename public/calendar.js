// Calendar panel: the week of Google Calendar events (read-only) plus the tasks planned for each day.
import {
  $, addDays, h, html, mondayOf, notify, remember, store, todayLocal,
} from './dom.js';
import { openTask } from './tasks.js';
import { editBlock, isDone, newBlock } from './blocks.js';
import { cachedWeek, loadWeek, prefetchWeeks } from './weeks.js';
import { onSideSwipe } from './swipe.js';

// px per hour, from --hour in panels.css (taller on short screens); read again on every render.
let HOUR = 52;
const hourHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 52;
const MIN_EVENT = 24;
const REFRESH_EVERY = 5 * 60_000;
const OPEN_TASKS = (t) => !['hecha', 'soltada'].includes(t.estado) && t.columna !== 'archivo';
const narrow = window.matchMedia('(max-width: 760px)');
const short = window.matchMedia('(max-height: 760px)'); // changes --hour
const state = {
  monday: mondayOf(todayLocal()), day: todayLocal(), data: null, loading: false, hidden: new Set(), fondo: {},
  scrolledFor: null, scroll: 0, hours: [7, 23], dirty: false, timer: null, tasks: () => [], seenToday: todayLocal(),
};

const fmt = (options) => new Intl.DateTimeFormat('es-ES', options);
const weekdayShort = fmt({ weekday: 'short' });
const dayMonth = fmt({ day: 'numeric', month: 'short' });
const timeOf = fmt({ hour: '2-digit', minute: '2-digit' });
const longDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const localDate = (day) => new Date(`${day}T00:00:00`);
const visible = (event) => !state.hidden.has(event.calendario);
/** Background calendars (e.g. a partner's work shifts) are context: a tinted band that takes no room. */
const inBackground = (calendarId) => state.fondo[calendarId]
  ?? Boolean(state.data?.calendarios.find((c) => c.id === calendarId)?.fondo);

/** How a calendar shows on this device ('ver', 'fondo' or 'oculto'); the home panel follows it too. */
export function calendarMode(calendar) {
  if (state.hidden.has(calendar.id)) return 'oculto';
  return (state.fondo[calendar.id] ?? calendar.fondo) ? 'fondo' : 'ver';
}

function rangeLabel(days) {
  const first = localDate(days[0]);
  const last = localDate(days.at(-1));
  if (days.length === 1) return capital(longDay.format(first));
  const year = last.getFullYear() === new Date().getFullYear() ? '' : ` ${last.getFullYear()}`;
  return `${dayMonth.format(first)} – ${dayMonth.format(last)}${year}`;
}

const capital = (text) => text[0].toUpperCase() + text.slice(1);

/** Splits timed events into per-day pieces; anything covering a whole day goes with the all-day ones. */
function piecesFor(day, events) {
  const start = localDate(day);
  const end = localDate(addDays(day, 1));
  const allDay = [];
  const timed = [];
  const back = [];
  for (const event of events) {
    if (event.diaCompleto) {
      if (event.inicio <= day && day < event.fin) allDay.push(event);
      continue;
    }
    const s = new Date(event.inicio);
    const e = new Date(event.fin);
    if (e <= start || s >= end) continue;
    const from = s < start ? start : s;
    const to = e > end ? end : e;
    if (inBackground(event.calendario)) back.push({ event, from, to });
    else if (to - from >= 23 * 3_600_000) allDay.push(event);
    else timed.push({ event, from, to });
  }
  return { allDay, back, timed: layout(timed.sort((a, b) => a.from - b.from || b.to - a.to)) };
}

/** Side-by-side lanes for overlapping events, like any calendar app. */
function layout(pieces) {
  let cluster = [];
  let lanes = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const piece of cluster) piece.lanes = lanes.length;
    cluster = [];
    lanes = [];
  };
  for (const piece of pieces) {
    if (piece.from >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    let lane = lanes.findIndex((end) => end <= piece.from);
    if (lane === -1) lane = lanes.push(null) - 1;
    lanes[lane] = piece.to;
    piece.lane = lane;
    cluster.push(piece);
    clusterEnd = Math.max(clusterEnd, piece.to);
  }
  flush();
  return pieces;
}

/** 07:00–23:00 unless an event starts earlier or ends later; overnight carry-overs don't stretch it. */
function hourRange(perDay) {
  let first = 7;
  let last = 23;
  for (const { timed } of perDay) {
    for (const { event, from, to } of timed) {
      if (from.getTime() === new Date(event.inicio).getTime()) first = Math.min(first, from.getHours());
      if (to.getTime() === new Date(event.fin).getTime()) last = Math.max(last, to.getHours() + (to.getMinutes() ? 1 : 0) || 24);
    }
  }
  return [first, Math.min(24, last)];
}

function minutesInto(date, day) {
  return (date - localDate(day)) / 60_000;
}

function eventButton(piece, day, [firstHour, lastHour], now) {
  const { event, from, to } = piece;
  const startMin = Math.max(minutesInto(from, day), firstHour * 60);
  const endMin = Math.min(Math.max(minutesInto(to, day), startMin + 15), lastHour * 60);
  const top = Math.min(((startMin - firstHour * 60) / 60) * HOUR, (lastHour - firstHour) * HOUR - MIN_EVENT);
  const height = Math.max(MIN_EVENT, ((endMin - startMin) / 60) * HOUR - 2);
  const el = h('button', {
    type: 'button',
    class: `event${event.tarea ? ` block${isDone(event) ? ' done' : ''}` : event.libre ? ' free' : ''}`
      + `${to < now ? ' past' : ''}${height < 40 ? ' compact' : ''}`,
    dataset: { fin: String(to.getTime()) },
    'aria-label': `${event.tarea ? 'Bloque: ' : ''}${event.titulo}, ${timeOf.format(from)} a ${timeOf.format(to)}`,
    onclick: () => (event.tarea ? editBlock(event) : showEvent(event)),
  }, h('strong', {}, event.titulo), h('span', {}, `${timeOf.format(from)}–${timeOf.format(to)}`));
  el.style.top = `${top}px`;
  el.style.height = `${height}px`;
  el.style.left = `calc(${(piece.lane / piece.lanes) * 100}% + 2px)`;
  el.style.width = `calc(${100 / piece.lanes}% - 4px)`;
  el.style.setProperty('--c', event.color);
  return el;
}

function band({ event, from, to }, day, [firstHour, lastHour]) {
  const startMin = Math.max(minutesInto(from, day), firstHour * 60);
  const endMin = Math.min(minutesInto(to, day), lastHour * 60);
  const el = h('div', { class: 'band', 'aria-hidden': 'true' },
    h('span', {}, `${event.titulo} · ${timeOf.format(new Date(event.inicio))}–${timeOf.format(new Date(event.fin))}`));
  el.style.top = `${((startMin - firstHour * 60) / 60) * HOUR}px`;
  el.style.height = `${Math.max(0, ((endMin - startMin) / 60) * HOUR)}px`;
  el.style.setProperty('--c', event.color);
  if (endMin <= startMin) el.hidden = true;
  return el;
}

function allDayChip(event) {
  const el = h('button', {
    type: 'button', class: `chip-event${event.libre ? ' free' : ''}`, onclick: () => showEvent(event),
  }, event.titulo);
  el.style.setProperty('--c', event.color);
  return el;
}

function taskChip(task) {
  return h('button', { type: 'button', class: 'chip-task', onclick: () => openTask(task.id), title: task.siguiente || '' },
    h('span', { class: 'dot' }), task.titulo);
}

function render() {
  const days = narrow.matches ? [state.day] : Array.from({ length: 7 }, (_, i) => addDays(state.monday, i));
  HOUR = hourHeight();
  const today = todayLocal();
  const now = new Date();
  const events = (state.data?.eventos ?? []).filter(visible);
  const tasks = state.tasks().filter((t) => t.fecha && OPEN_TASKS(t));
  const perDay = days.map((day) => piecesFor(day, events));
  const [firstHour, lastHour] = hourRange(perDay);
  state.hours = [firstHour, lastHour];
  state.dirty = false;

  // No toolbar: the week controls live in a small month button, in the corner of the day header
  // (or at the start of the day strip on a phone).
  $('#cal-days').replaceChildren(menuButton(days), ...Array.from({ length: 7 }, (_, i) => {
    const day = addDays(state.monday, i);
    const date = localDate(day);
    return h('button', {
      type: 'button', class: day === today ? 'today' : null, 'aria-pressed': String(day === state.day),
      onclick: () => { state.day = day; render(); },
    }, h('span', {}, weekdayShort.format(date).replace('.', '')), h('strong', {}, date.getDate()));
  }));

  const root = $('#calendar');
  const cols = `var(--gutter) repeat(${days.length}, minmax(0, 1fr))`;
  const head = h('div', { class: 'grid-head' }, menuButton(days), days.map((day) => {
    const date = localDate(day);
    return h('div', { class: `day-head${day === today ? ' today' : ''}${day < today ? ' past' : ''}` },
      h('span', {}, weekdayShort.format(date).replace('.', '')), h('strong', {}, date.getDate()));
  }));
  const allDay = h('div', { class: 'grid-allday' }, h('span', { class: 'gutter-label month' }, monthLabel(days)), days.map((day, i) => h('div', {
    class: `allday-cell${day === today ? ' today' : ''}`,
  }, perDay[i].allDay.map(allDayChip), tasks.filter((t) => t.fecha === day && !perDay[i].timed.some((p) => p.event.tarea === t.id))
    .map(taskChip))));

  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const body = h('div', { class: 'grid-body' }, h('div', { class: 'grid-inner' },
    h('div', { class: 'hours' }, hours.map((hour) => h('span', {}, `${String(hour).padStart(2, '0')}:00`))),
    days.map((day, i) => {
      const column = h('div', { class: `day-col${day === today ? ' today' : ''}` },
        perDay[i].back.map((piece) => band(piece, day, [firstHour, lastHour])),
        perDay[i].timed.map((piece) => eventButton(piece, day, [firstHour, lastHour], now)));
      // A tap on a free hour reserves a work block there, rounded down to the half hour.
      column.addEventListener('click', (event) => {
        if (event.target !== column) return;
        const y = event.clientY - column.getBoundingClientRect().top;
        newBlock({ day, start: firstHour * 60 + Math.floor((y / HOUR) * 2) * 30 });
      });
      return column;
    })));
  body.firstChild.style.height = `${hours.length * HOUR}px`;
  for (const row of [head, allDay, body.firstChild]) row.style.gridTemplateColumns = cols;
  body.addEventListener('scroll', () => { state.scroll = body.scrollTop; }, { passive: true });

  const status = state.loading && !state.data ? h('p', { class: 'loading' }, 'Cargando el calendario…') : null;
  root.replaceChildren(...[status, head, allDay, body].filter(Boolean));
  moveNow();

  // The same week keeps its scroll (kept in state: a hidden panel forgets it); another starts near now.
  const key = `${state.monday}|${days.length === 1 ? state.day : ''}`;
  if (state.scrolledFor === key) body.scrollTop = state.scroll;
  else {
    const visibleToday = days.includes(today);
    const target = visibleToday ? now.getHours() - 1 : Math.max(firstHour, 8);
    body.scrollTop = Math.max(0, (target - firstHour) * HOUR);
    state.scrolledFor = key;
  }
  state.scroll = body.scrollTop;
}

/** Once a minute: the red line moves and finished events fade, without rebuilding the week. */
function moveNow() {
  const root = $('#calendar');
  const now = new Date();
  const [firstHour, lastHour] = state.hours;
  const column = root.querySelector('.day-col.today');
  const minutes = column ? minutesInto(now, todayLocal()) : -1;
  let line = column?.querySelector('.now');
  if (minutes < firstHour * 60 || minutes > lastHour * 60) line?.remove();
  else {
    if (!line) column.append(line = h('div', { class: 'now', 'aria-hidden': 'true' }));
    line.style.top = `${((minutes - firstHour * 60) / 60) * HOUR}px`;
  }
  for (const el of root.querySelectorAll('.event:not(.past)')) {
    if (Number(el.dataset.fin) <= now.getTime()) el.classList.add('past');
  }
}

async function load({ refresh = false } = {}) {
  const monday = state.monday;
  state.loading = true;
  if (state.data?.desde !== monday) {
    // Another week: the copy in memory paints at once (or "Cargando…") while the server answers.
    state.data = cachedWeek(monday);
    render();
  }
  let changed = false;
  try {
    const data = await loadWeek(monday, { refresh });
    if (monday !== state.monday) return;
    changed = !state.data || !data.huella || data.huella !== state.data.huella;
    state.data = data;
    state.stale = false;
    if (data.errores?.length) notify(`Parte del calendario no se ha podido leer: ${data.errores.join(' · ')}`);
    else if (refresh) notify('Calendario actualizado');
  } catch (err) {
    if (monday === state.monday) notify(err.message);
  } finally {
    state.loading = false;
  }
  if (monday !== state.monday) return;
  // Rebuilding the week is the expensive part on the tablet: only when something changed.
  if (changed || state.dirty || !state.data) render();
  prefetchWeeks([addDays(monday, 7), addDays(monday, -7)]);
}


const DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.5" r="1.7"/></svg>';
let openMenu = null;

function menuButton(days) {
  const away = !days.includes(todayLocal());
  const button = html('button', {
    type: 'button', class: `cal-menu${away ? ' away' : ''}`, 'aria-haspopup': 'menu', title: 'Más opciones',
    'aria-label': `Más opciones del calendario, ${rangeLabel(days)}`,
  }, DOTS);
  button.addEventListener('click', () => toggleMenu(button, days));
  return button;
}

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', closeOutside, true);
  document.removeEventListener('keydown', closeOnEscape);
}
function closeOutside(event) {
  if (!openMenu?.contains(event.target) && !event.target.closest?.('.cal-menu')) closeMenu();
}
function closeOnEscape(event) {
  if (event.key === 'Escape') closeMenu();
}

/** The ⋮ dropdown: week navigation, refresh and which calendars to show. */
function toggleMenu(anchor, days) {
  if (openMenu) return closeMenu();
  const unit = narrow.matches ? 'Día' : 'Semana';
  const item = (label, run) => h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); run(); } }, label);
  const menu = h('div', { class: 'popover', role: 'menu' },
    h('p', { class: 'popover-title' }, capital(rangeLabel(days))),
    item('Hoy', () => goTo(mondayOf(todayLocal()), todayLocal())),
    item(`${unit} anterior`, () => step(-1)),
    item(`${unit} siguiente`, () => step(1)),
    h('hr'),
    item('Actualizar', () => load({ refresh: true })),
    item('Calendarios…', showFilter));
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(box.bottom + 4)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
  openMenu = menu;
  document.addEventListener('pointerdown', closeOutside, true);
  document.addEventListener('keydown', closeOnEscape);
}

const monthName = fmt({ month: 'short' });

/** "oct", or "oct–nov" for a week across two months. */
function monthLabel(days) {
  const [first, last] = [days[0], days.at(-1)].map((day) => monthName.format(localDate(day)).replace('.', ''));
  return first === last ? first : `${first}–${last}`;
}

function goTo(monday, day = monday) {
  state.monday = monday;
  state.day = day;
  load();
}

/** Next or previous week (a day on a phone). */
function step(direction) {
  if (narrow.matches) {
    const day = addDays(state.day, direction);
    const monday = mondayOf(day);
    if (monday === state.monday) {
      state.day = day;
      render();
    } else goTo(monday, day);
  } else goTo(addDays(state.monday, 7 * direction));
}

function showEvent(event) {
  const dialog = $('#detail');
  const when = event.diaCompleto
    ? capital(longDay.format(localDate(event.inicio))) + (addDays(event.inicio, 1) < event.fin ? ` – ${longDay.format(localDate(addDays(event.fin, -1)))}` : '')
    : `${capital(longDay.format(new Date(event.inicio)))} · ${timeOf.format(new Date(event.inicio))}–${timeOf.format(new Date(event.fin))}`;
  const calendar = state.data?.calendarios.find((c) => c.id === event.calendario);
  const facts = [['Cuándo', when], ['Calendario', calendar?.nombre], ['Dónde', event.ubicacion],
    ['Disponibilidad', event.libre ? 'Libre: no bloquea tu agenda' : null]].filter(([, value]) => value);
  const title = h('h2', { class: 'event-title' }, event.titulo);
  title.style.setProperty('--c', event.color);
  dialog.replaceChildren(h('div', { class: 'form' },
    h('div', { class: 'row between' }, title,
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Cerrar', onclick: () => dialog.close() }, '×')),
    h('dl', { class: 'facts' }, facts.map(([term, value]) => [h('dt', {}, term), h('dd', {}, value)])),
    event.enlace ? h('div', { class: 'row end' },
      h('a', { class: 'button', href: event.enlace, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir en Google Calendar')) : null));
  dialog.showModal();
}

function showFilter() {
  const dialog = $('#ask');
  const list = state.data?.calendarios ?? [];
  const accounts = [...new Set(list.map((c) => c.cuenta))];
  const used = new Set((state.data?.eventos ?? []).map((e) => e.calendario));
  const MODES = [['ver', 'Ver'], ['fondo', 'Fondo'], ['oculto', 'Ocultar']];
  const modeOf = (c) => (state.hidden.has(c.id) ? 'oculto' : inBackground(c.id) ? 'fondo' : 'ver');
  const option = (c) => {
    const swatch = h('span', { class: 'swatch' });
    swatch.style.setProperty('--c', c.color);
    const modes = h('div', { class: 'segmented', role: 'group', 'aria-label': `Cómo se ve ${c.nombre}` });
    const paint = () => {
      for (const button of modes.children) button.setAttribute('aria-pressed', String(button.dataset.mode === modeOf(c)));
    };
    modes.append(...MODES.map(([mode, text]) => h('button', {
      type: 'button', dataset: { mode },
      onclick: () => {
        if (mode === 'oculto') state.hidden.add(c.id);
        else state.hidden.delete(c.id);
        if (mode !== 'oculto') state.fondo[c.id] = mode === 'fondo';
        store('tablero.calendariosOcultos', [...state.hidden]);
        store('tablero.calendariosFondo', state.fondo);
        paint();
        render();
      },
    }, text)));
    paint();
    return h('div', { class: `toggle${used.has(c.id) ? '' : ' unused'}` }, swatch, h('span', { class: 'name' }, c.nombre), modes);
  };
  dialog.replaceChildren(h('div', { class: 'form' },
    h('div', { class: 'row between' }, h('h2', {}, 'Calendarios'),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Cerrar', onclick: () => dialog.close() }, '×')),
    list.length ? accounts.map((account) => h('section', { class: 'toggles' }, h('h3', {}, account),
      list.filter((c) => c.cuenta === account).map(option)))
      : h('p', { class: 'hint' }, 'Aún no he podido cargar la lista de calendarios.'),
    h('p', { class: 'hint' }, '«Fondo» lo pinta como una franja que no ocupa sitio. Se recuerda en este dispositivo; los que no tienen nada esta semana salen atenuados.')));
  dialog.showModal();
}

export function initCalendar({ tasks }) {
  state.tasks = tasks;
  state.hidden = new Set(remember('tablero.calendariosOcultos', []));
  state.fondo = remember('tablero.calendariosFondo', {});
  // A horizontal swipe changes the week (the day on a phone); vertical moves keep scrolling the hours.
  onSideSwipe($('#calendar'), step);
  // On the Mac, the arrow keys move between weeks.
  document.addEventListener('keydown', (event) => {
    if ($('#panel-calendario').hidden || document.querySelector('dialog[open]')) return;
    if (event.target.closest?.('input, textarea, select')) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });
  narrow.addEventListener('change', () => { state.scrolledFor = null; render(); });
  short.addEventListener('change', () => render());
}

export function showCalendar() {
  const body = $('#calendar .grid-body');
  if (!state.data || state.data.desde !== state.monday || state.stale) load();
  else if (state.dirty || !body) render();
  else {
    // Back to a week already drawn: no rebuild, only the line and the scroll it had.
    moveNow();
    if (body.scrollTop !== state.scroll) body.scrollTop = state.scroll;
  }
  clearInterval(state.timer);
  // Keeps a wall tablet current: new events, the "now" line and the day rolling over at midnight.
  state.timer = setInterval(() => {
    if ($('#panel-calendario').hidden) return clearInterval(state.timer);
    const today = todayLocal();
    if (today !== state.seenToday) {
      // After midnight, follow the new day if you were looking at the old one.
      const wasCurrent = state.monday === mondayOf(state.seenToday);
      state.seenToday = today;
      return wasCurrent ? goTo(mondayOf(today), today) : render();
    }
    if (Date.now() - Date.parse(state.data?.actualizado || 0) > REFRESH_EVERY) load();
    moveNow();
  }, 60_000);
}

export function refreshCalendar({ tasksOnly = false } = {}) {
  if ($('#panel-calendario').hidden) {
    if (tasksOnly) state.dirty = true;
    else state.stale = true;
    return;
  }
  if (tasksOnly) return render();
  // Cards may have changed along with it (a block written or a task closed from here): repaint
  // even if Google did not change.
  state.dirty = true;
  load();
}
