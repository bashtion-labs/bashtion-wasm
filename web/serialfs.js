// Save/Load of the student's home directory over the serial console.
//
// Why the console: on this engine the authoritative emscripten FS lives in
// the pthread worker, and page-side Module.FS cannot see guest writes
// (measured). The pty is the one channel both sides share, so work travels
// as tar.gz/base64 between sentinels. The guest image disables bracketed
// paste, so pasted commands execute directly.
'use strict';

const SERIALFS = (() => {
  const HOME = '/home/user';
  const dec = new TextDecoder();
  let busy = false;
  const status = (m) => (window.__sfsStatus || console.log)('[work] ' + m);

  const serialLen = () => (window.__serial || '').length;
  const clean = (x) => x
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')  // OSC (incl. 3008 shell-integration)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');               // CSI
  const serialFrom = (i) => clean((window.__serial || '').slice(i));
  const paste = (t) => window.__paste(t);

  const waitFor = (re, from, timeoutMs) => new Promise((resolve) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const m = serialFrom(from).match(re);
      if (m) return resolve(m);
      if (Date.now() > end) return resolve(null);
      setTimeout(tick, 400);
    };
    tick();
  });

  // Confirm a live shell before pasting a capture command: a click during
  // boot/restore, or with a half-typed line, otherwise lands in a not-ready
  // console and hangs out the whole timeout with no file.
  async function ensureShell() {
    const t0 = serialLen();
    paste('\x15\n');                 // Ctrl-U clears any partial line, then Enter
    const m = await waitFor(/[$#] ?$/m, t0, 8000);
    return !!m;
  }

  async function exportWork() {
    if (busy) return null;
    busy = true;
    try {
      status('checking the shell…');
      if (!await ensureShell()) {
        status('click into the terminal and wait for the $ prompt, then try again');
        return null;
      }
      status('packing your work…');
      const t0 = serialLen();
      // stty -echo keeps the payload from being doubled by tty echo
      paste("stty -echo; printf '\\nBWT-BEGIN\\n'; tar czf - -C " + HOME +
            " --exclude=persist . 2>/dev/null | base64 -w0; printf '\\nBWT-END\\n'; stty echo\n");
      const m = await waitFor(/BWT-BEGIN\s*([A-Za-z0-9+/=\s]*?)\s*BWT-END/, t0, 120000);
      if (!m) { status('timed out — is the shell idle?'); return null; }
      const bin = Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      status('packed ' + (bin.length / 1024 | 0) + ' KB');
      return bin;
    } finally { busy = false; }
  }

  async function importWork(bytes) {
    if (busy) return false;
    busy = true;
    try {
      if (!await ensureShell()) {
        status('click into the terminal and wait for the $ prompt, then try again');
        return false;
      }
      status('restoring ' + (bytes.length / 1024 | 0) + ' KB…');
      let b64 = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
      }
      const t0 = serialLen();
      paste("stty -echo; base64 -d > /tmp/bw-work.tgz <<'BWEOF'\n");
      for (let i = 0; i < b64.length; i += 4096) {   // chunked for ldisc flow control
        paste(b64.slice(i, i + 4096) + '\n');
        await new Promise((r) => setTimeout(r, 30));
      }
      paste("BWEOF\ntar xzf /tmp/bw-work.tgz -C " + HOME + " && echo BWR-OK; stty echo\n");
      const ok = await waitFor(/BWR-OK/, t0, 120000);
      status(ok ? 'work restored' : 'restore timed out');
      return !!ok;
    } finally { busy = false; }
  }

  async function opfsWrite(bin) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('bashtion-work.tgz', { create: true });
    const w = await fh.createWritable();
    await w.write(bin); await w.close();
  }
  async function opfsRead() {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('bashtion-work.tgz');
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch (e) { return null; }
  }

  return {
    // Save: capture -> OPFS (survives reloads on this browser)
    async save() {
      const bin = await exportWork();
      if (bin) { await opfsWrite(bin); status('saved to this browser'); }
    },
    // Download: capture -> file the student keeps (survives anything)
    async download() {
      const bin = await exportWork();
      if (!bin) return;
      await opfsWrite(bin).catch(() => {});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bin], { type: 'application/gzip' }));
      a.download = 'bashtion-work-' + new Date().toISOString().slice(0, 10) + '.tgz';
      a.click(); URL.revokeObjectURL(a.href);
    },
    // Load: file picker if given a file, else whatever OPFS holds
    async load(file) {
      const bin = file ? new Uint8Array(await file.arrayBuffer()) : await opfsRead();
      if (!bin) { status('nothing saved in this browser yet'); return; }
      await importWork(bin);
    },
    hasSaved: () => opfsRead().then((b) => !!b),
  };
})();
