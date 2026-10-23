import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBoardServer, hostAllowed } from '../src/server.mjs';
import { isLoopback, readKey } from '../src/devices.mjs';

const KEY = 'k3y-de-prueba-0123456789abcdef';
let board;
let base;

before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tablero-devices-'));
  // Every request counts as coming from another device on the network.
  board = createBoardServer({ dir, mealsDir: path.join(dir, 'comidas'), deviceKey: KEY, trusted: () => false });
  const { port } = await board.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

after(() => board.stop());

test('private IP literals are accepted as Host, public ones and other names are not', () => {
  assert.equal(hostAllowed('192.168.1.219:4747'), true);
  assert.equal(hostAllowed('10.0.0.5'), true);
  assert.equal(hostAllowed('100.107.174.113:4747'), true);
  assert.equal(hostAllowed('8.8.8.8'), false);
  assert.equal(hostAllowed('192.169.1.1'), false);
  assert.equal(hostAllowed('192.168.1.219.evil.example'), false);
});

test('loopback is trusted and a short or missing key file means no key', async () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.254'), false);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tablero-clave-'));
  assert.equal(readKey(path.join(dir, 'no-existe')), '');
  await writeFile(path.join(dir, 'corta'), 'abc\n');
  assert.equal(readKey(path.join(dir, 'corta')), '');
  await writeFile(path.join(dir, 'buena'), `${KEY}\n`);
  assert.equal(readKey(path.join(dir, 'buena')), KEY);
});

test('another device needs the key: pairing link, then cookie', async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/api/tablero`)).status, 401);
  assert.equal((await fetch(`${base}/?clave=equivocada`, { redirect: 'manual' })).status, 401);

  const paired = await fetch(`${base}/?clave=${KEY}&kiosco=1`, { redirect: 'manual' });
  assert.equal(paired.status, 303);
  assert.equal(paired.headers.get('location'), '/?kiosco=1');
  const cookie = paired.headers.get('set-cookie');
  assert.match(cookie, /^tablero_clave=.+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);

  const jar = { Cookie: cookie.split(';')[0] };
  assert.equal((await fetch(`${base}/`, { headers: jar })).status, 200);
  assert.equal((await fetch(`${base}/api/tablero`, { headers: jar })).status, 200);
  const created = await fetch(`${base}/api/tareas`, {
    method: 'POST',
    headers: { ...jar, 'Content-Type': 'application/json', 'X-Tablero': '1', Origin: base },
    body: JSON.stringify({ titulo: 'Desde la tablet' }),
  });
  assert.equal(created.status, 201);
  assert.equal((await fetch(`${base}/`, { headers: { Cookie: 'tablero_clave=otra' } })).status, 401);
});
