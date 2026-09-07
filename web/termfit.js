// Size the terminal to the window, and keep the guest's idea of it in step.
//
// The grid was fixed at xterm.js's 80x24 default and nothing ever resized it,
// so `stty size` said 24 80 whatever the browser window was doing. Anything
// over 24 rows scrolled away before it could be read, anything over 80 columns
// wrapped mid-record, and making the window bigger did nothing at all.
//
// There are two halves, and only doing the first is worse than doing neither:
// the page has to resize the xterm grid, AND the guest has to be told, or the
// two disagree and output wraps in the wrong place. A serial console carries
// no window-size signal - there is no TIOCSWINSZ across a uart - so the guest
// side is a plain `stty rows R cols C`, sent when the console is idle at a
// prompt so it cannot land in the middle of something.
'use strict';

const TERMFIT = (() => {
  const MIN_COLS = 20;
  const MIN_ROWS = 10;

  // xterm.js publishes no cell metrics; its own FitAddon reads exactly these
  // private renderer dimensions. Everything here is defensive, so a future
  // xterm that moves them leaves the grid alone rather than breaking the page.
  function cell(term) {
    try {
      const d = term._core._renderService.dimensions;
      if (d && d.css && d.css.cell && d.css.cell.width > 0 && d.css.cell.height > 0) {
        return { w: d.css.cell.width, h: d.css.cell.height };
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  function scrollbar(term) {
    try { return term._core.viewport.scrollBarWidth || 0; } catch (e) { return 0; }
  }

  function measure(term, el, win) {
    const c = cell(term);
    if (!c || !el) return null;
    let style = {};
    try { style = (win.getComputedStyle && win.getComputedStyle(el)) || {}; } catch (e) {}
    const px = (v) => parseInt(v, 10) || 0;
    const w = el.clientWidth - px(style.paddingLeft) - px(style.paddingRight) - scrollbar(term);
    const h = el.clientHeight - px(style.paddingTop) - px(style.paddingBottom);
    const cols = Math.floor(w / c.w);
    const rows = Math.floor(h / c.h);
    if (!isFinite(cols) || !isFinite(rows)) return null;
    return { cols: Math.max(MIN_COLS, cols), rows: Math.max(MIN_ROWS, rows) };
  }

  const exports = {
    measure,
    // Resize the grid if the window says it should be a different shape.
    // Returns the new geometry, or null if nothing changed or nothing could
    // be measured.
    fit(term, el, win) {
      const d = measure(term, el, win || window);
      if (!d) return null;
      if (d.cols === term.cols && d.rows === term.rows) return null;
      term.resize(d.cols, d.rows);
      return d;
    },
    // What the guest has to be told. The only channel is the console.
    stty(d) { return 'stty rows ' + d.rows + ' cols ' + d.cols; },

    // Keep the guest's idea of the terminal in step with the page's, retrying
    // until it actually lands.
    //
    // A resize made while the console is busy cannot simply be dropped. There
    // is no queue and no second trigger: the DOM `resize` event is the only
    // one, and `fit()` returns null once the grid already matches the window,
    // so dragging the window back to a size it has already been does not
    // re-fire it either. Miss the moment and the grid and the guest stay
    // divergent for the rest of the session — which is the failure this whole
    // module exists to prevent, arrived at from the other direction.
    makeSync({ geometry, canSend, send, delay }) {
      let told = null;
      let timer = null;
      const attempt = () => {
        timer = null;
        const want = geometry();
        if (!want || !want.cols || !want.rows) return;
        if (told && told.cols === want.cols && told.rows === want.rows) return;
        if (!canSend()) { timer = setTimeout(attempt, delay || 2000); return; }
        send(exports.stty(want) + '\n');
        told = { cols: want.cols, rows: want.rows };
      };
      return {
        request() { if (timer) { clearTimeout(timer); timer = null; } attempt(); },
        // what the guest was last told, so a handover can seed it
        seed(g) { told = g && { cols: g.cols, rows: g.rows }; },
        told: () => told,
        pending: () => timer !== null,
      };
    },
  };

  return exports;
})();
