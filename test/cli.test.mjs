import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/tareas.mjs', import.meta.url));

function run(dir, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, TAREAS_DIR: dir, TAREAS_QUIEN: '' } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test('the CLI covers the agent workflow end to end', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tablero-cli-'));
  let res = await run(dir, 'nueva', 'Factura de Printful', '--siguiente', 'Descargarla', '--area', 'admin', '--quien', 'claude');
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^T-001 creada: Factura de Printful \[Bandeja\]/);

  res = await run(dir, 'coger', '1', '--quien', 'codex');
  assert.match(res.stdout, /T-001 cogida: .* \[Agente\]/);
  res = await run(dir, 'nota', 'T-001', 'PDF descargado', '--quien', 'codex');
  assert.equal(res.code, 0, res.stderr);
  res = await run(dir, 'mover', 'T-001', 'tu-ok', '--nota', 'Falta que lo apruebes', '--quien', 'codex');
  assert.match(res.stdout, /\[Necesita tu OK\]/);
  res = await run(dir, 'cerrar', 'T-001', '--evidencia', 'Subida a Holded', '--quien', 'codex');
  assert.match(res.stdout, /\[Hecha\]/);

  const text = await readFile(path.join(dir, 'T-001.md'), 'utf8');
  assert.match(text, /^agente: codex$/m);
  assert.match(text, /^evidencia: "Subida a Holded"$/m);
  assert.match(text, /· Codex: Bandeja → Agente\. La coge Codex/);
  assert.match(text, /· Codex: Agente → Necesita tu OK\. Falta que lo apruebes/);

  const list = JSON.parse((await run(dir, 'lista', '--json')).stdout);
  assert.equal(list[0].columna, 'cerrado');
  assert.match((await run(dir, 'resumen')).stdout, /## Cerrado \(últimos 14 días\) \(1\)\n- T-001 · Factura de Printful/);
});

test('the CLI explains mistakes and exits with an error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tablero-cli-'));
  const badState = await run(dir, 'nueva', 'x', '--estado', 'pronto');
  assert.equal(badState.code, 1);
  assert.match(badState.stderr, /Estado no válido/);
  const unknown = await run(dir, 'borrar', 'T-001');
  assert.match(unknown.stderr, /No conozco «borrar»/);
  const missing = await run(dir, 'ver', 'T-404');
  assert.match(missing.stderr, /No existe la tarea T-404/);
  const changeState = await run(dir, 'editar', 'T-001', '--estado', 'hecha');
  assert.match(changeState.stderr, /tareas mover/);
});
