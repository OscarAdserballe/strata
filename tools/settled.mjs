// Wait on the room, not the clock: each helper returns when its condition holds and throws if it never does.

/** Every request the room counts has answered, and one more frame lets React commit the results. */
export async function settled(page, timeout = 15_000) {
  const out = await page.evaluate((timeout) => !window.__strataPending ? 0 : new Promise((resolve) => {
    const late = setTimeout(() => resolve(window.__strataPending), timeout);
    addEventListener("strata:settled", () => { clearTimeout(late); resolve(0); }, { once: true });
  }), timeout);
  if (out) throw new Error(`timed out after ${timeout} ms waiting for the room to settle (${out} requests still out)`);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))));
}

/** Run `act`, then wait until a request it caused has left and every request has answered. */
export async function afterRequests(page, act, timeout = 15_000) {
  const before = await page.evaluate(() => window.__strataSent || 0);
  await act();
  await page.waitForFunction((n) => (window.__strataSent || 0) > n, before, { timeout });
  await settled(page, timeout);
}

/** The element has stopped moving: same scroll, height, drawn pages and box on two looks `every` ms apart. */
export async function atRest(page, selector = ".page", { every = 150, timeout = 15_000 } = {}) {
  const key = `__atRest${Math.random().toString(36).slice(2)}`;
  await page.waitForFunction(({ selector, key }) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const drawn = el.querySelectorAll("canvas, .tlayer").length;
    const box = el.getBoundingClientRect();
    const now = [el.scrollTop, el.scrollHeight, drawn, box.left, box.top, box.width, box.height].map(Math.round).join(":");
    const was = window[key];
    window[key] = now;
    return was === now;
  }, { selector, key }, { polling: every, timeout });
}

/** No finite animation or transition is running (an infinite spinner never finishes, so it is ignored). */
export function still(page, timeout = 10_000) {
  return page.waitForFunction(() => document.getAnimations().every((a) =>
    a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout });
}

/** Poll an async node-side check until it returns something truthy; returns that value. */
export async function until(check, { what = "the condition", every = 100, timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}
