import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWeather, describe, forecastUrl, parseForecast } from '../src/weather.mjs';

const PLACE = { nombre: 'Madrid', lat: 40.4168, lon: -3.7038 };
const SAMPLE = {
  current: { time: '2026-10-19T12:45', temperature_2m: 18.4, weather_code: 2, is_day: 1 },
  daily: {
    time: ['2026-10-19', '2026-10-20'], weather_code: [61, 0],
    temperature_2m_max: [21.6, 19.2], temperature_2m_min: [9.5, 8.1], precipitation_probability_max: [70, 5],
  },
  hourly: {
    time: ['2026-10-19T11:00', '2026-10-19T13:00', '2026-10-19T17:00', '2026-10-20T09:00'],
    precipitation_probability: [90, 10, 65, 80],
    weather_code: [61, 2, 61, 61],
  },
};

test('WMO codes become Spanish text and an icon', () => {
  assert.deepEqual(describe(0), { texto: 'Despejado', icono: 'sol' });
  assert.deepEqual(describe(63), { texto: 'Lluvia', icono: 'lluvia' });
  assert.deepEqual(describe(96), { texto: 'Tormenta con granizo', icono: 'tormenta' });
  assert.equal(describe(1234).icono, 'nubes');
});

test('the forecast URL asks for Madrid time and two days', () => {
  const url = new URL(forecastUrl(PLACE));
  assert.equal(url.hostname, 'api.open-meteo.com');
  assert.equal(url.searchParams.get('timezone'), 'Europe/Madrid');
  assert.equal(url.searchParams.get('forecast_days'), '2');
});

test('a forecast keeps now, today with a rain warning from now on, and tomorrow', () => {
  const weather = parseForecast(SAMPLE, PLACE, Date.parse('2026-10-19T10:45:00Z'));
  assert.deepEqual(weather.actual, { temperatura: 18, dia: true, texto: 'Parcialmente nublado', icono: 'sol-nubes' });
  assert.equal(weather.hoy.max, 22);
  assert.equal(weather.hoy.lluvia, 70);
  // The rain at 11:00 is over; the next likely one is at 17:00, and tomorrow does not count.
  assert.equal(weather.hoy.aviso, 'Lluvia probable desde las 17:00');
  assert.equal(weather.manana.texto, 'Despejado');
  assert.equal(weather.lugar, 'Madrid');
  const night = parseForecast({ ...SAMPLE, current: { ...SAMPLE.current, is_day: 0, weather_code: 0 } }, PLACE, 0);
  assert.equal(night.actual.icono, 'luna');
  assert.throws(() => parseForecast({}, PLACE, 0), /incompleta/);
});

test('the forecast is cached and an outage serves the last good one', async () => {
  let clock = 0;
  let calls = 0;
  let down = false;
  const fetchImpl = async () => {
    calls += 1;
    if (down) return { ok: false, status: 503 };
    return { ok: true, json: async () => SAMPLE };
  };
  const cacheFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'tablero-tiempo-')), 'tiempo.json');
  const weather = createWeather({ place: PLACE, fetchImpl, now: () => clock, cacheFile });
  await weather.get();
  await weather.get();
  assert.equal(calls, 1);
  clock += 16 * 60_000;
  down = true;
  assert.equal((await weather.get()).actual.temperatura, 18);
  assert.equal(calls, 2);

  // After a restart with Open-Meteo down, the forecast saved on disk is served.
  const restarted = createWeather({ place: PLACE, fetchImpl: async () => ({ ok: false, status: 503 }), now: () => clock, cacheFile });
  assert.equal((await restarted.get()).actual.temperatura, 18);

  const broken = createWeather({ place: PLACE, fetchImpl: async () => ({ ok: false, status: 503 }), now: () => 0, cacheFile: path.join(os.tmpdir(), 'no-existe-tiempo.json') });
  await assert.rejects(broken.get(), /No he podido leer el tiempo: Open-Meteo respondió 503/);
});
