// Access from other devices on the home network (the wall tablet). The Mac itself connects over
// loopback, as does `tailscale serve`, and needs nothing; anything else must carry the device key,
// which a device gets once by opening the pairing link (`/?clave=…`) and then keeps as a cookie.
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const COOKIE = 'tablero_clave';
const TEN_YEARS = 10 * 365 * 24 * 3600;

export function keyFile() {
  return process.env.TABLERO_CLAVE_FILE || path.join(os.homedir(), '.config/tablero/clave');
}

/** The device key, or '' when there is none (then only loopback clients get in). */
export function readKey(file = keyFile()) {
  try {
    const key = readFileSync(file, 'utf8').trim();
    return key.length >= 16 ? key : '';
  } catch {
    return '';
  }
}

export function isLoopback(address = '') {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function cookie(header = '', name = COOKIE) {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function same(given, key) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Checks a request from a device that is not the Mac. Returns 'ok', 'pair' (a valid pairing link:
 * answer with `pairingResponse`) or 'deny'.
 */
export function deviceAccess(req, url, key) {
  if (!key) return 'deny';
  if (req.method === 'GET' && url.searchParams.has('clave')) return same(url.searchParams.get('clave'), key) ? 'pair' : 'deny';
  return same(cookie(req.headers.cookie), key) ? 'ok' : 'deny';
}

/** Saves the key as a cookie and sends the device to the same page without the key in the URL. */
export function pairingResponse(res, url, key, headers) {
  url.searchParams.delete('clave');
  res.writeHead(303, {
    ...headers,
    'Set-Cookie': `${COOKIE}=${key}; Path=/; Max-Age=${TEN_YEARS}; HttpOnly; SameSite=Lax`,
    Location: `${url.pathname}${url.search}`,
  });
  res.end();
}
