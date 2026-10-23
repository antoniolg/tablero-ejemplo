// Weeks of Google Calendar events, shared by the calendar and home panels. A week already seen
// paints at once while the server is asked again (it answers from its own cache and brings four
// weeks from Google per call), and the weeks next to the one on screen are fetched ahead.
import { api } from './dom.js';

const KEEP = 16;
const FRESH = 2 * 60_000; // a copy younger than this is not fetched ahead again
const weeks = new Map(); // monday → { data, at }, the most recent last
const asking = new Map(); // monday (or `monday!` for a refresh) → the request on its way

/** The copy in memory of a week, or null. */
export const cachedWeek = (monday) => weeks.get(monday)?.data ?? null;

/** Asks the server for a week and keeps the answer; callers asking at the same time share the request. */
export function loadWeek(monday, { refresh = false } = {}) {
  const key = refresh ? `${monday}!` : monday;
  if (asking.has(key)) return asking.get(key);
  const request = api(`/api/calendario?desde=${monday}${refresh ? '&refrescar=1' : ''}`)
    .then((data) => {
      weeks.delete(monday);
      weeks.set(monday, { data, at: Date.now() });
      if (weeks.size > KEEP) weeks.delete(weeks.keys().next().value);
      return data;
    })
    .finally(() => asking.delete(key));
  asking.set(key, request);
  return request;
}

/** When the page is idle, fetches the weeks it has no recent copy of (the neighbours of the one on screen). */
export function prefetchWeeks(mondays) {
  const run = () => {
    for (const monday of mondays) {
      const copy = weeks.get(monday);
      if (!copy || Date.now() - copy.at > FRESH) loadWeek(monday).catch(() => {});
    }
  };
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 300);
}

/** Google changed (the server said so): the copies still paint at once, but are asked for again. */
export function expireWeeks() {
  for (const copy of weeks.values()) copy.at = 0;
}
