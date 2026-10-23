#!/usr/bin/env node
// `tareas`: read and change the task board from the shell (agents and scripts).
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CardError, COLUMNS, STATES, STATE_LABELS, addNote, columnOf, createCard, displayName, editCard,
  flagsOf, getCard, listCards, moveCard, shortDate, summaryMarkdown, tasksDir, today,
} from '../src/cards.mjs';

const HELP = `tareas: el tablero de tareas (una ficha por tarea en ${tasksDir()})

Leer
  tareas resumen                      el tablero en Markdown (para dar contexto a un agente)
  tareas lista [--columna X] [--estado X] [--todo] [--json]
  tareas ver <id> [--json]            la ficha completa: cabecera, contexto y bitácora

Cambiar (añade siempre --quien claude|codex|hermes…; por defecto $TAREAS_QUIEN o «agente»)
  tareas nueva "<título>" [--siguiente ..] [--estado bandeja] [--area ..] [--ambito pro|personal]
               [--fecha AAAA-MM-DD] [--limite "AAAA-MM-DD HH:MM"] [--revisar AAAA-MM-DD]
               [--responsable ..] [--origen ..] [--contexto ..] [--nota ..]
  tareas mover <id> <estado> [--nota ..] [--revisar ..] [--responsable ..] [--evidencia ..]
  tareas editar <id> [--titulo ..] [--siguiente ..] [--fecha ..] [--limite ..] [--revisar ..]
               [--responsable ..] [--area ..] [--ambito ..] [--origen ..] [--evidencia ..] [--nota ..]
  tareas nota <id> "<texto>"           apunta algo en la bitácora
  tareas coger <id>                   «hazte cargo»: la pasa a Agente a tu nombre
  tareas cerrar <id> --evidencia ..   la marca como hecha
  tareas soltar <id> [--motivo ..]    soltarla también es cerrarla
  tareas ruta                         la carpeta de las fichas

Estados: ${STATES.map((s) => `${s} (${STATE_LABELS[s]})`).join(', ')}
Un campo vacío ("") lo borra. Los ids valen como T-012 o 12.
`;

const TEXT = { type: 'string' };
const FIELD_OPTIONS = {
  titulo: TEXT, siguiente: TEXT, estado: TEXT, area: TEXT, ambito: TEXT, fecha: TEXT, limite: TEXT,
  revisar: TEXT, responsable: TEXT, origen: TEXT, evidencia: TEXT, contexto: TEXT,
};

function parse(args, options, positionals) {
  const { values, positionals: rest } = parseArgs({
    args, options: { quien: TEXT, nota: TEXT, json: { type: 'boolean' }, ...options }, allowPositionals: true,
  });
  if (rest.length !== positionals) throw new CardError(`Uso incorrecto. Mira «tareas --help».`);
  return { values, rest, who: values.quien || process.env.TAREAS_QUIEN || 'agente' };
}

function cardLine(card, day) {
  const bits = [card.siguiente && `→ ${card.siguiente}`];
  if (card.responsable && !['antonio', 'agente'].includes(card.responsable)) bits.push(`espera a ${card.responsable}`);
  if (card.agente && card.estado === 'agente') bits.push(`la lleva ${displayName(card.agente)}`);
  if (card.fecha) bits.push(`plan ${shortDate(card.fecha)}`);
  if (card.limite) bits.push(`límite ${card.limite}`);
  if (card.revisar) bits.push(`revisar ${shortDate(card.revisar)}`);
  for (const flag of flagsOf(card, day)) bits.push(`⚠ ${flag.texto}`);
  const meta = bits.filter(Boolean).join(' · ');
  return `  ${card.id}  ${card.titulo}${meta ? `\n          ${meta}` : ''}`;
}

async function list(args) {
  const { values } = parse(args, { columna: TEXT, estado: TEXT, todo: { type: 'boolean' } }, 0);
  const day = today();
  let cards = (await listCards(tasksDir())).map((card) => ({ ...card, columna: columnOf(card, day), avisos: flagsOf(card, day) }));
  if (values.estado) cards = cards.filter((c) => c.estado === values.estado);
  if (values.columna) cards = cards.filter((c) => c.columna === values.columna);
  if (!values.todo) cards = cards.filter((c) => c.columna !== 'archivo');
  if (values.json) return console.log(JSON.stringify(cards, null, 2));
  const order = [...COLUMNS.map((c) => c.id), 'mas-adelante', 'archivo'];
  const label = { ...Object.fromEntries(COLUMNS.map((c) => [c.id, c.label])), 'mas-adelante': 'Más adelante', archivo: 'Archivo' };
  for (const column of order) {
    const group = cards.filter((c) => c.columna === column);
    if (group.length) console.log(`${label[column]} (${group.length})\n${group.map((c) => cardLine(c, day)).join('\n')}\n`);
  }
  if (!cards.length) console.log('No hay tareas que coincidan.');
}

async function show(args) {
  const { values, rest } = parse(args, {}, 1);
  const card = await getCard(tasksDir(), rest[0]);
  if (values.json) return console.log(JSON.stringify(card, null, 2));
  const file = path.join(tasksDir(), `${card.id}.md`);
  console.log(`# ${file}\n\n${await readFile(file, 'utf8')}`);
}

function fieldsFrom(values) {
  return Object.fromEntries(Object.keys(FIELD_OPTIONS).filter((k) => values[k] !== undefined).map((k) => [k, values[k]]));
}

function done(card, verb) {
  console.log(`${card.id} ${verb}: ${card.titulo} [${STATE_LABELS[card.estado] ?? card.estado}]`);
}

const COMMANDS = {
  lista: list,
  resumen: async () => console.log(summaryMarkdown(await listCards(tasksDir())).trimEnd()),
  ver: show,
  ruta: async () => console.log(tasksDir()),
  async nueva(args) {
    const { values, rest, who } = parse(args, FIELD_OPTIONS, 1);
    const card = await createCard(tasksDir(), { ...fieldsFrom(values), titulo: rest[0], nota: values.nota }, { who });
    done(card, 'creada');
  },
  async mover(args) {
    const { values, rest, who } = parse(args, { revisar: TEXT, responsable: TEXT, evidencia: TEXT }, 2);
    const card = await moveCard(tasksDir(), rest[0], rest[1], { ...values, note: values.nota, who });
    done(card, 'movida');
  },
  async editar(args) {
    const { values, rest, who } = parse(args, FIELD_OPTIONS, 1);
    const changes = fieldsFrom(values);
    if ('estado' in changes) throw new CardError('Para cambiar el estado usa «tareas mover».');
    if ('contexto' in changes) throw new CardError('El contexto se cambia editando la ficha («tareas ruta»).');
    done(await editCard(tasksDir(), rest[0], changes, { note: values.nota, who }), 'editada');
  },
  async nota(args) {
    const { rest, who } = parse(args, {}, 2);
    done(await addNote(tasksDir(), rest[0], rest[1], { who }), 'anotada');
  },
  async coger(args) {
    const { values, rest, who } = parse(args, {}, 1);
    const note = `La coge ${displayName(who)}${values.nota ? `. ${values.nota}` : ''}`;
    done(await moveCard(tasksDir(), rest[0], 'agente', { agente: who, note, who }), 'cogida');
  },
  async cerrar(args) {
    const { values, rest, who } = parse(args, { evidencia: TEXT }, 1);
    done(await moveCard(tasksDir(), rest[0], 'hecha', { evidencia: values.evidencia, note: values.nota, who }), 'cerrada');
  },
  async soltar(args) {
    const { values, rest, who } = parse(args, { motivo: TEXT }, 1);
    done(await moveCard(tasksDir(), rest[0], 'soltada', { note: values.motivo ?? values.nota, who }), 'soltada');
  },
};

async function main(argv) {
  const [command, ...args] = argv;
  if (!command || ['-h', '--help', 'help', 'ayuda'].includes(command)) return console.log(HELP);
  const run = COMMANDS[command];
  if (!run) throw new CardError(`No conozco «${command}». Mira «tareas --help».`);
  await run(args);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof CardError || String(err.code).startsWith('ERR_PARSE_ARGS') ? err.message : err.stack);
  process.exitCode = 1;
});
