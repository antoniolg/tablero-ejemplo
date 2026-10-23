// Light or dark, decided before the first paint: this device's choice (the button above the clock)
// or, without one, the system's. A classic script in <head>, not a module, so the page never shows
// in the wrong colours first. The wall tablet runs Android 8.1, which has no system dark mode.
(() => {
  const KEY = 'tablero.tema';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const systemTheme = () => (system.matches ? 'dark' : 'light');
  const chosen = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const apply = () => { root.dataset.theme = chosen() || systemTheme(); };
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', (event) => { if (event.key === KEY) apply(); });

  /** Flips light and dark on this device; picking what the system shows anyway drops the choice. */
  window.toggleTheme = () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      if (next === systemTheme()) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Storage refused (a private window): it lasts until the page reloads.
    }
    root.dataset.theme = next;
  };
})();
