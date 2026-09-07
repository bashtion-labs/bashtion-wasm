// bashtion — page bootstrap.
//
// This is deliberately an EXTERNAL module (not an inline <script>) so the page
// can run under a strict Content-Security-Policy that forbids inline scripts
// and inline event handlers. All DOM wiring happens here.
//
// Globals in scope come from the classic scripts index.html loads first:
//   Terminal   <- vendor/xterm.js
//   openpty    <- vendor/xterm-pty.js
//   SERIALFS   <- serialfs.js
//   SERIALTAP  <- serialtap.js
//   TERMFIT    <- termfit.js
//   Module     <- module.js   (globalThis.Module, the QEMU invocation)
import initQemu from './out.js';

const status = (m) => { document.getElementById('status').textContent = m; };

const termEl = document.getElementById('terminal');
const xterm = new Terminal({ scrollback: 5000 });
xterm.open(termEl);
const { master, slave } = openpty();
xterm.loadAddon(master);
Module.pty = slave;

// Test/automation hooks (harmless in normal use). The serial mirror is
// installed by serialtap.js, which keeps one streaming UTF-8 decoder for the
// session - xterm-pty splits its output into fixed 4096-byte chunks, so a
// per-chunk decoder replaces every straddling multi-byte sequence with U+FFFD.
SERIALTAP.install(master);
window.__paste = (s) => xterm.paste(s);
window.__xterm = xterm;

Module.mainScriptUrlOrBlob = new URL('./out.js', location.href).href;
status('VM starting (bundles preloaded by emscripten)…');
const instance = await initQemu(Module);

// xterm-pty poll fix, as proven in the ktock harness.
const oldPoll = Module.TTY.stream_ops.poll;
const pty = Module.pty;
Module.TTY.stream_ops.poll = function (stream, timeout) {
  if (!pty.readable) return (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
  return oldPoll.call(stream, timeout);
};
status('running');

// Terminal geometry. The grid follows the window, and the guest is told what
// shape it is now in - a serial console carries no window-size signal, so
// `stty` is the whole mechanism. The push is retried until it lands: it must
// not go into a half-typed command line, and it must not go into a save or
// restore (between blocks the console tail looks exactly like an idle prompt,
// and the next `head -c N` would eat it as archive payload) - but a resize
// made during either cannot just be dropped, or the two stay divergent for
// the rest of the session.
window.__fit = () => TERMFIT.fit(xterm, termEl, window);
const geomSync = TERMFIT.makeSync({
  geometry: () => ({ cols: xterm.cols, rows: xterm.rows }),
  canSend: () => window.__booted && !SERIALFS.isBusy() && SERIALTAP.atPrompt(window),
  send: (text) => xterm.paste(text),
});
window.__geomSync = geomSync;
// The renderer may not have measured a cell yet on the first attempt; keep
// trying briefly rather than leave the grid at xterm's 80x24 default, which
// is the state this fixes.
(function settle(n) {
  if (TERMFIT.measure(xterm, termEl, window)) { window.__fit(); return; }
  if (n > 0) setTimeout(() => settle(n - 1), 250);
})(12);
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { window.__fit(); geomSync.request(); }, 400);
});

// Controls — wired here, never via inline on* attributes, so the strict CSP
// needs no 'unsafe-inline'.
window.__sfsStatus = (m) => { document.getElementById('sfsStatus').textContent = m; };
const importInp = document.getElementById('importInp');
const refreshSaved = () => SERIALFS.hasSaved().then((h) => {
  window.__sfsStatus(h ? 'saved work found in this browser' : '');
  return h;
});
document.getElementById('exportBtn').onclick = async () => {
  await SERIALFS.download();
  refreshSaved();
};
// "Load work" restores the browser's own copy when there is one. The status
// line used to advertise that copy while the only control on the page opened
// a file picker, so the one thing it promised was the one thing you could not
// do. Choosing a file is still there, as its own button.
document.getElementById('loadBtn').onclick = async () => {
  if (await SERIALFS.hasSaved()) SERIALFS.load();
  else importInp.click();
};
document.getElementById('loadFileBtn').onclick = () => importInp.click();
importInp.onchange = (e) => {
  if (e.target.files[0]) SERIALFS.load(e.target.files[0]);
  e.target.value = '';
};
refreshSaved();

if (Module.bashtionRestore) {
  // The wasm engine loads incoming state but leaves the VM paused (native QEMU
  // auto-resumes; the wasm build does not). Issue monitor 'cont' through the
  // -nographic mux, then switch back to the serial console and wake the prompt.
  (async () => {
    const feed = (t) => { if (window.__paste) window.__paste(t); };
    await new Promise((r) => setTimeout(r, 4000));
    feed('\x01'); feed('c');
    await new Promise((r) => setTimeout(r, 1200));
    feed('cont\n');
    await new Promise((r) => setTimeout(r, 1200));
    feed('\x01'); feed('c');
    await new Promise((r) => setTimeout(r, 800));
    feed('\n');
    status('resumed - your session is exactly where it was');
  })();
}
