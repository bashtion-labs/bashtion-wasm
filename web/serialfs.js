// Save/Load of the user's home directory over the serial console, with a
// clean overlay so the raw transfer (a base64 tar streaming across the tty)
// is never shown. The overlay covers the terminal during a transfer, the
// bytes are captured from the serial tap behind it, and the scrollback is
// cleared afterwards so you return to a tidy prompt.
'use strict';

const SERIALFS = (() => {
  const HOME = '/home/user';
  let busy = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // strip OSC (incl. 26.04 shell-integration OSC 3008) + CSI before matching
  const clean = (x) => x
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const serialLen = () => (window.__serial || '').length;
  const serialFrom = (i) => clean((window.__serial || '').slice(i));
  const paste = (t) => window.__paste(t);

  const waitFor = (re, from, timeoutMs) => new Promise((resolve) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const m = serialFrom(from).match(re);
      if (m) return resolve(m);
      if (Date.now() > end) return resolve(null);
      setTimeout(tick, 300);
    };
    tick();
  });

  // ---- overlay -----------------------------------------------------------
  const ov = (() => {
    let el, title, bar, sub, timer;
    function build() {
      el = document.createElement('div');
      el.id = 'bwOverlay';
      el.style.cssText =
        'position:fixed;inset:0;z-index:9999;display:none;align-items:center;' +
        'justify-content:center;background:#111;color:#e6e6e6;font:15px system-ui';
      el.innerHTML =
        '<div style="width:min(420px,80vw);text-align:center">' +
        '<div id="bwOvTitle" style="font-size:17px;margin-bottom:14px"></div>' +
        '<div style="height:8px;border-radius:4px;background:#2a2a2a;overflow:hidden">' +
        '<div id="bwOvBar" style="height:100%;width:30%;background:#4a9eff;border-radius:4px"></div>' +
        '</div><div id="bwOvSub" style="margin-top:10px;color:#9a9a9a;font-size:13px"></div></div>';
      document.body.appendChild(el);
      title = el.querySelector('#bwOvTitle');
      bar = el.querySelector('#bwOvBar');
      sub = el.querySelector('#bwOvSub');
      // indeterminate keyframes (once)
      const st = document.createElement('style');
      st.textContent =
        '@keyframes bwSlide{0%{margin-left:-30%}100%{margin-left:100%}}' +
        '.bwIndet{animation:bwSlide 1.1s linear infinite}';
      document.head.appendChild(st);
    }
    return {
      show(t) { if (!el) build(); clearTimeout(timer); title.textContent = t; sub.textContent = '';
                bar.classList.add('bwIndet'); bar.style.width = '30%'; el.style.display = 'flex'; },
      title(t) { if (title) title.textContent = t; },
      sub(t) { if (sub) sub.textContent = t; },
      pct(p) { if (!bar) return; bar.classList.remove('bwIndet');
               bar.style.marginLeft = '0'; bar.style.width = Math.max(2, Math.min(100, p)) + '%'; },
      done(t) { if (!el) return; bar.classList.remove('bwIndet'); bar.style.marginLeft = '0';
                bar.style.width = '100%'; bar.style.background = '#3ec77a';
                title.textContent = t; sub.textContent = '';
                timer = setTimeout(() => { el.style.display = 'none'; bar.style.background = '#4a9eff'; }, 2600); },
      fail(t) { if (!el) return; bar.classList.remove('bwIndet'); bar.style.background = '#e0663c';
                title.textContent = t; sub.textContent = 'You can keep working; nothing was changed.';
                timer = setTimeout(() => { el.style.display = 'none'; bar.style.background = '#4a9eff'; }, 4000); },
    };
  })();

  // leave the terminal clean: run `clear` in the guest so xterm drops the
  // transfer scrollback and redraws a fresh prompt.
  async function tidy() {
    const t0 = serialLen();
    paste('clear\n');
    await waitFor(/[$#] ?$/m, t0, 4000);
    await sleep(200);
  }

  async function ensureShell() {
    const t0 = serialLen();
    paste('\x15\n');                   // Ctrl-U clears any partial line, then Enter
    return !!(await waitFor(/[$#] ?$/m, t0, 8000));
  }

  async function exportWork() {
    if (busy) return null;
    busy = true;
    try {
      ov.show('Preparing…');
      if (!await ensureShell()) { ov.fail('Click the terminal, wait for the $ prompt, then try again'); return null; }
      ov.title('Saving your work…');
      const t0 = serialLen();
      paste("stty -echo; printf '\\nBWT-BEGIN\\n'; tar czf - -C " + HOME +
            " --exclude=persist . 2>/dev/null | base64 -w0; printf '\\nBWT-END\\n'; stty echo\n");
      const poll = setInterval(() => {
        const m = serialFrom(t0).match(/BWT-BEGIN\s*([A-Za-z0-9+/=\s]*)/);
        if (m) ov.sub(((m[1].replace(/\s/g, '').length * 0.75 / 1024) | 0) + ' KB packed');
      }, 400);
      const m = await waitFor(/BWT-BEGIN\s*([A-Za-z0-9+/=\s]*?)\s*BWT-END/, t0, 120000);
      clearInterval(poll);
      if (!m) { ov.fail('Timed out — the shell may be busy'); return null; }
      const bin = Uint8Array.from(atob(m[1].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      await tidy();
      return bin;
    } finally { busy = false; }
  }

  async function importWork(bytes) {
    if (busy) return false;
    busy = true;
    try {
      ov.show('Preparing…');
      if (!await ensureShell()) { ov.fail('Click the terminal, wait for the $ prompt, then try again'); return false; }
      ov.title('Restoring your work…');
      let b64 = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
      }
      const t0 = serialLen();
      paste("stty -echo; base64 -d > /tmp/bw-work.tgz <<'BWEOF'\n");
      for (let i = 0; i < b64.length; i += 4096) {
        paste(b64.slice(i, i + 4096) + '\n');
        ov.pct(i / b64.length * 100);
        await sleep(30);
      }
      ov.pct(100);
      paste("BWEOF\ntar xzf /tmp/bw-work.tgz -C " + HOME + " && rm -f /tmp/bw-work.tgz && echo BWR-OK; stty echo\n");
      const ok = await waitFor(/BWR-OK/, t0, 120000);
      await tidy();
      return !!ok;
    } finally { busy = false; }
  }

  async function opfsWrite(bin) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('bashtion-work.tgz', { create: true });
    const w = await fh.createWritable(); await w.write(bin); await w.close();
  }
  async function opfsRead() {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('bashtion-work.tgz');
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch (e) { return null; }
  }

  return {
    async save() { const bin = await exportWork(); if (bin) { await opfsWrite(bin); ov.done('✓ Work saved in this browser'); } },
    async download() {
      const bin = await exportWork();
      if (!bin) return;
      await opfsWrite(bin).catch(() => {});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bin], { type: 'application/gzip' }));
      a.download = 'bashtion-work-' + new Date().toISOString().slice(0, 10) + '.tgz';
      a.click(); URL.revokeObjectURL(a.href);
      ov.done('✓ Your work was downloaded');
    },
    async load(file) {
      const bin = file ? new Uint8Array(await file.arrayBuffer()) : await opfsRead();
      if (!bin) { ov.show('Nothing to restore'); ov.fail('No saved work found in this browser — use a downloaded file'); return; }
      const ok = await importWork(bin);
      if (ok) ov.done('✓ Your work was restored');
    },
    hasSaved: () => opfsRead().then((b) => !!b),
  };
})();
