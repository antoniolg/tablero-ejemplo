// Home panel: the day at a glance on the wall tablet. On top, what can be read from across the room
// (what comes next, the sky, how much AI is left); below, three short lists (agenda, meals, tasks).
import { $, addDays, api, h, html, mondayOf, todayLocal } from './dom.js';
import { calendarMode } from './calendar.js';
import { isDone } from './blocks.js';
import { openTask } from './tasks.js';
import { weatherIcon } from './weather-icons.js';
import { cachedWeek, loadWeek } from './weeks.js';

const state = {
  tasks: () => [], meals: new Map(), weather: null, weatherError: '', ai: null, day: null, timers: [],
};
const fmt = (options) => new Intl.DateTimeFormat('es-ES', options);
const timeOf = fmt({ hour: '2-digit', minute: '2-digit' });
const weekdayTime = fmt({ weekday: 'short', hour: '2-digit', minute: '2-digit' });
const localDate = (day) => new Date(`${day}T00:00:00`);
const sameDay = (a, b) => a.toDateString() === b.toDateString();
const CLOSED = ['hecha', 'soltada'];
const visible = () => !$('#panel-inicio').hidden;

/** "25 min", "1 h 05 min", "3 d 21 h". */
function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${String(minutes % 60).padStart(2, '0')} min` : ''}`;
  return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

/** "13:29" today, "sáb 14:59" another day. */
const when = (date, now) => (sameDay(date, now) ? timeOf.format(date) : weekdayTime.format(date).replace('.', '').replace(',', ''));

// ---------- data ----------

async function loadCalendar() {
  const today = todayLocal();
  const mondays = [...new Set([mondayOf(today), mondayOf(addDays(today, 1))])];
  // The agenda shows what it has; the calendar panel reports errors.
  await Promise.all(mondays.map((monday) => loadWeek(monday).catch(() => null)));
}

async function loadMeals() {
  const today = todayLocal();
  await Promise.all([today, addDays(today, 1)].map(async (day) => {
    try {
      const week = await api(`/api/comidas?desde=${day}`);
      for (const meal of week.dias) state.meals.set(meal.fecha, meal);
    } catch {
      // Weekends are not planned and the panel says so.
    }
  }));
}

async function loadWeather() {
  try {
    state.weather = await api('/api/tiempo');
    state.weatherError = '';
  } catch (err) {
    state.weatherError = err.message;
  }
}

async function loadAi() {
  state.ai = await api('/api/ia').catch(() => null);
}

/** Events of a day on calendars shown normally on this device. */
function eventsOn(day) {
  const week = cachedWeek(mondayOf(day));
  if (!week) return { allDay: [], timed: [] };
  const shown = new Set(week.calendarios.filter((c) => calendarMode(c) === 'ver').map((c) => c.id));
  const start = localDate(day);
  const end = localDate(addDays(day, 1));
  const allDay = [];
  const timed = [];
  for (const event of week.eventos) {
    // A work block whose task is already done is not something left to do today (the calendar keeps it, struck through).
    if (!shown.has(event.calendario) || (event.tarea && isDone(event))) continue;
    if (event.diaCompleto) {
      if (event.inicio <= day && day < event.fin) allDay.push(event);
    } else if (new Date(event.inicio) < end && new Date(event.fin) > start) {
      timed.push(event);
    }
  }
  timed.sort((a, b) => a.inicio.localeCompare(b.inicio));
  return { allDay, timed };
}

const tinted = (el, color) => {
  el.style.setProperty('--c', color);
  return el;
};

// ---------- what comes next ----------

function nextBlock(now) {
  const today = todayLocal();
  const event = [...eventsOn(today).timed, ...eventsOn(addDays(today, 1)).timed].find((e) => new Date(e.fin) > now);
  if (!event) {
    return h('section', { class: 'home-next' },
      h('p', { class: 'home-next-time' }, 'Libre'),
      h('p', { class: 'home-next-meta' }, 'Nada en el calendario hasta pasado mañana.'));
  }
  const from = new Date(event.inicio);
  const to = new Date(event.fin);
  const ongoing = from <= now;
  const meta = ongoing ? `Termina en ${span(to - now)}, a las ${timeOf.format(to)}`
    : `${sameDay(from, now) ? 'En' : 'Mañana, en'} ${span(from - now)}. Hasta las ${timeOf.format(to)}`;
  const el = h('section', { class: `home-next${event.tarea ? ' link' : ''}` },
    h('p', { class: 'home-next-time' }, ongoing ? 'Ahora' : timeOf.format(from)),
    tinted(h('p', { class: 'home-next-title' }, h('span', { class: 'home-dot' }), event.titulo), event.color),
    h('p', { class: 'home-next-meta' }, meta));
  if (event.tarea) el.addEventListener('click', () => openTask(event.tarea));
  return el;
}

// ---------- weather ----------

const SKY = {
  sol: 'sol', 'sol-nubes': 'claro', nubes: 'nubes', niebla: 'niebla', lluvia: 'lluvia', tormenta: 'tormenta',
  nieve: 'nieve', luna: 'noche', 'luna-nubes': 'noche',
};

function weatherBlock() {
  const w = state.weather;
  if (!w) {
    return h('section', { class: 'home-weather sky-nubes' },
      h('p', { class: 'home-weather-today' }, state.weatherError || 'Cargando el tiempo…'));
  }
  const sky = w.actual.dia ? SKY[w.hoy.icono] : 'noche';
  const range = (d) => `entre ${d.min}° y ${d.max}°`;
  return h('section', { class: `home-weather sky-${sky ?? 'nubes'}`, title: `Tiempo en ${w.lugar}` },
    h('div', { class: 'home-weather-now' },
      h('p', { class: 'home-temp' }, `${w.actual.temperatura}°`),
      weatherIcon(w.hoy.icono, 'big')),
    h('p', { class: 'home-weather-today' }, `${w.hoy.texto}, ${range(w.hoy)}`),
    w.hoy.aviso ? h('p', { class: 'home-weather-alert' }, w.hoy.aviso) : null,
    w.manana ? h('p', { class: 'home-weather-tomorrow' }, weatherIcon(w.manana.icono, 'small'),
      h('span', {}, `Mañana ${w.manana.texto.toLowerCase()}, ${range(w.manana)}`)) : null);
}

// ---------- AI plan limits ----------

const R = 24;
const C = 2 * Math.PI * R;

/** Where the arc would end if the window were spent evenly: a short tick across the ring. */
function paceTick(expectedUsed) {
  const angle = (((100 - expectedUsed) / 100) * 360 - 90) * (Math.PI / 180);
  const at = (r) => `${(30 + r * Math.cos(angle)).toFixed(1)} ${(30 + r * Math.sin(angle)).toFixed(1)}`;
  return `<path class="tick" d="M${at(R - 6)}L${at(R + 6)}"/>`;
}

/** A ring with what is left of a window; the arc and the colour say how much. */
function ring(window, now) {
  const left = 100 - window.usado;
  const level = window.usado >= 85 ? 'high' : window.usado >= 60 ? 'mid' : 'low';
  const reset = window.reinicio ? new Date(window.reinicio) : null;
  const arc = (left / 100) * C;
  // A tick marks the even pace for the window: if the arc stops short of it, you are spending faster.
  const tick = typeof window.ritmo?.esperado === 'number' ? paceTick(window.ritmo.esperado) : '';
  const svg = html('span', { class: `home-ring ${level}`, 'aria-hidden': 'true' },
    `<svg viewBox="0 0 60 60"><circle class="track" cx="30" cy="30" r="${R}"/>`
    + `<circle class="arc" cx="30" cy="30" r="${R}" stroke-dasharray="${arc.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 30 30)"/>${tick}</svg>`);
  svg.append(h('strong', {}, `${left}%`));
  return h('figure', { class: 'home-ring-box', 'aria-label': `${window.etiqueta}: queda ${left} %${reset ? `, se reinicia ${when(reset, now)}` : ''}` },
    svg,
    h('figcaption', {}, h('span', {}, window.etiqueta === 'Semana' ? 'Semana' : '5 h'), reset ? h('span', {}, when(reset, now)) : null));
}

function aiBlock(now) {
  const ai = state.ai;
  if (!ai?.disponible) {
    return h('section', { class: 'home-ai' },
      h('p', { class: 'home-muted' }, 'Sin datos de uso: abre CodexBar en el Mac para que los recoja.'));
  }
  return h('section', { class: 'home-ai' }, ai.proveedores.map((p) => {
    const week = p.ventanas.find((v) => v.etiqueta === 'Semana');
    const over = week?.ritmo && typeof week.ritmo.esperado === 'number' ? week.usado - week.ritmo.esperado : null;
    const runsOut = week?.ritmo && !week.ritmo.aguanta && week.ritmo.seAcabaEn ? `: a este ritmo se acaba en ${span(week.ritmo.seAcabaEn * 1000)}` : '';
    return h('div', { class: 'home-ai-provider' },
      h('p', { class: 'home-ai-name' }, p.nombre, p.plan ? h('span', {}, p.plan.replace(/^Claude /, '')) : null),
      h('div', { class: 'home-ai-rings' }, p.ventanas.map((v) => ring(v, now))),
      over > 0 ? h('p', { class: 'home-ai-warning' }, `Semana: ${over} % por encima del ritmo${runsOut}`)
        : over !== null && over < 0 ? h('p', { class: 'home-ai-ok' }, `Semana: ${-over} % por debajo del ritmo`) : null);
  }));
}

// ---------- agenda, meals, tasks ----------

function agendaItem(event, now) {
  const from = new Date(event.inicio);
  const ongoing = !event.diaCompleto && from <= now && new Date(event.fin) > now;
  const li = tinted(h('li', { class: `${ongoing ? 'ongoing' : ''}${event.tarea ? ' link' : ''}`.trim() || null },
    h('time', {}, event.diaCompleto ? 'Todo el día' : timeOf.format(from)), h('span', {}, event.titulo)), event.color);
  if (event.tarea) li.addEventListener('click', () => openTask(event.tarea));
  return li;
}

function agendaPanel(now) {
  const today = todayLocal();
  const hoy = eventsOn(today);
  const remaining = [...hoy.allDay, ...hoy.timed.filter((e) => new Date(e.fin) > now)];
  const manana = eventsOn(addDays(today, 1));
  const tomorrow = [...manana.allDay, ...manana.timed];
  return h('section', { class: 'home-panel home-agenda' },
    h('h2', {}, 'Hoy'),
    remaining.length ? h('ul', { class: 'home-events' }, remaining.slice(0, 6).map((e) => agendaItem(e, now)))
      : h('p', { class: 'home-muted' }, hoy.timed.length ? 'Ya no queda nada más hoy.' : 'Día libre.'),
    h('h2', {}, 'Mañana'),
    tomorrow.length ? h('ul', { class: 'home-events tomorrow' }, tomorrow.slice(0, 3).map((e) => agendaItem(e, now)))
      : h('p', { class: 'home-muted' }, 'Nada en el calendario.'));
}

const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z"/></svg>';

function mealsPanel() {
  const today = todayLocal();
  const tomorrow = addDays(today, 1);
  const weekend = (day) => localDate(day).getDay() % 6 === 0;
  const meal = state.meals.get(today);
  const dish = (icon, label, text) => h('div', { class: `home-meal${text ? '' : ' empty'}` },
    html('span', { class: 'home-meal-icon' }, icon),
    h('div', {}, h('p', { class: 'home-meal-label' }, label), h('p', { class: 'home-meal-dish' }, text || 'Sin decidir')));
  const next = state.meals.get(tomorrow);
  const nextText = weekend(tomorrow) ? 'Mañana es fin de semana.'
    : next && (next.comida || next.cena) ? `Mañana: ${[next.comida, next.cena].filter(Boolean).join(' y ')}.` : 'Mañana, sin decidir.';
  const el = h('section', { class: 'home-panel home-meals link' },
    weekend(today) ? h('p', { class: 'home-muted' }, 'Fin de semana: no hay plan de comidas.')
      : [dish(SUN, 'Comida', meal?.comida), dish(MOON, 'Cena', meal?.cena)],
    h('p', { class: 'home-meal-tomorrow' }, nextText));
  el.addEventListener('click', () => { location.hash = '#comidas'; });
  return el;
}

function counter(value, label) {
  return h('div', { class: `home-count${value ? '' : ' zero'}` }, h('strong', {}, value), h('span', {}, label));
}

function tasksPanel() {
  const tasks = state.tasks().filter((t) => !CLOSED.includes(t.estado) && t.columna !== 'archivo');
  const approve = tasks.filter((t) => t.estado === 'tu-ok');
  const due = tasks.filter((t) => t.avisos?.some((f) => f.tipo === 'limite'));
  const today = todayLocal();
  const blocks = tasks.filter((t) => t.bloque?.inicio.slice(0, 10) === today);
  const inbox = tasks.filter((t) => t.columna === 'bandeja');
  // From the inbox, only what has a reason to be done now (a positive score, with its reason): a new
  // card with nothing pressing is not urgent just because the list has room.
  const pressing = inbox.filter((t) => (t.prioridad?.puntos ?? 0) > 0).sort((a, b) => b.prioridad.puntos - a.prioridad.puntos);
  const picks = [];
  const add = (task, note) => {
    if (picks.length < 3 && !picks.some((p) => p.task.id === task.id)) picks.push({ task, note });
  };
  approve.forEach((t) => add(t, 'Espera tu OK'));
  due.forEach((t) => add(t, t.avisos.find((f) => f.tipo === 'limite').texto));
  pressing.forEach((t) => add(t, t.prioridad.motivo));
  return h('section', { class: 'home-panel home-tasks' },
    h('div', { class: 'home-counts' },
      counter(approve.length, 'para aprobar'), counter(due.length, 'vencen pronto'), counter(blocks.length, 'bloques hoy')),
    picks.length ? h('ul', { class: 'home-picks' }, picks.map(({ task, note }) => h('li', { onclick: () => openTask(task.id) },
      h('span', {}, task.titulo), note ? h('em', {}, note) : null)))
      : nothingPressing(inbox, today));
}

/** Nothing urgent: say so, and how much is waiting in the inbox to be planned (parked cards aside). */
function nothingPressing(inbox, today) {
  const toPlan = inbox.filter((t) => t.estado !== 'mas-adelante' && !(t.revisar && t.revisar.slice(0, 10) > today)).length;
  const waiting = toPlan
    ? h('p', { class: 'home-quiet-inbox link' }, `${toPlan} ${toPlan === 1 ? 'tarea' : 'tareas'} en la bandeja por planificar`)
    : null;
  waiting?.addEventListener('click', () => { location.hash = '#tareas'; });
  return h('div', { class: 'home-quiet' }, h('p', { class: 'home-muted' }, 'Nada urgente.'), waiting);
}

// ---------- panel ----------

function render() {
  if (!visible()) return;
  const now = new Date();
  // Three columns that stack on their own, so the agenda starts right under what comes next.
  const columns = [[nextBlock(now), agendaPanel(now)], [weatherBlock(), mealsPanel()], [aiBlock(now), tasksPanel()]];
  const root = $('#home');
  if (root.children.length !== columns.length) {
    root.replaceChildren(...columns.map((sections) => h('div', { class: 'home-col' }, sections)));
    return;
  }
  // Only the sections that changed are swapped: most ticks change nothing, and nothing is laid out again.
  columns.forEach((sections, i) => sections.forEach((section, j) => {
    const old = root.children[i].children[j];
    if (!old) root.children[i].append(section);
    else if (!old.isEqualNode(section)) old.replaceWith(section);
  }));
}

async function loadAll() {
  state.day = todayLocal();
  await Promise.all([loadCalendar(), loadMeals(), loadWeather(), loadAi()]);
  render();
}

export function initHome({ tasks }) {
  state.tasks = tasks;
}

export function showHome() {
  render();
  loadAll();
  if (state.timers.length) return;
  const every = (ms, run) => state.timers.push(setInterval(() => {
    if (visible()) run();
  }, ms));
  every(30_000, () => (state.day === todayLocal() ? render() : loadAll()));
  every(60_000, () => Promise.all([loadAi(), state.weather ? null : loadWeather()]).then(render));
  every(5 * 60_000, () => Promise.all([loadCalendar(), loadWeather()]).then(render));
}

/** Server-sent changes: cards (tasks), meals or blocks written from here. */
export function refreshHome(kind) {
  if (!visible()) return;
  if (kind === 'comidas') loadMeals().then(render);
  else if (kind === 'calendario') loadCalendar().then(render);
  else render();
}
