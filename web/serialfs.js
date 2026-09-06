// Save/Load of the user's work over the serial console, with a clean overlay
// so the raw transfer (a base64 archive streaming across the tty) is never
// shown. The overlay covers the terminal during a transfer, the bytes are
// captured from the serial tap behind it, and the scrollback is cleared
// afterwards so you return to a tidy prompt.
//
// The serial console is the only channel. The engine's filesystem lives in the
// wasm worker, and the page's `Module.FS` is a different thread's JS state, so
// the browser cannot see or write guest files directly (measured).
//
// Two rules the protocol below exists to satisfy:
//
//  * Never let readline touch the payload. A heredoc typed at an interactive
//    prompt is read by readline, which echoes and redisplays every line it is
//    given no matter what `stty -echo` says - so the archive travelled the
//    wire twice and a 4 KB line was redrawn character by character. Feeding a
//    command that reads the tty itself (`head -c N`) keeps the payload out of
//    readline entirely, and `stty -echo` then genuinely applies to it.
//
//  * Never match a marker against its own echo. readline echoes the command
//    line before the command runs, so a literal `printf 'BWR-OK'` is visible
//    on the wire the moment it is typed. Every marker is emitted with its
//    token split across adjacent shell quotes ('BW''R-OK'), which is one word
//    to the shell and never appears whole in the echo.
'use strict';

const SERIALFS = (() => {
  // Guest-side helpers ship in the image so that WHAT is captured is reviewable
  // and testable in the guest, rather than buried in a page string.
  const PACK = 'sudo /usr/local/sbin/bashtion-pack';
  const UNPACK = 'sudo /usr/local/sbin/bashtion-unpack';

  // Payload sizing. The guest tty is in canonical mode while `head` reads it:
  // a line over 4096 bytes is truncated, and the line discipline's whole read
  // buffer is 4096 bytes. So lines stay well short of that, a block stays
  // comfortably inside the buffer, and the page waits for the guest to say it
  // is reading before sending one.
  const LINE = 512;
  const BLOCK = 2048;

  // Nothing on the wire at all for this long means the guest is wedged. There
  // is deliberately no overall deadline: a big archive through a slow emulated
  // uart legitimately takes minutes, and the previous fixed 120 s cap was
  // unreachable for anything past ~10 KB.
  const IDLE_MS = 45000;

  let busy = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // strip OSC (incl. 26.04 shell-integration OSC 3008) + CSI before matching
  const clean = (x) => x
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const serialLen = () => (window.__serial || '').length;
  const serialFrom = (i) => clean((window.__serial || '').slice(i));
  const paste = (t) => window.__paste(t);

  // A marker the command that emits it cannot be mistaken for. See the header.
  const emit = (tag, fmt, args) =>
    "printf '\\nBW''" + tag + (fmt ? ' ' + fmt : '') + "\\n'" + (args ? ' ' + args : '');

  // Wait for `re`, giving up only when the guest has gone completely silent.
  // Every byte that arrives - progress output, an echo, anything - resets the
  // clock, so a transfer that is still moving is never abandoned.
  const waitFor = (re, from, idleMs) => new Promise((resolve) => {
    let seen = serialLen();
    let moved = Date.now();
    const tick = () => {
      const m = serialFrom(from).match(re);
      if (m) return resolve(m);
      const now = serialLen();
      if (now !== seen) { seen = now; moved = Date.now(); }
      if (Date.now() - moved > (idleMs || IDLE_MS)) return resolve(null);
      setTimeout(tick, 200);
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
      fail(t, why) { if (!el) build(); clearTimeout(timer); bar.classList.remove('bwIndet');
                bar.style.background = '#e0663c'; bar.style.marginLeft = '0'; bar.style.width = '100%';
                el.style.display = 'flex'; title.textContent = t;
                sub.textContent = why || 'You can keep working; nothing was changed.';
                timer = setTimeout(() => { el.style.display = 'none'; bar.style.background = '#4a9eff'; }, 6000); },
    };
  })();

  // ---- integrity ---------------------------------------------------------
  // POSIX cksum's CRC (CRC-32/CKSUM: poly 0x04C11DB7, init 0, not reflected,
  // final xor, with the byte length folded in). Computed here and compared
  // against `cksum` in the guest, so a transfer that loses or duplicates a
  // byte on the way through the console is reported rather than surfacing as
  // a confusing tar error - or, worse, as silently wrong files.
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function cksum(bytes) {
    let c = 0;
    for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    for (let n = bytes.length; n; n >>>= 8) c = ((c << 8) ^ CRC[((c >>> 24) ^ (n & 0xff)) & 0xff]) >>> 0;
    return (~c) >>> 0;
  }

  const b64encode = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    return s;
  };

  // ---- shell plumbing ----------------------------------------------------

  // leave the terminal clean: run `clear` in the guest so xterm drops the
  // transfer scrollback and redraws a fresh prompt.
  async function tidy() {
    const t0 = serialLen();
    paste('clear\n');
    await waitFor(/[$#] ?$/m, t0, 8000);
    await sleep(200);
  }

  async function ensureShell() {
    const t0 = serialLen();
    paste('\x15\n');                   // Ctrl-U clears any partial line, then Enter
    return !!(await waitFor(/[$#] ?$/m, t0, 8000));
  }

  // ---- save --------------------------------------------------------------
  async function exportWork() {
    if (busy) return null;
    busy = true;
    try {
      ov.show('Preparing…');
      if (!await ensureShell()) {
        ov.fail('Click the terminal, wait for the $ prompt, then try again');
        return null;
      }
      ov.title('Saving your work…');
      ov.sub('home, /etc, /opt, /srv, /usr/local and the user database');
      const t0 = serialLen();
      paste(
        'stty -echo; ' +
        'if ' + PACK + ' > /tmp/bw-save.tgz 2>/tmp/bw-save.err; then ' +
          emit('T-BEGIN', '%s %s',
               '"$(wc -c < /tmp/bw-save.tgz)" "$(cksum < /tmp/bw-save.tgz | cut -d" " -f1)"') + '; ' +
          'base64 -w0 < /tmp/bw-save.tgz; ' + emit('T-END') + '; ' +
        'else ' + emit('T-ERR', '%s', '"$(tail -1 /tmp/bw-save.err | tr -c "[:print:]" " ")"') + '; fi; ' +
        'rm -f /tmp/bw-save.tgz /tmp/bw-save.err; stty echo\n');

      const poll = setInterval(() => {
        const m = serialFrom(t0).match(/BWT-BEGIN\s+\d+\s+\d+\s*([A-Za-z0-9+/=\s]*)/);
        if (m) ov.sub(((m[1].replace(/\s/g, '').length * 0.75 / 1024) | 0) + ' KB packed');
      }, 400);
      const m = await waitFor(
        /BWT-BEGIN\s+(\d+)\s+(\d+)\s*([A-Za-z0-9+/=\s]*?)\s*BWT-END|BWT-ERR([^\n]*)/, t0);
      clearInterval(poll);

      if (!m) { ov.fail('Saving stopped', 'The console went quiet — nothing was changed.'); return null; }
      if (m[4] !== undefined) {
        ov.fail('Could not collect your work', (m[4] || '').trim() || 'The guest reported an error.');
        return null;
      }
      let bin;
      try {
        bin = Uint8Array.from(atob(m[3].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
      } catch (e) {
        ov.fail('Your work arrived damaged', 'The console garbled the transfer. Try again.');
        return null;
      }
      if (bin.length !== Number(m[1]) || cksum(bin) !== Number(m[2])) {
        ov.fail('Your work arrived damaged',
                'Checksum did not match (' + bin.length + ' of ' + m[1] + ' bytes). Try again.');
        return null;
      }
      await tidy();
      return bin;
    } finally { busy = false; }
  }

  // ---- restore -----------------------------------------------------------
  async function importWork(bytes) {
    if (busy) return { ok: false, why: 'A transfer is already running.' };
    busy = true;
    try {
      ov.show('Preparing…');
      if (!await ensureShell()) {
        return { ok: false, title: 'Click the terminal, wait for the $ prompt, then try again' };
      }
      ov.title('Restoring your work…');
      const b64 = b64encode(bytes);

      let t0 = serialLen();
      paste('stty -echo; rm -f /tmp/bw-load.b64 /tmp/bw-load.tgz; ' + emit('R-READY') + '\n');
      if (!await waitFor(/BWR-READY/, t0)) {
        return { ok: false, why: 'The guest never answered. Nothing was changed.' };
      }

      // Blocks, each acknowledged before the next is sent. That is the only
      // flow control available here: the tty silently discards input once its
      // 4 KB line-discipline buffer fills, and there is no XON/XOFF.
      const total = Math.ceil(b64.length / BLOCK);
      for (let b = 0; b < total; b++) {
        const slice = b64.slice(b * BLOCK, (b + 1) * BLOCK);
        let payload = '';
        for (let i = 0; i < slice.length; i += LINE) payload += slice.slice(i, i + LINE) + '\n';

        t0 = serialLen();
        paste(emit('R-GO') + '; head -c ' + payload.length + ' >> /tmp/bw-load.b64; ' +
              emit('R-BLK') + '\n');
        if (!await waitFor(/BWR-GO/, t0)) {
          return { ok: false, why: 'The guest stopped accepting data at ' +
                                   Math.round(b * 100 / total) + '%. Nothing was changed.' };
        }
        paste(payload);
        if (!await waitFor(/BWR-BLK/, t0)) {
          return { ok: false, why: 'The transfer stalled at ' +
                                   Math.round(b * 100 / total) + '%. Nothing was changed.' };
        }
        ov.pct((b + 1) * 100 / total);
        ov.sub(Math.round((b + 1) * BLOCK * 0.75 / 1024) + ' of ' +
               Math.round(bytes.length / 1024) + ' KB');
      }

      ov.title('Checking your work…');
      t0 = serialLen();
      paste('base64 -d < /tmp/bw-load.b64 > /tmp/bw-load.tgz 2>/dev/null; ' +
            emit('R-SUM', '%s %s',
                 '"$(wc -c < /tmp/bw-load.tgz)" "$(cksum < /tmp/bw-load.tgz | cut -d" " -f1)"') + '\n');
      const sum = await waitFor(/BWR-SUM\s+(\d+)\s+(\d+)/, t0);
      if (!sum) return { ok: false, why: 'The guest never confirmed the transfer.' };
      if (Number(sum[1]) !== bytes.length || Number(sum[2]) !== cksum(bytes)) {
        // Nothing has been unpacked yet, so the session is untouched.
        paste('rm -f /tmp/bw-load.b64 /tmp/bw-load.tgz; stty echo\n');
        return { ok: false, why: 'The archive arrived damaged (' + sum[1] + ' of ' +
                                 bytes.length + ' bytes). Nothing was changed — try again.' };
      }

      ov.title('Putting your work back…');
      t0 = serialLen();
      paste('if ' + UNPACK + ' < /tmp/bw-load.tgz >/tmp/bw-load.err 2>&1; then ' +
              emit('R-OK') + '; else ' +
              emit('R-FAIL', '%s', '"$(tail -1 /tmp/bw-load.err | tr -c "[:print:]" " ")"') + '; fi; ' +
            'rm -f /tmp/bw-load.b64 /tmp/bw-load.tgz /tmp/bw-load.err; stty echo\n');
      const done = await waitFor(/BWR-OK|BWR-FAIL([^\n]*)/, t0);
      if (!done) return { ok: false, why: 'Unpacking never finished.' };
      if (done[0].startsWith('BWR-FAIL')) {
        return { ok: false, why: (done[1] || '').trim() || 'The guest could not unpack the archive.' };
      }
      return { ok: true };
    } finally {
      busy = false;
      await tidy();
    }
  }

  // ---- browser-side copy -------------------------------------------------
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
    // No argument restores the copy this browser remembers; a File restores
    // that instead. Both paths are reachable from the page - the browser copy
    // used to be advertised in the status line with no control that could
    // reach it.
    async load(file) {
      const bin = file ? new Uint8Array(await file.arrayBuffer()) : await opfsRead();
      if (!bin || !bin.length) {
        ov.fail('Nothing to restore', 'No saved work in this browser — choose a downloaded file.');
        return false;
      }
      const r = await importWork(bin);
      if (r.ok) { ov.done('✓ Your work was restored'); return true; }
      ov.fail(r.title || 'Could not restore your work', r.why);
      return false;
    },
    hasSaved: () => opfsRead().then((b) => !!(b && b.length)),
    // exposed for tests
    _cksum: cksum,
  };
})();
