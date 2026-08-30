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
//   Module     <- module.js   (globalThis.Module, the QEMU invocation)
import initQemu from './out.js';

const status = (m) => { document.getElementById('status').textContent = m; };

const xterm = new Terminal({ scrollback: 5000 });
xterm.open(document.getElementById('terminal'));
const { master, slave } = openpty();
xterm.loadAddon(master);
Module.pty = slave;

// Test/automation hooks (harmless in normal use).
window.__serial = '';
master.onWrite(([buf]) => { window.__serial += new TextDecoder().decode(buf); });
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

// Controls — wired here, never via inline on* attributes, so the strict CSP
// needs no 'unsafe-inline'.
window.__sfsStatus = (m) => { document.getElementById('sfsStatus').textContent = m; };
const importInp = document.getElementById('importInp');
document.getElementById('exportBtn').onclick = () => SERIALFS.download();
document.getElementById('loadBtn').onclick = () => importInp.click();
importInp.onchange = (e) => {
  if (e.target.files[0]) SERIALFS.load(e.target.files[0]);
  e.target.value = '';
};
SERIALFS.hasSaved().then((h) => {
  if (h) window.__sfsStatus('saved work found — Load work restores it');
});

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
