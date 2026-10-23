// Weather for the home panel from Open-Meteo (free, no key): now, today and tomorrow. The last good
// forecast is kept in memory, so a failing or overloaded service only makes it a little older.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CardError } from './cards.mjs';

export const DEFAULT_PLACE = { nombre: 'Madrid', lat: 40.4168, lon: -3.7038 };
const TTL = 15 * 60_000;
const RETRY_AFTER = 2 * 60_000;
const RAIN_LIKELY = 50;

/** `TABLERO_TIEMPO="Nombre|lat|lon"` picks another place. */
export function weatherPlace() {
  const [nombre, lat, lon] = (process.env.TABLERO_TIEMPO || '').split('|');
  if (!nombre || Number.isNaN(Number(lat)) || Number.isNaN(Number(lon))) return DEFAULT_PLACE;
  return { nombre, lat: Number(lat), lon: Number(lon) };
}

// WMO weather codes → Spanish text and one of the page's icons.
const CODES = [
  [[0], 'Despejado', 'sol'], [[1], 'Casi despejado', 'sol'], [[2], 'Parcialmente nublado', 'sol-nubes'],
  [[3], 'Nublado', 'nubes'], [[45, 48], 'Niebla', 'niebla'],
  [[51, 53, 55, 56, 57], 'Llovizna', 'lluvia'], [[61], 'Lluvia débil', 'lluvia'], [[63], 'Lluvia', 'lluvia'],
  [[65], 'Lluvia fuerte', 'lluvia'], [[66, 67], 'Lluvia helada', 'lluvia'],
  [[71, 73, 77], 'Nieve', 'nieve'], [[75], 'Nieve intensa', 'nieve'], [[80, 81], 'Chubascos', 'lluvia'],
  [[82], 'Chubascos fuertes', 'lluvia'], [[85, 86], 'Chubascos de nieve', 'nieve'],
  [[95], 'Tormenta', 'tormenta'], [[96, 99], 'Tormenta con granizo', 'tormenta'],
];

export function describe(code) {
  const found = CODES.find(([codes]) => codes.includes(code));
  return found ? { texto: found[1], icono: found[2] } : { texto: 'Sin datos', icono: 'nubes' };
}

export function forecastUrl({ lat, lon }) {
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: 'Europe/Madrid', forecast_days: '2',
    current: 'temperature_2m,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    hourly: 'precipitation_probability,weather_code',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

const round = (value) => (typeof value === 'number' ? Math.round(value) : null);

/** A short warning for the rest of today, e.g. "Lluvia probable desde las 17:00". */
function warningFor(hourly, currentTime) {
  const today = currentTime.slice(0, 10);
  const hour = currentTime.slice(0, 13);
  for (const [i, time] of (hourly?.time ?? []).entries()) {
    if (!time.startsWith(today) || time.slice(0, 13) < hour) continue;
    const { icono } = describe(hourly.weather_code?.[i]);
    if (icono === 'tormenta') return `Tormenta probable desde las ${time.slice(11, 16)}`;
    if ((hourly.precipitation_probability?.[i] ?? 0) >= RAIN_LIKELY) {
      return `${icono === 'nieve' ? 'Nieve' : 'Lluvia'} probable desde las ${time.slice(11, 16)}`;
    }
  }
  return '';
}

function day(daily, i) {
  return {
    fecha: daily.time[i],
    max: round(daily.temperature_2m_max?.[i]),
    min: round(daily.temperature_2m_min?.[i]),
    lluvia: round(daily.precipitation_probability_max?.[i]),
    ...describe(daily.weather_code?.[i]),
  };
}

export function parseForecast(json, place, fetchedAt) {
  if (!json?.current || !json?.daily?.time?.length) throw new Error('Respuesta de Open-Meteo incompleta');
  const actual = {
    temperatura: round(json.current.temperature_2m),
    dia: json.current.is_day !== 0,
    ...describe(json.current.weather_code),
  };
  if (!actual.dia && actual.icono.startsWith('sol')) actual.icono = actual.icono.replace('sol', 'luna');
  return {
    lugar: place.nombre,
    actual,
    hoy: { ...day(json.daily, 0), aviso: warningFor(json.hourly, json.current.time) },
    manana: json.daily.time.length > 1 ? day(json.daily, 1) : null,
    actualizado: new Date(fetchedAt).toISOString(),
  };
}

export function weatherCacheFile() {
  return process.env.TABLERO_TIEMPO_CACHE || path.join(os.homedir(), '.cache/tablero/tiempo.json');
}

export function createWeather({ place = weatherPlace(), fetchImpl = fetch, now = Date.now, cacheFile = weatherCacheFile() } = {}) {
  let last = null;
  let lastTry = 0;
  let pending = null;
  let loaded = false;

  // The last good forecast survives restarts, so an Open-Meteo outage right after one is not a blank card.
  async function loadSaved() {
    loaded = true;
    try {
      const value = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (value?.lugar === place.nombre && value.actualizado) last = { at: Date.parse(value.actualizado), value };
    } catch {
      // Nothing saved yet.
    }
  }

  async function save(value) {
    try {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(`${cacheFile}.tmp`, JSON.stringify(value));
      await rename(`${cacheFile}.tmp`, cacheFile);
    } catch {
      // Not being able to save only loses the copy for the next restart.
    }
  }

  async function refresh() {
    const res = await fetchImpl(forecastUrl(place), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Open-Meteo respondió ${res.status}`);
    last = { at: now(), value: parseForecast(await res.json(), place, now()) };
    await save(last.value);
    return last.value;
  }

  return {
    place,
    /** The forecast, refreshed every 15 minutes; when the service fails, the last good one. */
    async get() {
      if (!loaded) await loadSaved();
      const fresh = last && now() - last.at < TTL;
      if (fresh || (last && now() - lastTry < RETRY_AFTER)) return last.value;
      if (pending) return pending;
      lastTry = now();
      pending = refresh().catch((err) => {
        if (last) return last.value;
        throw new CardError(`No he podido leer el tiempo: ${err.message}`, 502);
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
