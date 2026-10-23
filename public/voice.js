// Voice commands: the mic above the light/dark switch records a short note, the Mac transcribes it
// and Claude turns it into a plan over tasks, meals and work blocks, shown here to confirm (the server
// keeps the plan and writes the sentences). Nothing changes until «Hacerlo».
import { $, api, h, notify } from './dom.js';

const MAX_SECONDS = 30;
let recorder = null;
let stopTimer = null;

function sheet(...children) {
  const dialog = $('#ask');
  dialog.replaceChildren(h('div', { class: 'form' }, ...children));
  if (!dialog.open) dialog.showModal();
  return dialog;
}

function showPlan({ id, texto, acciones, dudas }) {
  const dialog = $('#ask');
  const apply = async () => {
    dialog.close();
    try {
      const { hechas } = await api('/api/voz/aplicar', { method: 'POST', body: { plan: id } });
      const fallos = hechas.filter((x) => !x.ok);
      notify(fallos.length ? `No todo ha salido: ${fallos.map((x) => x.texto).join(' · ')}` : hechas.map((x) => x.texto).join(' · '));
    } catch (err) {
      notify(err.message);
    }
  };
  sheet(
    h('h2', {}, 'Esto he entendido'),
    h('p', { class: 'voice-heard' }, `«${texto}»`),
    acciones.length ? h('ul', { class: 'voice-plan' }, acciones.map((a) => h('li', {}, a.descripcion)))
      : h('p', { class: 'hint' }, 'No veo nada que hacer en el tablero.'),
    dudas ? h('p', { class: 'hint' }, dudas) : null,
    h('div', { class: 'row end' },
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancelar'),
      acciones.length ? h('button', { type: 'button', class: 'primary', onclick: apply }, 'Hacerlo') : null));
}

async function send(blob) {
  sheet(h('h2', {}, 'Un momento…'), h('p', { class: 'hint' }, 'Transcribiendo y pensando qué hacer. Tarda unos 10 segundos.'));
  try {
    const res = await fetch('/api/voz', { method: 'POST', headers: { 'X-Tablero': '1', 'Content-Type': blob.type || 'audio/webm' }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    showPlan(data);
  } catch (err) {
    $('#ask').close();
    notify(err.message);
  }
}

async function start(button) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return notify('Este navegador no deja usar el micrófono en el tablero.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return notify('Sin permiso para el micrófono.');
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.addEventListener('dataavailable', (event) => chunks.push(event.data));
  recorder.addEventListener('stop', () => {
    stream.getTracks().forEach((track) => track.stop());
    button.setAttribute('aria-pressed', 'false');
    clearTimeout(stopTimer);
    recorder = null;
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    if (blob.size) send(blob);
  });
  recorder.start();
  button.setAttribute('aria-pressed', 'true');
  stopTimer = setTimeout(() => recorder?.stop(), MAX_SECONDS * 1000);
}

/** Tap to talk, tap again to send. */
export function initVoice() {
  const button = $('#voice');
  button.addEventListener('click', () => (recorder ? recorder.stop() : start(button)));
}
