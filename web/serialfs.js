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
//
// The same overlay and console also take a checkpoint of the whole machine
// and go back to it, through QEMU's monitor rather than the shell (#65; see
// "checkpoint" below).
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
  //
  // WORK_MS covers the phases where the guest is legitimately silent because
  // it is busy rather than stuck - walking the filesystem to collect a
  // session, or unpacking one - which on a 10-30x interpreter is minutes of
  // no output at all.
  const IDLE_MS = 45000;
  const WORK_MS = 300000;
  // ...and an absolute cap on top of it. The idle timer resets on ANY growth
  // in the console mirror, which is everything the guest writes to ttyS0 - so
  // a single `dmesg -w &` or `while :; do date; sleep 5; done &` in the
  // background refreshes it forever and a wedged transfer never gives up:
  // the promise never settles, `busy` stays latched, and the full-screen
  // overlay sits there with no error. That is the #47 symptom, reintroduced
  // by the cure for it. Generous enough that a legitimately slow transfer is
  // never killed, finite so a stuck one always reports.
  const HARD_MS = 15 * 60 * 1000;
  const HARD_WORK_MS = 45 * 60 * 1000;

  // Test seam. The page never sets this; the timeout paths are otherwise only
  // reachable by waiting minutes for them, which means they go untested and
  // the bugs in them ship - which is exactly what happened.
  const ms = (name, dflt) => {
    const o = (typeof window !== 'undefined' && window.__bwTimeouts) || {};
    return typeof o[name] === 'number' ? o[name] : dflt;
  };

  let busy = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // strip OSC (incl. 26.04 shell-integration OSC 3008) + CSI before matching.
  //
  // This reads the RAW mirror, not SERIALTAP's screen, on purpose (#69). Every
  // question here is "has the guest printed X since offset N" - a marker, the
  // payload, a fresh prompt after a command this code sent - and the raw
  // record only ever grows, so an answer cannot be taken back. On a screen, a
  // `clear` (tidy() sends one) could erase a match before it was seen, and the
  // payload is far longer than any scrollback. The line editors' redraws that
  // make the raw record misleading as text only ever touch the echo of typed
  // input, and nothing here matches an echo: that is what splitting every
  // marker across quotes is for (see the header).
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
  // clock, so a transfer that is still moving is never abandoned. `re` may
  // also be a function, for a question the cleaned text cannot answer.
  const waitFor = (re, from, idleMs, hardMs) => new Promise((resolve) => {
    const started = Date.now();
    const idle = idleMs || ms('idle', IDLE_MS);
    const hard = hardMs ||
      (idle >= ms('work', WORK_MS) ? ms('hardWork', HARD_WORK_MS) : ms('hard', HARD_MS));
    let seen = serialLen();
    let moved = started;
    const tick = () => {
      const m = typeof re === 'function' ? re() : serialFrom(from).match(re);
      if (m) return resolve(m);
      const now = serialLen();
      if (now !== seen) { seen = now; moved = Date.now(); }
      if (Date.now() - moved > idle) return resolve(null);
      if (Date.now() - started > hard) return resolve(null);
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
                bar.style.background = '#4a9eff';
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
      // Finished, but not with everything that was asked for. Held longer than
      // either of the others: it is the one that needs reading.
      warn(t, why) { if (!el) build(); clearTimeout(timer); bar.classList.remove('bwIndet');
                bar.style.background = '#e0a93c'; bar.style.marginLeft = '0'; bar.style.width = '100%';
                el.style.display = 'flex'; title.textContent = t; sub.textContent = why;
                timer = setTimeout(() => { el.style.display = 'none'; bar.style.background = '#4a9eff'; }, 12000); },
    };
  })();

  // The overlay goes away; the status line stays until the next save, so
  // what happened is still on screen after the user looks back.
  const status = (m) => { if (typeof window.__sfsStatus === 'function') window.__sfsStatus(m); };

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

  // Hand the terminal back the way it was found.
  //
  // On a FAILED transfer the guest is very often still inside `head -c N`,
  // which reads the tty directly: anything pasted then is consumed as archive
  // payload, not run as a command. So the reader has to be killed first -
  // Ctrl-C, which the line discipline turns into SIGINT for the foreground
  // job - before `stty echo` can mean anything. Without that the console is
  // left with ECHO off and an orphaned reader eating the user's keystrokes,
  // which is worse than the failure it is recovering from.
  async function recover(clean, tmpfiles) {
    if (!clean) {
      paste('\x03');
      await sleep(300);
      paste('\x03');
      await waitFor(/[$#] ?$/m, serialLen(), 5000);
    }
    paste('stty echo; rm -f ' + tmpfiles + ' 2>/dev/null\n');
    await tidy();
  }

  // Asked for 8 s at most, printing or not, for every caller: a program that
  // keeps printing (`ping`, `top`) never lets the 8 s idle timer run out, and
  // the overlay covers the terminal, so the user cannot reach it to stop it
  // (#65, seen on the served page). Capped here rather than by each caller:
  // Download and Load were once left without it and sat on "Preparing…" for
  // up to 15 minutes.
  async function ensureShell() {
    const t0 = serialLen();
    paste('\x15\n');                   // Ctrl-U clears any partial line, then Enter
    return !!(await waitFor(/[$#] ?$/m, t0, 8000, ms('prompt', 8000)));
  }

  // ---- save --------------------------------------------------------------
  async function exportWork() {
    if (busy) return null;
    busy = true;
    // Whether we ever actually took the console. The recovery in the finally
    // types shell text; running it after ensureShell() has just reported that
    // there is NO prompt injects ~70 characters into whatever program owns the
    // tty - vim, less, a heredoc - while the overlay tells the user to wait
    // for a prompt.
    let engaged = false;
    let clean = false;
    try {
      ov.show('Preparing…');
      if (!await ensureShell()) {
        ov.fail('Click the terminal, wait for the $ prompt, then try again');
        return null;
      }
      engaged = true;
      ov.title('Saving your work…');
      ov.sub('home, /etc, /opt, /srv, /usr/local and the user database');
      const t0 = serialLen();
      paste(
        'stty -echo; ' + emit('T-PACK') + '; ' +
        'if ' + PACK + ' > /tmp/bw-save.tgz 2>/tmp/bw-save.err; then ' +
          emit('T-BEGIN', '%s %s',
               '"$(wc -c < /tmp/bw-save.tgz)" "$(cksum < /tmp/bw-save.tgz | cut -d" " -f1)"') + '; ' +
          'base64 -w0 < /tmp/bw-save.tgz; ' + emit('T-END') + '; ' +
        'else ' + emit('T-ERR', '%s', '"$(tail -1 /tmp/bw-save.err | tr -c "[:print:]" " ")"') + '; fi; ' +
        'rm -f /tmp/bw-save.tgz /tmp/bw-save.err; stty echo\n');

      if (!await waitFor(/BWT-PACK/, t0)) {
        ov.fail('Saving stopped', 'The console never took the command.');
        return null;
      }
      ov.title('Collecting your work…');
      const poll = setInterval(() => {
        const m = serialFrom(t0).match(/BWT-BEGIN\s+\d+\s+\d+\s*([A-Za-z0-9+/=\s]*)/);
        if (m) ov.sub(((m[1].replace(/\s/g, '').length * 0.75 / 1024) | 0) + ' KB packed');
      }, 400);
      const m = await waitFor(
        /BWT-BEGIN\s+(\d+)\s+(\d+)\s*([A-Za-z0-9+/=\s]*?)\s*BWT-END|BWT-ERR([^\n]*)/,
        t0, ms('work', WORK_MS));
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
      clean = true;
      return bin;
    } finally {
      try {
        if (engaged) await recover(clean, '/tmp/bw-save.tgz /tmp/bw-save.err');
      } finally { busy = false; }
    }
  }

  // ---- restore -----------------------------------------------------------
  async function importWork(bytes) {
    // A second click while a transfer is running must not touch the shared
    // overlay: ov.fail() would repaint it red and arm a 6 s hide, exposing the
    // raw base64 traffic of the transfer that is still running, with nothing
    // to bring the cover back.
    if (busy) return { ok: false, busy: true };
    busy = true;
    let engaged = false;
    let clean = false;
    try {
      ov.show('Preparing…');
      if (!await ensureShell()) {
        return { ok: false, title: 'Click the terminal, wait for the $ prompt, then try again' };
      }
      engaged = true;
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
      const sum = await waitFor(/BWR-SUM\s+(\d+)\s+(\d+)/, t0, ms('work', WORK_MS));
      if (!sum) return { ok: false, why: 'The guest never confirmed the transfer.' };
      if (Number(sum[1]) !== bytes.length || Number(sum[2]) !== cksum(bytes)) {
        // Nothing has been unpacked yet, so the session is untouched. The
        // guest is back at a prompt here, so no reader needs freeing.
        clean = true;
        return { ok: false, why: 'The archive arrived damaged (' + sum[1] + ' of ' +
                                 bytes.length + ' bytes). Nothing was changed — try again.' };
      }

      ov.title('Putting your work back…');
      t0 = serialLen();
      // The last line bashtion-unpack prints travels back either way: on
      // failure it is the reason, and on success it says HOW MUCH came back.
      // An archive saved on a different build of the image restores the home
      // directory only (#72), and that must not be reported as if it were
      // the whole session.
      const said = '"$(tail -1 /tmp/bw-load.err | tr -c "[:print:]" " ")"';
      paste('if ' + UNPACK + ' < /tmp/bw-load.tgz >/tmp/bw-load.err 2>&1; then ' +
              emit('R-OK', '%s', said) + '; else ' + emit('R-FAIL', '%s', said) + '; fi; ' +
            'rm -f /tmp/bw-load.b64 /tmp/bw-load.tgz /tmp/bw-load.err; stty echo\n');
      // Up to the END of the line: matched on the marker alone, a verdict
      // still arriving ("restored ho") would be read as a full restore.
      const done = await waitFor(/BWR-(OK|FAIL)([^\r\n]*)[\r\n]/, t0, ms('work', WORK_MS));
      if (!done) return { ok: false, why: 'Unpacking never finished.' };
      const verdict = done[2].trim();
      if (done[1] === 'FAIL') {
        return { ok: false, why: verdict || 'The guest could not unpack the archive.' };
      }
      clean = true;
      return { ok: true, homeOnly: /\brestored home only\b/.test(verdict) };
    } finally {
      try {
        if (engaged) {
          await recover(clean, '/tmp/bw-load.b64 /tmp/bw-load.tgz /tmp/bw-load.err');
        }
      } finally { busy = false; }
    }
  }

  // ---- checkpoint (#65) --------------------------------------------------
  // The whole running machine - memory, devices and both disks - kept in the
  // engine and put back on request, through QEMU's own monitor. It is on the
  // same -nographic mux as the serial console (Ctrl-A c moves the keyboard
  // between them); boot.js already drives it there to resume the restored
  // VM, and anyone can reach it by typing Ctrl-A c, so driving it from here
  // adds no capability.
  //
  // Saving is `stop`, `snapshot_blkdev` (the first time only), `savevm`,
  // `cont`; going back is `stop`, `loadvm`, `cont`. On the served page the
  // qcow2 layer took ~20 ms, `savevm` ~0.7 s for a VM SIZE of 299 MiB and
  // `loadvm` ~0.5 s (measured). Why each piece is there:
  //
  //  * The qcow2 layer. `savevm` on the shipped raw root disk fails with
  //    "Device 'root' is writable but does not support snapshots": a VM
  //    snapshot is stored inside qcow2 images. `snapshot_blkdev` puts a new
  //    qcow2 file over root, backed by the raw image, and every root write
  //    from then on lands in it. It is made at the first checkpoint rather
  //    than at start, so a session that never takes one is unchanged.
  //  * Its path is the ENGINE's /tmp - the Emscripten filesystem out.js
  //    creates, where the disks themselves live - not the guest's /tmp. The
  //    guest never sees the file, and every build of the engine has /tmp.
  //  * One fixed tag. `savevm` replaces a snapshot with the same tag, so
  //    saving again needs no `delvm`; one slot bounds what checkpoints cost in
  //    memory (the VM SIZE, plus every root cluster written since the first);
  //    and the replaced snapshot's space is reused (natively, the layer was
  //    223 MB after two).
  //  * `stop` first. Nothing the guest prints can then land among the replies
  //    read here, and the qcow2 layer and the snapshot are taken at one
  //    instant, with no guest write between them.
  //  * `cont` after a failed `savevm`, never after a failed `loadvm`. A failed
  //    save leaves the machine as it was, so it carries on. A failed load may
  //    have put the disks back and only part of the memory, and a machine
  //    running on that can corrupt the very work the user would then try to
  //    download: stopped and honest is better.
  //  * One short `cont` after a `stop` that never answered, too. QEMU runs
  //    `stop` as soon as it reads the line, so one whose prompt was lost, or
  //    came after the page gave up, may have stopped the machine all the
  //    same; and `cont` succeeds on a running guest, so it costs nothing when
  //    `stop` never ran. Short, as in mux(), and capped however much arrives:
  //    an engine that lost one answer may lose this one too, and a running
  //    guest's output would keep an idle timer alive for the 15-minute cap.
  //    Never once `loadvm` has been sent, as above.
  //  * The bracketed-paste reset. xterm.paste() wraps its text in
  //    ESC[200~ ... ESC[201~ whenever the program in front has asked for it,
  //    and the mux then sees ESC straight after Ctrl-A and never switches:
  //    the `c` and every command after it go to the guest. Any program can
  //    turn the mode on, and going back is for when a program misbehaves.
  //  * blur(). HMP's `q` quits the engine, and while the page is in the
  //    monitor every key the user presses on the terminal would go to it.
  const LAYER = 'snapshot_blkdev root /tmp/bashtion-root.qcow2 qcow2';
  const SAVEVM = 'savevm bashtion';
  const LOADVM = 'loadvm bashtion';
  const NO_ANSWER = 'The machine did not answer.';

  let switches = 0;        // Ctrl-A c sent by the page: odd means the mux is on the monitor
  let paused = false;      // `stop` answered, and no `cont` since
  let unanswered = false;  // `stop` sent, its prompt not seen: it may have stopped the machine anyway
  let layered = false;     // the qcow2 layer is over root
  let savedAt = null;      // when the snapshot in the slot was taken

  const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const sentence = (s) => { s = s.trim(); return /[.!?]$/.test(s) ? s : s + '.'; };
  const blur = () => { if (window.__xterm) window.__xterm.blur(); };
  const focus = () => { if (window.__xterm) window.__xterm.focus(); };

  // Ctrl-A c, typed as boot.js types it. Resolves whether the monitor
  // answered, when this was the switch into it.
  //
  // Ctrl-A NUL goes first. A Ctrl-A the user pressed is held by the mux until
  // the next key (readline's start-of-line habit does it), and the page's
  // Ctrl-A would complete that pair and go to the guest, its `c` typed into
  // the shell and the switch never made - after which the switch "back" would
  // switch in. With nothing held the mux swallows Ctrl-A NUL whole; with a
  // Ctrl-A held the guest gets ^A and NUL, and the mux holds nothing (both
  // measured on the served page).
  //
  // The monitor's prompt is looked for anywhere after the switch, not only at
  // the end: the VM runs until `stop`, and the mux interleaves its output with
  // the monitor's, so a program that keeps printing buries `(qemu) ` at once.
  // The echo of a command never contains it. And the short wait is the hard
  // cap as well: output arriving would otherwise keep an idle timer alive for
  // the 15-minute cap.
  async function mux() {
    const t = window.__xterm;
    if (t && t.modes && t.modes.bracketedPasteMode) {
      await new Promise((r) => t.write('\x1b[?2004l', r));
    }
    paste('\x01');
    paste('\x00');
    const t0 = serialLen();
    paste('\x01');
    paste('c');
    switches++;
    if (!(switches % 2)) return true;
    return !!(await waitFor(/\(qemu\) /, t0, ms('mux', 8000), ms('mux', 8000)));
  }

  // One monitor command. Every reply ends in a fresh `(qemu) `, which the
  // monitor's echo of the command never contains - looked for anywhere after
  // the command, as in mux(), since around `stop` and `cont` the guest may
  // still be printing. A failure is the line `Error: <reason>` straight
  // before that prompt, so a program printing lines that start `Error: ` is
  // not taken for one - except in `stop`'s reply, which is never read for one.
  // `stop` is the one command typed while the guest runs, and the vCPU can
  // finish a translation block after the echo has gone out, so guest bytes -
  // a whole `Error: ...` line among them - can land between the echo and the
  // prompt (seen on the served page). And `stop` has nothing to fail on here:
  // it succeeds even on a stopped VM, and QEMU 8.2 refuses it only during a
  // dump. Its prompt alone means stopped, so `cont` is never skipped. And it
  // counts as unanswered from before the paste, so one whose prompt never
  // comes, or whose paste throws, is followed by a short `cont` too (see
  // leave()). `hardMs` caps a wait however much the guest prints, as in
  // mux(). `cmd` is always one of the constants here: nothing the user or the
  // guest supplies goes into one.
  async function run(cmd, idleMs, hardMs) {
    const t0 = serialLen();
    if (cmd === 'stop') unanswered = true;
    paste(cmd + '\n');
    if (!await waitFor(/\(qemu\) /, t0, idleMs, hardMs)) return { why: NO_ANSWER };
    const reply = serialFrom(t0);
    const err = cmd !== 'stop' && reply.match(/(?:^|\n)Error: ([^\r\n]*)\r*\n\(qemu\) /);
    if (err) return { why: sentence(err[1]) };
    if (cmd === 'stop') { paused = true; unanswered = false; }
    if (cmd === 'cont') paused = false;
    return { why: null, reply };
  }

  // Back to the serial side, if the page is in the monitor, resuming the
  // machine on the way out if the page stopped it, or sent a `stop` that
  // never answered, and may. Resolves why `cont` failed, or null. `unanswered`
  // is cleared before the short `cont` goes, so that is tried once, answered
  // or not, even if its paste throws, and never carries into the next
  // operation.
  async function leave(resume) {
    if (!(switches % 2)) return null;
    const short = unanswered;
    unanswered = false;
    let why = null;
    if (paused && resume) why = (await run('cont')).why;
    else if (short && resume) why = (await run('cont', ms('mux', 8000), ms('mux', 8000))).why;
    await mux();
    return why;
  }

  // After either operation the guest is wrong about two things only the page
  // knows. The time: its clock is the ACPI PM timer, which stands still while
  // the VM is stopped, and loadvm puts it back to the moment of the
  // checkpoint. And the terminal's shape: loadvm puts the tty size back too.
  // One line at the prompt puts both right and clears what the monitor
  // printed.
  //
  // The clock commands are the two in bootscreen.js's handover(), repeated
  // rather than shared: this file loads first, and its tests load it alone.
  async function resync() {
    const cmds = [
      'sudo date -u -s @' + Math.floor(Date.now() / 1000) + ' >/dev/null 2>&1',
      'sudo hwclock --systohc >/dev/null 2>&1',
    ];
    const t = window.__xterm;
    if (t && t.cols && t.rows && typeof TERMFIT === 'object') {
      const geom = { cols: t.cols, rows: t.rows };
      cmds.push(TERMFIT.stty(geom));
      if (window.__geomSync) window.__geomSync.seed(geom);
    }
    cmds.push('clear');
    const t0 = serialLen();
    paste(cmds.join('; ') + '\n');
    // Done once `clear` has run - its erase is in the raw mirror after the
    // line went out - and a prompt has followed it. A prompt alone is not
    // enough: when the checkpoint caught bash between prompts, the tty echoes
    // the line, a stale prompt follows, and the line only runs after that,
    // seconds later, with the monitor's text still on screen. bootscreen.js's
    // reveal asks the same of its handover line. The monitor's own redraws
    // erase with ESC[K, never ESC[J.
    //
    // Not tidy()'s 8 s: the two sudos print nothing for 8-17 s, and longest
    // straight after a checkpoint (15-17 s, measured).
    await waitFor(() => {
      const raw = (window.__serial || '').slice(t0);
      const at = raw.search(/\x1b\[[0-9;]*J/);
      return at >= 0 && clean(raw.slice(at)).match(/[$#] ?$/m);
    }, t0);
    await sleep(200);
  }

  async function checkpoint() {
    if (busy) return false;
    busy = true;
    try {
      ov.show('Preparing…');
      // A prompt is required so that going back to this checkpoint lands at
      // one, where the re-sync can be typed.
      if (!await ensureShell()) {
        ov.fail('Click the terminal, wait for the $ prompt, then try again');
        return false;
      }
      ov.title('Saving a checkpoint…');
      ov.sub('The whole machine, kept in this tab until you close or reload it.');
      const earlier = savedAt;
      blur();
      let why = await mux() ? null : NO_ANSWER;
      if (!why) why = (await run('stop')).why;
      if (!why && !layered) {
        why = (await run(LAYER, ms('work', WORK_MS))).why;
        layered = !why;
      }
      if (!why) {
        why = (await run(SAVEVM, ms('work', WORK_MS))).why;
        // From here the slot holds this state, whatever happens next.
        if (!why) savedAt = new Date();
        else {
          // savevm deletes the old snapshot of the tag before it writes the
          // new one, so a failure can take the earlier checkpoint with it.
          const list = await run('info snapshots');
          if (list.why || !/^\S+\s+bashtion\s/m.test(list.reply)) savedAt = null;
          if (earlier && !savedAt) {
            why += ' Your earlier checkpoint is gone.';
            // or the status line would still offer the time of one
            status('your earlier checkpoint is gone');
          }
        }
      }
      const resumed = await leave(true);
      why = why || resumed;
      if (!paused) await resync();
      focus();
      if (why) { ov.fail('Could not save a checkpoint', why); return false; }
      ov.done('✓ Checkpoint saved');
      status('checkpoint saved at ' + hhmm(savedAt));
      return true;
    } finally {
      try { await leave(true); focus(); } finally { busy = false; }
    }
  }

  async function rollback() {
    if (busy || !savedAt) return false;
    busy = true;
    // Cleared once `loadvm` is sent, and set again only if it answers
    // cleanly: after a partial load the disks and memory may not match.
    let resumable = true;
    try {
      // No prompt required, unlike saving: going back is for when a program
      // has the terminal or the guest is stuck.
      ov.show('Going back to your checkpoint…');
      ov.sub('Undoing everything since ' + hhmm(savedAt) + '.');
      blur();
      let why = await mux() ? null : NO_ANSWER;
      if (!why) why = (await run('stop')).why;
      if (!why) {
        resumable = false;
        why = (await run(LOADVM, ms('work', WORK_MS))).why;
        if (why) {
          why += ' Reload the page to start again.';
          // The overlay goes in 6 s and the machine stays stopped: the one
          // instruction that matters has to stay on screen.
          status('could not go back to your checkpoint — reload the page');
        } else resumable = true;
      }
      const resumed = await leave(resumable);
      why = why || resumed;
      if (why) { ov.fail('Could not go back to your checkpoint', why); return false; }
      // loadvm put the guest back, but not the page's terminal: a program
      // that was running (top, say) may have left the cursor hidden, colours
      // set, or the cursor keys, keypad or mouse in application modes. Put
      // back the ones a restored prompt expects. These are the modes
      // SERIALTAP's screen model does not track, so the two cannot disagree.
      const t = window.__xterm;
      if (t) {
        await new Promise((r) => t.write(
          '\x1b[?25h\x1b[0m\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l', r));
      }
      // The checkpoint was taken at a prompt, so there is one to come back to.
      if (await ensureShell()) await resync();
      focus();
      ov.done('✓ Back at your checkpoint');
      status('back at your checkpoint from ' + hhmm(savedAt));
      return true;
    } finally {
      try { await leave(resumable); focus(); } finally { busy = false; }
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
    //
    // Resolves true for a full restore, 'home-only' when the guest restored
    // the home directory alone (#72), false when nothing was restored.
    async load(file) {
      const bin = file ? new Uint8Array(await file.arrayBuffer()) : await opfsRead();
      if (!bin || !bin.length) {
        ov.fail('Nothing to restore', 'No saved work in this browser — choose a downloaded file.');
        return false;
      }
      const r = await importWork(bin);
      // A partial restore stays in the status line after the overlay goes.
      if (r.ok && r.homeOnly) {
        ov.warn('Only your home folder was restored',
                'This work was saved on a different version of bashtion. Your files are ' +
                'back; your changes to system settings (/etc, users and groups, cron ' +
                'jobs, /opt) were left out, because they could undo fixes in this version.');
        status('restored your home folder only — system changes were left out');
        return 'home-only';
      }
      if (r.ok) { ov.done('✓ Your work was restored'); status('your work was restored'); return true; }
      if (!r.busy) ov.fail(r.title || 'Could not restore your work', r.why);
      return false;
    },
    hasSaved: () => opfsRead().then((b) => !!(b && b.length)),
    // Resolve true or false; the overlay and the status line say what
    // happened. checkpointTime() is when this page's checkpoint was taken,
    // or null when there is none to go back to.
    checkpoint,
    rollback,
    checkpointTime: () => savedAt && new Date(savedAt),
    // The page must not paste anything of its own while a transfer owns the
    // console: between blocks the tail looks exactly like an idle prompt, and
    // the next `head -c N` would swallow the injected text as payload. Nor
    // while a checkpoint has the mux on the monitor (#65), where it would be
    // run as a monitor command.
    isBusy: () => busy,
    // exposed for tests
    _cksum: cksum,
  };
})();
