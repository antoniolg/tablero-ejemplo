// A sideways swipe on the calendar calls `onSwipe(1 | -1)` once the finger lifts past a threshold.
// Nothing moves while the finger does: on the tablet's GPU renderer, an element that moves on its own
// layer (a transform that changes, will-change, an animation) is drawn wrong, so the next week simply
// appears. Touch events, because Firefox cancels pointer events as soon as the hours start to scroll;
// vertical moves keep scrolling.
export function onSideSwipe(el, onSwipe, { threshold = 60 } = {}) {
  let start = null;
  let dx = 0;
  let horizontal = null;
  el.addEventListener('touchstart', (event) => {
    start = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    dx = 0;
    horizontal = null;
  }, { passive: true });
  el.addEventListener('touchmove', (event) => {
    if (!start) return;
    const x = event.touches[0].clientX - start.x;
    const y = event.touches[0].clientY - start.y;
    if (horizontal === null && Math.hypot(x, y) > 10) horizontal = Math.abs(x) > Math.abs(y) * 1.3;
    if (!horizontal) return;
    event.preventDefault(); // sideways is ours: neither a scroll nor the browser's back gesture
    dx = x;
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (start && horizontal && Math.abs(dx) > threshold) onSwipe(dx < 0 ? 1 : -1);
    start = null;
  });
  el.addEventListener('touchcancel', () => { start = null; });
}
