import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAiUsage, toUsage } from '../src/ai-usage.mjs';

// Trimmed from a real `codexbar serve` /usage answer.
const PAYLOAD = [
  {
    provider: 'codex',
    usage: {
      primary: { usedPercent: 5, windowMinutes: 300, resetsAt: '2026-10-19T15:03:33Z' },
      secondary: { usedPercent: 24, windowMinutes: 10080, resetsAt: '2026-10-25T04:00:41Z' },
      loginMethod: 'ChatGPT Pro', updatedAt: '2026-10-19T10:56:26Z',
    },
    pace: { primary: { willLastToReset: true, deltaPercent: -14 }, secondary: { willLastToReset: false, deltaPercent: 6, etaSeconds: 360000 } },
  },
  {
    provider: 'claude',
    usage: {
      primary: { usedPercent: 29.4, windowMinutes: 300, resetsAt: '2026-10-19T11:29:59Z' },
      secondary: { usedPercent: 30, windowMinutes: 10080, resetsAt: '2026-10-24T12:59:59Z' },
      tertiary: null, loginMethod: 'Claude Max 5x', updatedAt: '2026-10-19T10:56:26Z',
    },
    pace: { primary: { willLastToReset: true, deltaPercent: -60, expectedUsedPercent: 89 }, secondary: { willLastToReset: false, deltaPercent: 3, etaSeconds: 385905, expectedUsedPercent: 27 } },
  },
  { provider: 'cursor', usage: { primary: { usedPercent: 10 } } },
];

test('CodexBar providers become Claude first, then Codex, with windows and pace', () => {
  const usage = toUsage(PAYLOAD, 'codexbar');
  assert.equal(usage.disponible, true);
  assert.deepEqual(usage.proveedores.map((p) => p.id), ['claude', 'codex']);
  const [claude] = usage.proveedores;
  assert.equal(claude.plan, 'Claude Max 5x');
  assert.deepEqual(claude.ventanas[0], {
    etiqueta: 'Sesión de 5 h', usado: 29, reinicio: '2026-10-19T11:29:59Z',
    ritmo: { aguanta: true, seAcabaEn: null, margen: 60, esperado: 89 },
  });
  assert.deepEqual(claude.ventanas[1].ritmo, { aguanta: false, seAcabaEn: 385905, margen: -3, esperado: 27 });
  assert.deepEqual(toUsage([], 'codexbar'), { disponible: false });
  assert.deepEqual(toUsage({ nope: true }, 'codexbar'), { disponible: false });
});

test('the CodexBar server is asked once a minute; when it is down, showy-quota cache answers', async () => {
  let clock = 0;
  let calls = 0;
  let down = false;
  const fetchImpl = async () => {
    calls += 1;
    if (down) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => PAYLOAD };
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tablero-ia-'));
  const cacheFile = path.join(dir, 'usage.json');
  await writeFile(cacheFile, JSON.stringify({ schema: 'showy-quota/cache@1', providers: [PAYLOAD[1]] }));
  const ai = createAiUsage({ url: 'http://127.0.0.1:1/usage', cacheFile, fetchImpl, now: () => clock });
  assert.equal((await ai.get()).fuente, 'codexbar');
  await ai.get();
  assert.equal(calls, 1);
  clock += 61_000;
  down = true;
  const fromCache = await ai.get();
  assert.equal(fromCache.fuente, 'cache');
  assert.deepEqual(fromCache.proveedores.map((p) => p.id), ['claude']);

  const nothing = createAiUsage({ url: 'http://127.0.0.1:1/usage', cacheFile: path.join(dir, 'no'), fetchImpl: async () => { throw new Error('x'); } });
  assert.deepEqual(await nothing.get(), { disponible: false });
});

test('without CodexBar\'s expected use, the even pace comes from the window and its reset', () => {
  // A 7-day window that resets in 5 days: 2 of 7 days gone, 29 % expected.
  const now = Date.parse('2026-10-19T12:00:00Z');
  const [codex] = toUsage([{ provider: 'codex', usage: { secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: '2026-10-24T12:00:00Z' } } }], 'codexbar', now).proveedores;
  assert.equal(codex.ventanas[0].ritmo.esperado, 29);
});
