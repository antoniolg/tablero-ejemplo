// Drag and drop with pointer events, so it works with a finger on the tablet as well as with a mouse.
// A mouse picks the item up as soon as it moves; a finger has to hold it briefly first, so a plain
// swipe still scrolls the page.

const HOLD_MS = 280;
const SLOP = 8;
let active = false;

/** True while an item is being dragged (or for the rest of the gesture that dropped it). */
export const dragging = () => active;

/**
 * Makes `el` draggable onto any element matching `targets`.
 * `onDrop(target)` runs when it is released over a different target.
 */
export function draggable(el, { targets, onDrop }) {
  el.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    const touch = down.pointerType !== 'mouse';
    const start = { x: down.clientX, y: down.clientY };
    let ghost = null;
    let over = null;
    let hold = null;

    const lift = () => {
      active = true;
      const box = el.getBoundingClientRect();
      ghost = el.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${box.width}px`;
      ghost.style.height = `${box.height}px`;
      ghost.dataset.dx = String(start.x - box.left);
      ghost.dataset.dy = String(start.y - box.top);
      document.body.append(ghost);
      el.classList.add('drag-source');
      navigator.vibrate?.(15);
    };
    const place = (x, y) => {
      // left/top rather than transform: a moving transform is a layer of its own, which the tablet's GPU breaks.
      ghost.style.left = `${x - Number(ghost.dataset.dx)}px`;
      ghost.style.top = `${y - Number(ghost.dataset.dy)}px`;
      const hit = document.elementFromPoint(x, y)?.closest(targets);
      const target = hit && hit !== el ? hit : null;
      if (target !== over) {
        over?.classList.remove('drop-target');
        target?.classList.add('drop-target');
        over = target;
      }
    };
    // While dragging with a finger, the page must not scroll under it.
    const blockScroll = (event) => {
      if (ghost) event.preventDefault();
    };
    const move = (event) => {
      if (event.pointerId !== down.pointerId) return;
      const far = Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP;
      if (!ghost) {
        if (!far) return;
        if (touch) return finish(); // moved before the hold: it is a scroll or a swipe
        lift();
      }
      place(event.clientX, event.clientY);
    };
    const finish = (event) => {
      clearTimeout(hold);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('touchmove', blockScroll);
      if (!ghost) return;
      ghost.remove();
      el.classList.remove('drag-source');
      over?.classList.remove('drop-target');
      // The click that may follow a drop must not open the slot; a later tap must still work.
      const swallow = (click) => click.stopImmediatePropagation();
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 400);
      setTimeout(() => { active = false; }, 0);
      if (event?.type === 'pointerup' && over) onDrop(over);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('touchmove', blockScroll, { passive: false });
    if (touch) {
      hold = setTimeout(() => {
        lift();
        place(start.x, start.y);
      }, HOLD_MS);
    }
  });
  // Long-press on Android would otherwise open the context menu or select text.
  el.addEventListener('contextmenu', (event) => event.preventDefault());
}
