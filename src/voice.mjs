// Voice commands from the wall tablet. The audio is transcribed on this Mac (Whisper, nothing leaves
// the house) and the official `claude` CLI, logged in with Antonio's own subscription, turns natural
// speech into a plan over the board, the meal plan and the work blocks (see voice-actions.mjs). The
// page shows the plan; nothing changes until Antonio confirms it, and then the server applies it.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLOSED, CardError, STATE_LABELS, addDays, listCards, today } from './cards.mjs';
import { mondayOf, readWeek } from './meals.mjs';
import { PLAN_SCHEMA, applyAction, cleanPlan, dayLabel, touchesCalendar } from './voice-actions.mjs';

export { PLAN_SCHEMA, cleanPlan };
export const MAX_AUDIO = 8 * 1024 * 1024;
const PLAN_TTL = 15 * 60_000;
const WHO = 'antonio';

// LaunchAgents start with a bare PATH; Homebrew has ffmpeg (Whisper needs it) and claude.
const toolPath = () => ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), process.env.PATH]
  .filter(Boolean).join(':');

function run(bin, args, { timeout, cwd, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout, cwd, env: { ...env, PATH: toolPath() }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error((stderr || err.message).trim().split('\n').pop()), { stdout }));
      else resolve(stdout);
    });
    // Nothing goes in on stdin; without EOF, `claude -p` waits 3 s and warns about it.
    child.stdin?.end();
  });
}

/**
 * Spanish speech to text with mlx_whisper (large-v3-turbo), on this Mac. `hint` (the open cards' titles)
 * is Whisper's initial prompt, so it spells Antonio's own words (HITL, Stripe…) instead of guessing.
 */
export function whisperRunner({
  bin = process.env.TABLERO_WHISPER || path.join(os.homedir(), '.local/bin/mlx_whisper'),
  model = process.env.TABLERO_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo',
} = {}) {
  return async (file, hint = '') => {
    const dir = path.dirname(file);
    const args = [file, '--model', model, '--language', 'es', '--output-format', 'txt', '--output-dir', dir];
    if (hint) args.push('--initial-prompt', hint);
    await run(bin, args, { timeout: 120_000, cwd: dir });
    return (await readFile(path.join(dir, `${path.parse(file).name}.txt`), 'utf8')).replace(/\s+/g, ' ').trim();
  };
}

/**
 * Text to plan with `claude -p`: Haiku, no tools, safe mode (no CLAUDE.md, MCP or hooks), structured
 * output. Without ANTHROPIC_API_KEY, so it always runs on the subscription and never on API billing.
 */
export function claudeRunner({ bin = process.env.TABLERO_CLAUDE || '/opt/homebrew/bin/claude', model = 'haiku' } = {}) {
  return async (prompt) => {
    const cwd = path.join(os.tmpdir(), 'tablero-voz');
    await mkdir(cwd, { recursive: true });
    const { ANTHROPIC_API_KEY, ...env } = process.env;
    // On failure claude still prints its JSON (with the reason in `result`), and exits with 1.
    const out = await run(bin, ['-p', prompt, '--model', model, '--tools', '', '--safe-mode', '--json-schema', JSON.stringify(PLAN_SCHEMA),
      '--output-format', 'json', '--no-session-persistence'], { timeout: 120_000, cwd, env })
      .catch((err) => (err.stdout?.trim().startsWith('{') ? err.stdout : Promise.reject(err)));
    const data = JSON.parse(out);
    if (data.is_error) throw new Error(data.result || 'Claude no ha podido responder');
    return data.structured_output ?? JSON.parse(data.result);
  };
}

const longDay = (day) => new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${day}T12:00:00Z`));
const clock = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

export function promptFor(texto, ctx, now = new Date()) {
  const day = ctx.day;
  const dates = Array.from({ length: 15 }, (_, i) => addDays(day, i))
    .map((d, i) => `${dayLabel(d)} = ${d}${i === 0 ? ' (hoy)' : i === 1 ? ' (mañana)' : ''}`).join('; ');
  const cards = ctx.openCards.map((c) => `${c.id} [${STATE_LABELS[c.estado] ?? c.estado}] ${c.titulo}`
    + `${c.fecha ? ` · planeada ${c.fecha}` : ''}${c.limite ? ` · límite ${c.limite}` : ''}`).join('\n');
  const meals = ctx.meals.map((m) => `${dayLabel(m.fecha)} (${m.fecha}): comida «${m.comida || '—'}», cena «${m.cena || '—'}»`).join('\n');
  const blocks = ctx.blockList.map((b) => `${b.ref}: «${b.titulo}» (${b.tarea}) ${dayLabel(b.inicio.slice(0, 10))} ${b.inicio.slice(11, 16)}–${b.fin.slice(11, 16)}`).join('\n');
  return [
    `Hoy es ${longDay(day)}, son las ${clock(now)}. Antonio le habla a su tablero como hablaría con una persona: puede pedir`,
    'varias cosas a la vez, corregirse a mitad («no, mejor el jueves»: vale lo último) o referirse a las cosas de forma aproximada',
    '(«lo del taller», «la de Stripe», «la cena del martes»). Extrae todo lo que pida cambiar en:',
    '- Sus tareas: crear (título corto; fecha planeada, límite y siguiente paso solo si los dice), editar (título, siguiente paso, fecha',
    '  planeada o límite), cerrar (ya está hecha), soltar (la descarta), mover (cambiar de estado; para «esperando» di quién la tiene',
    '  y cuándo revisarla si lo dice; para «más adelante», cuándo revisarla) y nota (apuntar algo en una tarea).',
    `  Estados: ${Object.entries(STATE_LABELS).filter(([id]) => !CLOSED.has(id)).map(([id, label]) => `${id} (${label})`).join(', ')}.`,
    '- Su menú de comidas, de lunes a viernes, con comida y cena: comida (poner un plato en un hueco, o vaciarlo con plato vacío)',
    '  y cambiar_comidas (intercambiar dos huecos). Los fines de semana no se planifican.',
    '- Sus bloques de trabajo en el calendario (tiempo reservado para una tarea): bloque (reservar; para una tarea de la lista',
    '  usa su id, para algo nuevo pon titulo y se creará la tarea; hora HH:MM y minutos, 60 si no lo dice), mover_bloque y',
    '  quitar_bloque (usa la referencia B1, B2… de la lista). «Por la mañana» sin hora: 09:00; «por la tarde»: 16:00.',
    'Fechas siempre AAAA-MM-DD según esta tabla: ' + dates + '.',
    'Usa solo ids y referencias de las listas; nunca los inventes. Si algo es ambiguo (varias tareas encajan) o no cabe en estas',
    'acciones (un recordatorio, algo de fuera del tablero), déjalo fuera y explícalo en dudas. Si pide crear algo que ya parece',
    'estar en la lista, avísalo en dudas. Antonio leerá el plan antes de confirmarlo: aún no se ha hecho nada, así que en dudas',
    'no digas «he creado» ni «he cerrado», y no expliques cómo se aplica.',
    '',
    'Tareas abiertas:', cards || '(ninguna)',
    '',
    'Menú de esta semana y la siguiente:', meals || '(sin plan)',
    '',
    'Próximos bloques de trabajo:', blocks || '(ninguno)',
    '',
    `Lo que ha dicho: «${texto}»`,
  ].join('\n');
}

export function createVoice({ dir, mealsDir = null, calendar = null, blocks = null, transcribe = whisperRunner(), interpret = claudeRunner(), now = () => new Date() } = {}) {
  const plans = new Map(); // id → { at, acciones }

  /** What Claude needs to resolve references, and what the plan is checked against. */
  async function context() {
    const at = now();
    const day = today(at);
    const openCards = (await listCards(dir)).filter((c) => !CLOSED.has(c.estado));
    const meals = [];
    if (mealsDir) {
      for (const monday of [mondayOf(day), addDays(mondayOf(day), 7)]) meals.push(...(await readWeek(mealsDir, monday)).dias);
    }
    const blockList = [];
    if (calendar) {
      for (const monday of [mondayOf(day), addDays(mondayOf(day), 7)]) {
        const week = await calendar.week(monday).catch(() => null);
        for (const e of week?.eventos ?? []) {
          if (e.tarea && Date.parse(e.fin) > at.getTime() && !blockList.some((b) => b.id === e.id)) blockList.push({ id: e.id, tarea: e.tarea, titulo: e.titulo, inicio: e.inicio, fin: e.fin });
        }
      }
      blockList.sort((a, b) => a.inicio.localeCompare(b.inicio)).forEach((b, i) => { b.ref = `B${i + 1}`; });
    }
    const blockMap = new Map(blockList.flatMap((b) => [[b.ref, b], [b.id, b]]));
    return { day, openCards, meals, blockList, cards: new Map(openCards.map((c) => [c.id, c])), blocks: blockMap };
  }

  return {
    /** Audio in, `{ id, texto, acciones, dudas }` out. Nothing is written; the plan waits for `apply(id)`. */
    async plan(audio, type = 'audio/webm') {
      if (!audio?.length) throw new CardError('No ha llegado audio');
      const work = await mkdtemp(path.join(os.tmpdir(), 'tablero-voz-'));
      try {
        const file = path.join(work, `nota.${type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : type.includes('wav') ? 'wav' : 'webm'}`);
        await writeFile(file, audio);
        const ctx = await context();
        // Whisper's prompt is short (224 tokens): the titles, most recent first, up to ~600 characters.
        const hint = `Tablero de tareas, comidas y bloques. ${ctx.openCards.map((c) => c.titulo).reverse().join('. ')}`.slice(0, 600);
        let texto;
        try {
          texto = await transcribe(file, hint);
        } catch (err) {
          throw new CardError(`No he podido transcribir el audio: ${err.message}`, 502);
        }
        if (!texto) throw new CardError('No he entendido nada. Prueba otra vez, más cerca de la tablet.', 422);
        let raw;
        try {
          raw = await interpret(promptFor(texto, ctx, now()));
        } catch (err) {
          throw new CardError(`Claude no ha podido interpretarlo: ${err.message}`, 502);
        }
        const plan = cleanPlan(raw, ctx);
        const id = randomUUID();
        for (const [key, value] of plans) if (now() - value.at > PLAN_TTL) plans.delete(key);
        plans.set(id, { at: now(), acciones: plan.acciones });
        return { id, texto, acciones: plan.acciones.map(({ descripcion }) => ({ descripcion })), dudas: plan.dudas };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },

    /** Applies a confirmed plan; each action reports on its own, so one failure does not stop the rest. */
    async apply(id) {
      const plan = plans.get(String(id || ''));
      if (!plan) throw new CardError('Ese plan ya no está: vuelve a decirlo', 410);
      plans.delete(id);
      const hechas = [];
      for (const a of plan.acciones) {
        try {
          hechas.push({ ok: true, texto: await applyAction(a, { dir, mealsDir, blocks, who: WHO }) });
        } catch (err) {
          hechas.push({ ok: false, texto: `${a.descripcion}: ${err.message}` });
        }
      }
      return { hechas, calendario: plan.acciones.some(touchesCalendar) };
    },
  };
}
