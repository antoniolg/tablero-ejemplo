// Shell: tabs between panels, a clock, and one server-sent event stream that refreshes them.
import { $, closeOnOutsideTap, remember, store } from './dom.js';
import { currentTasks, initTasks, refreshTasks } from './tasks.js';
import { initCalendar, refreshCalendar, showCalendar } from './calendar.js';
import { initBlocks } from './blocks.js';
import { initMeals, refreshMeals, showMeals } from './meals.js';
import { initHome, refreshHome, showHome } from './home.js';
import { expireWeeks } from './weeks.js';
import { initVoice } from './voice.js';

const PANELS = ['inicio', 'tareas', 'calendario', 'comidas'];
const ON_SHOW = { inicio: showHome, calendario: showCalendar, comidas: showMeals };
let active = null;

function select(panel, { push = true } = {}) {
  if (!PANELS.includes(panel)) panel = 'inicio';
  if (active === panel) return;
  active = panel;
  for (const id of PANELS) {
    $(`#panel-${id}`).hidden = id !== panel;
    $(`#tab-${id}`).setAttribute('aria-selected', String(id === panel));
  }
  document.body.dataset.panel = panel;
  store('tablero.panel', panel);
  if (push && location.hash !== `#${panel}`) history.replaceState(null, '', `#${panel}`);
  ON_SHOW[panel]?.();
}

function tickClock() {
  const now = new Date();
  $('#clock strong').textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  // The rail is 56px wide: weekday and day only ("lun 19").
  $('#clock span').textContent = now.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' }).replace(',', '');
  setTimeout(tickClock, 60_000 - (Date.now() % 60_000) + 50);
}

// Light/dark switch above the clock. theme.js (loaded before the page shows) keeps the choice per
// device; here the button only flips it and says which way it is.
function themeSwitch() {
  const button = $('#theme');
  const sync = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? 'Pasar a modo claro' : 'Pasar a modo oscuro';
  };
  button.addEventListener('click', () => window.toggleTheme?.());
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  sync();
}

// The wall tablet opens the board once with ?kiosco=1 (the pairing link does it). From then on it
// remembers it and goes full screen with the first tap, hiding the browser's toolbar.
function kiosk() {
  const params = new URLSearchParams(location.search);
  if (params.has('kiosco')) {
    store('tablero.kiosco', params.get('kiosco') !== '0');
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }
  if (!remember('tablero.kiosco', false)) return;
  document.documentElement.classList.add('kiosk');
  const enter = () => {
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  };
  // pointerup (not pointerdown) counts as a user gesture for touch in every browser.
  document.addEventListener('pointerup', enter, { capture: true });
}

// One stream of server-sent events refreshes the panels. Firefox gives a stream up for good after an
// error (a server restart can cause one), and a dead connection can look open, so the server sends a
// heartbeat and the page reconnects whenever the stream closes or goes quiet.
const QUIET_LIMIT = 70_000;

function listen() {
  let source = null;
  let watchdog = null;
  let connectedBefore = false;
  let version = null;
  const timers = {};
  const later = (key, run) => {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(run, 250);
  };
  const alive = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(connect, QUIET_LIMIT);
  };
  // A new version of the page (its files changed or the server restarted): reload to pick it up,
  // but not while a sheet is open with something half written.
  const reloadWhenIdle = () => {
    if (document.querySelector('dialog[open]')) setTimeout(reloadWhenIdle, 30_000);
    else location.reload();
  };
  const handlers = {
    // Back after a gap (the Mac slept, the server restarted): catch up on what changed meanwhile.
    open: () => {
      if (connectedBefore) {
        refreshTasks();
        refreshCalendar();
        refreshMeals();
        refreshHome('calendario');
      }
      connectedBefore = true;
    },
    latido: () => {},
    cambio: () => later('cambio', async () => {
      await refreshTasks();
      refreshCalendar({ tasksOnly: true });
      refreshHome('cambio');
    }),
    version: (event) => {
      const { v } = JSON.parse(event.data);
      if (version && v !== version) reloadWhenIdle();
      version = v;
    },
    // A block written from here, or Google changed under a week already shown.
    calendario: () => later('calendario', () => {
      expireWeeks();
      refreshCalendar();
      refreshHome('calendario');
    }),
    comidas: () => later('comidas', () => {
      refreshMeals();
      refreshHome('comidas');
    }),
  };
  function connect() {
    source?.close();
    source = new EventSource('/api/eventos');
    for (const [name, run] of Object.entries(handlers)) {
      source.addEventListener(name, (event) => {
        alive();
        run(event);
      });
    }
    source.addEventListener('error', () => {
      if (source.readyState !== EventSource.CLOSED) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(connect, 10_000);
    });
    alive();
  }
  connect();
}

function start() {
  kiosk();
  themeSwitch();
  initVoice();
  for (const dialog of document.querySelectorAll('dialog')) closeOnOutsideTap(dialog);
  for (const tab of document.querySelectorAll('[role=tab]')) tab.addEventListener('click', () => select(tab.dataset.panel));
  window.addEventListener('hashchange', () => select(location.hash.slice(1), { push: false }));
  // The home panel counts tasks too: repaint it once the board has loaded.
  initTasks().then(() => refreshHome('cambio'));
  initCalendar({ tasks: currentTasks });
  initBlocks({ tasks: currentTasks, changed: async () => { await refreshTasks(); refreshCalendar(); } });
  initMeals();
  initHome({ tasks: currentTasks });
  select(location.hash.slice(1) || remember('tablero.panel', 'inicio'));
  tickClock();
  listen();
  // Blocks moved in Google show up within minutes even if nobody touches a card.
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshTasks();
  }, 5 * 60_000);
  // Coming back to the page (or to the tablet after it slept) shows fresh data.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    refreshTasks();
    refreshCalendar();
    refreshMeals();
    refreshHome('calendario');
  });
}

start();
