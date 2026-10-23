// Plan limits of the AI tools (Claude and Codex) for the home panel, from CodexBar: its local server
// (`codexbar serve`, the one SketchyBar's showy-quota keeps running) or, if it does not answer,
// showy-quota's cache file. No credentials pass through here.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TTL = 60_000;
const NAMES = { claude: 'Claude', codex: 'Codex' };
const ORDER = ['claude', 'codex'];

export function codexbarUrl() {
  return process.env.TABLERO_CODEXBAR_URL || 'http://127.0.0.1:8080/usage';
}

export function codexbarCache() {
  return process.env.TABLERO_CODEXBAR_CACHE || path.join(os.homedir(), '.cache/showy-quota/usage.json');
}

const percent = (value) => (typeof value === 'number' ? Math.max(0, Math.min(100, Math.round(value))) : null);

/**
 * How much of the window would be used by now if it were spread evenly, from CodexBar when it says
 * so, otherwise from where we are between the window's start and its reset.
 */
function expected(raw, rawPace, now) {
  if (typeof rawPace?.expectedUsedPercent === 'number') return percent(rawPace.expectedUsedPercent);
  const resetsAt = Date.parse(raw.resetsAt);
  if (!raw.windowMinutes || Number.isNaN(resetsAt)) return null;
  const length = raw.windowMinutes * 60_000;
  return percent(((length - (resetsAt - now)) / length) * 100);
}

/** CodexBar's pace, in Spanish: whether the window lasts until it resets or when it runs out. */
function pace(rawPace, esperado) {
  if (!rawPace && esperado === null) return null;
  const delta = typeof rawPace?.deltaPercent === 'number' ? Math.round(rawPace.deltaPercent) : null;
  return {
    aguanta: rawPace?.willLastToReset !== false,
    seAcabaEn: typeof rawPace?.etaSeconds === 'number' ? rawPace.etaSeconds : null,
    // Negative delta: used less than the even pace would by now (margin); positive: ahead of it.
    margen: delta === null ? null : -delta,
    esperado,
  };
}

function window(raw, label, rawPace, now) {
  if (!raw || percent(raw.usedPercent) === null) return null;
  return {
    etiqueta: label, usado: percent(raw.usedPercent), reinicio: raw.resetsAt || null,
    ritmo: pace(rawPace, expected(raw, rawPace, now)),
  };
}

/** One provider from CodexBar's payload, or null when it has no usable windows. */
export function toProvider(raw, now = Date.now()) {
  const id = raw?.provider;
  if (!NAMES[id] || !raw.usage) return null;
  const ventanas = [
    window(raw.usage.primary, 'Sesión de 5 h', raw.pace?.primary, now),
    window(raw.usage.secondary, 'Semana', raw.pace?.secondary, now),
  ].filter(Boolean);
  if (!ventanas.length) return null;
  return { id, nombre: NAMES[id], plan: raw.usage.loginMethod || '', ventanas, actualizado: raw.usage.updatedAt || null };
}

export function toUsage(providers, fuente, now = Date.now()) {
  const proveedores = (Array.isArray(providers) ? providers : []).map((p) => toProvider(p, now)).filter(Boolean)
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return proveedores.length ? { disponible: true, fuente, proveedores } : { disponible: false };
}

export function createAiUsage({ url = codexbarUrl(), cacheFile = codexbarCache(), fetchImpl = fetch, now = Date.now } = {}) {
  let last = null;

  async function fromServer() {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`CodexBar respondió ${res.status}`);
    return toUsage(await res.json(), 'codexbar', now());
  }

  async function fromCache() {
    const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
    return toUsage(saved?.providers, 'cache', now());
  }

  return {
    /** Cached for a minute; CodexBar refreshes its own data in the background. */
    async get() {
      if (last && now() - last.at < TTL) return last.value;
      let value;
      try {
        value = await fromServer();
      } catch {
        value = await fromCache().catch(() => ({ disponible: false }));
      }
      if (value.disponible || !last) last = { at: now(), value };
      return last.value;
    },
  };
}
