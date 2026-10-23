// Small DOM, API and date helpers shared by every panel.

export const $ = (selector) => document.querySelector(selector);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : String(child));
  }
  return el;
}

export function html(tag, attrs, markup) {
  const el = h(tag, attrs);
  el.innerHTML = markup; // markup comes from markdown.js, which escapes every piece of text
  return el;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'X-Tablero': '1' }),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let statusTimer;
export function notify(message, action) {
  const el = $('#status');
  const button = action && h('button', {
    type: 'button',
    onclick: () => {
      el.classList.remove('show', 'actionable');
      action.run();
    },
  }, action.label);
  el.replaceChildren(...[message, button].filter(Boolean));
  el.classList.toggle('actionable', Boolean(action));
  el.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('show', 'actionable'), action ? 7000 : 4000);
}

function fieldView(field) {
  if (field.type === 'radio') {
    return h('fieldset', { class: 'choice' }, h('legend', {}, field.label), field.options.map(([value, text]) => h('label', {},
      h('input', { type: 'radio', name: field.name, value, checked: value === field.value }), text)));
  }
  if (field.type === 'select') {
    return h('label', {}, field.label, h('select', { name: field.name }, field.options.map(([value, text]) => h('option', { value, selected: value === field.value }, text))));
  }
  const control = field.type === 'textarea'
    ? h('textarea', { name: field.name, rows: '3', placeholder: field.placeholder }, field.value || '')
    : h('input', { name: field.name, type: field.type || 'text', value: field.value || '', placeholder: field.placeholder, required: field.required });
  return h('label', {}, field.label, control);
}

/** Whether a sheet has something typed or picked that is not saved (search boxes do not count). */
function edited(dialog) {
  return [...dialog.querySelectorAll('input, textarea, select')].some((field) => {
    if (field.type === 'search') return false;
    if (field.type === 'checkbox' || field.type === 'radio') return field.checked !== field.defaultChecked;
    if (field.tagName === 'SELECT') return [...field.options].some((option) => option.selected !== option.defaultSelected);
    return field.value !== field.defaultValue;
  });
}

/**
 * A tap outside an open sheet closes it, like Cancelar, unless it has unsaved changes. Only when the
 * press started outside too: a text selection that ends outside the sheet does not close it.
 */
export function closeOnOutsideTap(dialog) {
  let pressedOutside = false;
  const outside = (event) => {
    if (event.target !== dialog) return false;
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  dialog.addEventListener('pointerdown', (event) => { pressedOutside = outside(event); });
  dialog.addEventListener('click', (event) => {
    if (!pressedOutside || !outside(event)) return;
    pressedOutside = false;
    if (edited(dialog)) notify('Hay cambios sin guardar: guarda o cancela antes de cerrar.');
    else dialog.close();
  });
}

export function ask({ title, fields, confirm, onSubmit }) {
  const dialog = $('#ask');
  const form = h('form', { method: 'dialog', class: 'form' },
    h('h2', {}, title),
    fields.map(fieldView),
    h('div', { class: 'row end' },
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancelar'),
      h('button', { type: 'submit', class: 'primary' }, confirm)));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    dialog.close();
    await onSubmit(values);
  });
  dialog.replaceChildren(form);
  dialog.showModal();
  form.querySelector('input:not([type=radio]), textarea, select')?.focus();
}

/** RFC 3339 with the local offset for a day and minutes since midnight, e.g. 2026-10-20T10:30:00+02:00. */
export function localStamp(day, minutes) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d, 0, minutes);
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${dayOf(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

export const short = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}

/** Local calendar day of a Date, as AAAA-MM-DD. */
export function dayOf(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const todayLocal = () => dayOf(new Date());

/** Reads a remembered per-device preference; storage can be refused in private windows. */
export function remember(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The preference only lasts for this visit.
  }
}

/** Calls `onSwipe(-1 | 1)` on a clear horizontal swipe, for week navigation on the tablet. */
export function onSwipe(el, onSwipe) {
  let start = null;
  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') start = { x: event.clientX, y: event.clientY, t: Date.now() };
  });
  el.addEventListener('pointerup', (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const quick = Date.now() - start.t < 600;
    start = null;
    if (quick && Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) onSwipe(dx < 0 ? 1 : -1);
  });
  el.addEventListener('pointercancel', () => { start = null; });
}
