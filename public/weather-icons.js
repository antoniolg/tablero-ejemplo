// Weather icons drawn in SVG (the tablet's emoji font is from 2017). Names match src/weather.mjs.
import { html } from './dom.js';

const CLOUD = '<path class="wx-cloud" d="M7 19.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.9 9.5 4.6 4.6 0 0 1 17.5 19.5Z"/>';
const SUN = (cx, cy, r) => {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const [x1, y1, x2, y2] = [r + 1.6, r + 1.6, r + 3.6, r + 3.6].map((d, j) => (j % 2 ? cy + d * Math.sin(a) : cx + d * Math.cos(a)));
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
  }).join('');
  return `<g class="wx-sun"><circle cx="${cx}" cy="${cy}" r="${r}"/>${rays}</g>`;
};
const MOON = (cx, cy, r) => `<path class="wx-moon" d="M${cx + r * 0.35} ${cy - r}a${r} ${r} 0 1 0 ${r * 0.65} ${r * 1.55}a${r * 0.8} ${r * 0.8} 0 0 1-${r * 0.65}-${r * 1.55}Z"/>`;
const DROPS = '<g class="wx-rain"><path d="M9 21.5l-.8 1.8M13 21.5l-.8 1.8M17 21.5l-.8 1.8"/></g>';

const ICONS = {
  sol: SUN(12, 12, 4.6),
  luna: MOON(11, 12, 6.5),
  'sol-nubes': `${SUN(8.5, 8, 3.4)}${CLOUD}`,
  'luna-nubes': `${MOON(8, 8, 4.2)}${CLOUD}`,
  nubes: CLOUD,
  niebla: `${CLOUD}<g class="wx-fog"><path d="M4 22h11M8 24h12"/></g>`,
  lluvia: `${CLOUD}${DROPS}`,
  tormenta: `${CLOUD}<path class="wx-bolt" d="M12.8 15.5 10 20.2h2.6l-1.4 3.6 3.9-5.2h-2.6l1.6-3.1Z"/>`,
  nieve: `${CLOUD}<g class="wx-snow"><circle cx="9" cy="22.4" r=".9"/><circle cx="13" cy="23.4" r=".9"/><circle cx="17" cy="22.4" r=".9"/></g>`,
};

/** An inline SVG icon; the markup is static, never built from data. */
export function weatherIcon(name, className = '') {
  const body = ICONS[name] ?? ICONS.nubes;
  return html('span', { class: `wx ${className}`.trim(), 'aria-hidden': 'true' }, `<svg viewBox="0 -1 24 26">${body}</svg>`);
}
