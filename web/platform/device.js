/* What kind of device this is, read once at load: the glass switch, the phone, the tablet. */

/* pointer: coarse, not hover: none: an iPad with a trackpad gains hover but keeps the finger. */
const TOUCH = (() => {
  try {
    // localStorage "strata.touch": "1" forces the touch UI on, "0" off; unset asks the pointer
    const o = localStorage.getItem("strata.touch");
    if (o === "1" || o === "0") return o === "1";
    return window.matchMedia("(pointer: coarse)").matches;
  } catch (e) { return false; }
})();

/* Read once at load; a window not yet laid out reports 0 width, so fall through to the screen. */
const PHONE = (() => { try { return (window.innerWidth || window.screen.width || 1024) <= 620; } catch (e) { return false; } })();

/* Portrait iPads lay out at ~550px under the room's 1.4x type, so tablets get a smaller default scale. */
const TABLET = (() => {
  try {
    if (PHONE) return false;
    const w = window.innerWidth || window.screen.width || 1024, h = window.innerHeight || window.screen.height || 768;
    return Math.max(w, h) <= 1400 && Math.min(w, h) <= 1024 && TOUCH;   // TOUCH, so the strata.touch override reaches here too
  } catch (e) { return false; }
})();

export { TOUCH, PHONE, TABLET };
