import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';

const TERMFIT = loadScript('termfit.js', 'TERMFIT',
  { window: {}, Math, parseInt, isFinite, setTimeout, clearTimeout });

// a controllable clock, so the retry loop can be driven without waiting
function fakeClock() {
  let queue = [], id = 0;
  return {
    setTimeout: (fn, ms) => { queue.push({ id: ++id, fn }); return id; },
    clearTimeout: (t) => { queue = queue.filter((q) => q.id !== t); },
    tick() { const due = queue; queue = []; due.forEach((q) => q.fn()); return due.length; },
    pending: () => queue.length,
  };
}
function syncHarness(opts = {}) {
  const clock = fakeClock();
  const T = loadScript('termfit.js', 'TERMFIT',
    { window: {}, Math, parseInt, isFinite,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const state = { geom: { cols: 80, rows: 24 }, can: true, sent: [] };
  const sync = T.makeSync({
    geometry: () => state.geom,
    canSend: () => state.can,
    send: (t) => state.sent.push(t),
    ...opts,
  });
  return { clock, sync, state };
}

// An xterm-shaped object exposing the private renderer dimensions FitAddon reads.
const term = (cw, ch, cols = 80, rows = 24, bar = 0) => ({
  cols, rows, resized: null,
  resize(c, r) { this.cols = c; this.rows = r; this.resized = { c, r }; },
  _core: { _renderService: { dimensions: { css: { cell: { width: cw, height: ch } } } },
           viewport: { scrollBarWidth: bar } },
});
// The xterm 4.19.0 shape the shipped page really gets: all twelve fields, no
// `css`. At device pixel ratio 2 the `scaled*` device pixels are twice the CSS
// pixel `actual*` ones, so dividing by the wrong pair gives a different grid.
const term4 = (cw, ch, cols = 80, rows = 24, bar = 0, dpr = 2) => ({
  cols, rows, resized: null,
  resize(c, r) { this.cols = c; this.rows = r; this.resized = { c, r }; },
  _core: { _renderService: { dimensions: {
             scaledCharWidth: cw * dpr, scaledCharHeight: ch * dpr,
             scaledCellWidth: cw * dpr, scaledCellHeight: ch * dpr,
             scaledCharLeft: 0, scaledCharTop: 0,
             scaledCanvasWidth: cols * cw * dpr, scaledCanvasHeight: rows * ch * dpr,
             canvasWidth: cols * cw, canvasHeight: rows * ch,
             actualCellWidth: cw, actualCellHeight: ch } },
           viewport: { scrollBarWidth: bar } },
});
const box = (w, h) => ({ clientWidth: w, clientHeight: h });
const win = { getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px',
                                         paddingTop: '0px', paddingBottom: '0px' }) };

test('#60 the grid follows the window instead of staying at 80x24', () => {
  const t = term(9, 18);
  const d = TERMFIT.fit(t, box(1440, 780), win);
  assert.deepEqual(d, { cols: 160, rows: 43 });
  assert.equal(t.cols, 160);
  assert.equal(t.rows, 43);
});

test('#60 padding and the scrollbar are taken out of the usable width', () => {
  const t = term(10, 20, 80, 24, 15);
  const padded = { getComputedStyle: () => ({ paddingLeft: '5px', paddingRight: '5px',
                                              paddingTop: '4px', paddingBottom: '6px' }) };
  const d = TERMFIT.measure(t, box(1005, 410), padded);
  assert.deepEqual(d, { cols: 98, rows: 20 });
});

test('#60 a tiny window still leaves a usable terminal', () => {
  const t = term(9, 18);
  assert.deepEqual(TERMFIT.measure(t, box(50, 40), win), { cols: 20, rows: 10 });
});

test('#60 an unmeasurable terminal is left alone rather than broken', () => {
  const blind = { cols: 80, rows: 24, resize() { throw new Error('must not resize'); }, _core: {} };
  assert.equal(TERMFIT.measure(blind, box(800, 600), win), null);
  assert.equal(TERMFIT.fit(blind, box(800, 600), win), null);
});

test('#60 an unchanged shape does not churn the guest', () => {
  const t = term(10, 20, 80, 24);
  assert.equal(TERMFIT.fit(t, box(800, 480), win), null);
  assert.equal(t.resized, null);
});

test('#60 the guest is told in the only language a serial console has', () => {
  assert.equal(TERMFIT.stty({ cols: 160, rows: 43 }), 'stty rows 43 cols 160');
});

// ------------------------------------------------- the shipped xterm 4.19.0
test('xterm 4: a desktop window resizes the grid off 80x24', () => {
  const t = term4(9, 17, 80, 24, 15);
  const d = TERMFIT.fit(t, box(1280, 770), win);
  assert.deepEqual(d, { cols: 140, rows: 45 });
  assert.deepEqual(t.resized, { c: 140, r: 45 });
  assert.equal(t.cols, 140);
  assert.equal(t.rows, 45);
});

test('xterm 4: a phone-width window gets fewer than 80 columns', () => {
  // the box a 390 px wide window leaves under a control bar; the bar's height
  // there depends on the width, and only the arithmetic is checked here
  const t = term4(9, 17, 80, 24, 15);
  assert.deepEqual(TERMFIT.measure(t, box(390, 814), win), { cols: 41, rows: 47 });
});

test('xterm 4: before the first measurement the grid is left alone', () => {
  const t = term4(0, 0);
  t.resize = () => { throw new Error('must not resize'); };
  const dims = t._core._renderService.dimensions;
  assert.equal(Object.keys(dims).length, 12);
  assert.ok(Object.values(dims).every((v) => v === 0));
  assert.equal(TERMFIT.measure(t, box(1280, 770), win), null);
  assert.equal(TERMFIT.fit(t, box(1280, 770), win), null);
});


// ---------------------------------------------------------------- sync
test('#60 a resize while the console is busy is retried, not dropped', () => {
  const { clock, sync, state } = syncHarness();
  state.can = false;                       // a transfer owns the console
  state.geom = { cols: 200, rows: 50 };
  sync.request();
  assert.deepEqual(state.sent, [], 'must not type into a busy console');
  assert.ok(sync.pending(), 'the resize must stay queued');

  clock.tick();                            // still busy
  assert.deepEqual(state.sent, []);
  assert.ok(sync.pending());

  state.can = true;                        // transfer ends, prompt returns
  clock.tick();
  assert.deepEqual(state.sent, ['stty rows 50 cols 200\n']);
  assert.ok(!sync.pending(), 'no retry should remain once it has landed');
});

test('#60 the same geometry is never re-sent', () => {
  const { sync, state } = syncHarness();
  state.geom = { cols: 120, rows: 40 };
  sync.request();
  sync.request();
  sync.request();
  assert.deepEqual(state.sent, ['stty rows 40 cols 120\n']);
});

test('#60 a handover seed counts as already told', () => {
  const { sync, state } = syncHarness();
  sync.seed({ cols: 80, rows: 24 });       // what the boot screen sent
  state.geom = { cols: 80, rows: 24 };
  sync.request();
  assert.deepEqual(state.sent, [], 'the boot screen already told the guest');
  state.geom = { cols: 100, rows: 30 };
  sync.request();
  assert.deepEqual(state.sent, ['stty rows 30 cols 100\n']);
});

test('#60 a resize back to a size the guest already knows needs no message', () => {
  const { sync, state } = syncHarness();
  state.geom = { cols: 100, rows: 30 };
  sync.request();
  state.geom = { cols: 150, rows: 45 };
  sync.request();
  state.geom = { cols: 150, rows: 45 };
  sync.request();
  assert.deepEqual(state.sent, ['stty rows 30 cols 100\n', 'stty rows 45 cols 150\n']);
});
