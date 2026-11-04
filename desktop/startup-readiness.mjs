/**
 * Deciding when a starting app may replace its splash with the real interface.
 *
 * Kept out of main.mjs so it can be tested without Electron. The bug it exists
 * to prevent is a window that never leaves the splash: a cold start takes tens
 * of seconds (the backend only listens once Pi has loaded), and the one 1.5s
 * probe `openWindow` does therefore misses on every launch. Nothing in the
 * splash document can navigate on its own, so without a watcher the app sat at
 * "Starting local services…" indefinitely.
 */

/** How often to re-probe while waiting. */
export const READY_POLL_MS = 500;
/** Give up rather than probing forever; the window keeps its splash message. */
export const READY_DEADLINE_MS = 10 * 60 * 1000;

/** Cheap reachability probe. Any non-2xx, throw, or timeout reads as "no". */
export async function answers(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve true once both services answer, false on the deadline or when
 * `stopped()` turns true (the window navigated or went away — something else
 * already took responsibility for what the user sees).
 *
 * Both are required: the interface is served by the frontend, so a ready
 * backend alone would navigate the window to a connection-refused page.
 */
export async function pollUntilReady({
  backendUrl,
  uiUrl,
  stopped = () => false,
  deadline = Date.now() + READY_DEADLINE_MS,
  pollMs = READY_POLL_MS,
  probe = answers,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (stopped()) return false;
    if (!(await probe(backendUrl))) continue;
    if (stopped()) return false;
    if (await probe(uiUrl)) return true;
  }
  return false;
}
