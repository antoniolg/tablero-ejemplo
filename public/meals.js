// Meals panel: lunch and dinner for each day of the week, filled with a tap.
import { $, addDays, api, h, mondayOf, notify, onSwipe, todayLocal } from './dom.js';
import { draggable, dragging } from './drag.js';

const SLOTS = [['comida', 'Comida'], ['cena', 'Cena']];
// On Saturday and Sunday the week to plan is the next one.
const planningMonday = () => {
  const today = todayLocal();
  const weekend = new Date(`${today}T12:00:00`).getDay() % 6 === 0;
  return mondayOf(weekend ? addDays(today, 2) : today);
};
const state = { monday: planningMonday(), data: null };
const fmt = (options) => new Intl.DateTimeFormat('es-ES', options);
const weekday = fmt({ weekday: 'long' });
const dayMonth = fmt({ day: 'numeric', month: 'short' });
const longDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const localDate = (day) => new Date(`${day}T00:00:00`);
const capital = (text) => text[0].toUpperCase() + text.slice(1);

function render() {
  const root = $('#meals');
  const { data } = state;
  const last = addDays(state.monday, 4);
  $('#meals-range').textContent = `${dayMonth.format(localDate(state.monday))} – ${dayMonth.format(localDate(last))}`;
  if (!data) return root.replaceChildren(h('p', { class: 'loading' }, 'Cargando…'));
  const today = todayLocal();
  root.replaceChildren(...data.dias.map((day) => {
    const date = localDate(day.fecha);
    return h('article', { class: `meal-day${day.fecha === today ? ' today' : ''}${day.fecha < today ? ' past' : ''}` },
      h('header', {}, h('span', {}, capital(weekday.format(date))), h('strong', {}, date.getDate())),
      SLOTS.map(([slot, label]) => {
        const button = h('button', {
          type: 'button', class: `meal-slot${day[slot] ? '' : ' empty'}`, onclick: () => edit(day, slot),
          dataset: { fecha: day.fecha, hueco: slot },
          'aria-label': `${label} del ${longDay.format(date)}: ${day[slot] || 'sin decidir'}`,
        }, h('span', { class: 'slot-label' }, label), h('span', { class: 'dish' }, day[slot] || 'Añadir'));
        if (day[slot]) draggable(button, { targets: '.meal-slot', onDrop: (target) => swap(button.dataset, target.dataset) });
        return button;
      }));
  }));
  if (state.monday === mondayOf(today) && window.matchMedia('(max-width: 760px)').matches) {
    root.querySelector('.today')?.scrollIntoView({ block: 'start' });
  }
}

async function load() {
  const monday = state.monday;
  try {
    const data = await api(`/api/comidas?desde=${monday}`);
    if (monday === state.monday) state.data = data;
  } catch (err) {
    notify(`No he podido cargar las comidas: ${err.message}`);
  }
  if (monday === state.monday) render();
}

async function save(day, slot, value) {
  try {
    state.data = await api(`/api/comidas/${day.fecha}`, { method: 'PATCH', body: { [slot]: value } });
    notify(value ? 'Guardado' : 'Quitado');
  } catch (err) {
    notify(err.message);
  }
  render();
}

/** Drops a dish on another slot; if that one had something, the two swap. */
async function swap(from, to) {
  const a = state.data.dias.find((d) => d.fecha === from.fecha);
  const b = state.data.dias.find((d) => d.fecha === to.fecha);
  const moved = a[from.hueco];
  const displaced = b[to.hueco];
  [a[from.hueco], b[to.hueco]] = [displaced, moved];
  render(); // right away; the server answer confirms it
  try {
    state.data = await api('/api/comidas/mover', {
      method: 'POST', body: { de: { fecha: from.fecha, hueco: from.hueco }, a: { fecha: to.fecha, hueco: to.hueco } },
    });
    notify(displaced ? `Intercambiados: ${moved} ↔ ${displaced}` : `${moved} movido`);
  } catch (err) {
    notify(err.message);
    return load();
  }
  return render();
}

function edit(day, slot) {
  const dialog = $('#ask');
  const label = SLOTS.find(([id]) => id === slot)[1];
  const input = h('input', { name: 'plato', value: day[slot], placeholder: '¿Qué vas a preparar?', autocomplete: 'off', enterkeyhint: 'done' });
  const pick = (value) => {
    dialog.close();
    save(day, slot, value);
  };
  const recent = (state.data?.recientes ?? []).filter((dish) => dish !== day[slot]);
  const form = h('form', { method: 'dialog', class: 'form' },
    h('div', { class: 'row between' },
      h('h2', {}, `${label} · ${longDay.format(localDate(day.fecha))}`),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Cerrar', onclick: () => dialog.close() }, '×')),
    input,
    recent.length ? h('section', {}, h('h3', {}, 'Ya lo has hecho otras veces'),
      h('div', { class: 'pills big' }, recent.map((dish) => h('button', { type: 'button', onclick: () => pick(dish) }, dish)))) : null,
    h('div', { class: 'row end' },
      day[slot] ? h('button', { type: 'button', class: 'danger', onclick: () => pick('') }, 'Quitar') : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancelar'),
      h('button', { type: 'submit', class: 'primary' }, 'Guardar')));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value === day[slot]) return dialog.close();
    pick(value);
  });
  dialog.replaceChildren(form);
  dialog.showModal();
  // On a touch screen the keyboard would cover the suggestions; there, typing starts with a tap.
  if (!window.matchMedia('(pointer: coarse)').matches) input.focus();
}

function goTo(monday) {
  state.monday = monday;
  state.data = null;
  render();
  load();
}

export function initMeals() {
  $('#meals-prev').addEventListener('click', () => goTo(addDays(state.monday, -7)));
  $('#meals-next').addEventListener('click', () => goTo(addDays(state.monday, 7)));
  $('#meals-today').addEventListener('click', () => goTo(planningMonday()));
  onSwipe($('#meals'), (direction) => {
    if (!dragging()) goTo(addDays(state.monday, 7 * direction));
  });
}

export function showMeals() {
  if (!state.data) load();
  else render();
}

export function refreshMeals() {
  if (!$('#panel-comidas').hidden || state.data) load();
}
