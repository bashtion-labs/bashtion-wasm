// Serial tap: the page's record of everything the guest has written to the
// console, and a reading of that record as the terminal actually shows it.
// The boot screen watches it for a prompt, the save/load transfer reads the
// guest's replies out of it, and tests drive it directly.
//
// window.__serial is the RAW record: every character the guest wrote, decoded
// as UTF-8 and appended in order, with nothing removed and nothing applied. It
// is the right thing to search for a marker the guest printed after a given
// offset - which is all serialfs does with it - because nothing written later
// can take a match away. It is the wrong thing to read as text, because a
// terminal is not a teletype:
//
//  * It is not what the guest RECEIVED. Line editors echo their input and then
//    redraw it. QEMU's monitor (util/readline.c, readline_update()) reprints
//    its whole buffer after N cursor-lefts on every keystroke, so the page's
//    `cont` goes out as c / ESC[D co / 2x ESC[D con / 3x ESC[D cont.
//  * It is not what the screen SHOWS. Cursor motion (CR, BS, CSI A/B/C/D, ...)
//    and erasure (CSI K/J) are in it as characters, not carried out, so each
//    redraw piles up behind the last instead of overwriting it. Strip the
//    escapes and the monitor's `cont` reads "ccoconcont". GNU readline, when
//    input crosses the right margin, writes the first character of the new
//    row, then CR, then writes it again - the terminal has already wrapped, so
//    that is one character on screen - and with the CR deleted, `lvcreate`
//    reads "lvvcreate". That is the "duplicated input" of #61: the guest
//    received and ran `lvcreate` (#69).
//  * Every line ends CR CR LF: the guest's tty turns \n into \r\n, and the
//    page's own pty (xterm-pty) does the same again on its way out (ONLCR).
//  * It carries every escape sequence, including the OSC 3008 shell
//    integration Ubuntu 26.04 wraps around each command.
//
// So anything asking "what is on the screen" - is the console at an idle
// prompt, what is on the line being typed - asks SERIALTAP.screen(),
// lastLine() or atPrompt(), which replay the record through a model of the
// terminal below. Anything asking "has the guest printed X since I sent Y"
// searches window.__serial from an offset; a `clear` must not be able to
// erase an answer that has already arrived.
//
// xterm-pty hands its consumers arbitrary 4096-byte chunks, so a multi-byte
// UTF-8 sequence routinely straddles a chunk boundary. Decoding each chunk
// with a fresh TextDecoder turns every straddling sequence into U+FFFD, which
// is what non-ASCII output looked like when read back through this mirror.
// One streaming decoder, reused for the life of the session, keeps it exact.
// (xterm.js itself is handed the raw bytes and decodes them statefully, so the
// visible terminal was never the problem.)
'use strict';

const SERIALTAP = (() => {
  // Ubuntu 26.04 turns on shell integration, so OSC 3008 brackets every
  // command's output. Anything reading this mirror has to strip OSC as well
  // as CSI, or it matches escape sequences instead of text.
  const strip = (x) => String(x || '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

  // ------------------------------------------------------------- the screen
  // A model of the terminal, just complete enough that the cursor and the
  // text around it end up where xterm.js puts them for what this guest
  // actually sends: the two line editors (QEMU's monitor, GNU readline under
  // TERM=vt220), plain output, and the full-screen programs a student runs -
  // apt's progress bar sets a scroll region, vim and nano address the cursor
  // directly. Colours, character sets and modes that move nothing are parsed
  // and ignored. It is not an emulation of xterm.js, and rarer sequences are
  // only approximated. Where following xterm.js would take more than that -
  // the alternate screen, a saved cursor restored across a scroll - the model
  // says it cannot be sure (see cursorLine()) rather than guess, and
  // atPrompt() takes that as "not idle".
  //
  // It follows xterm.js where the two could differ: the cursor may sit one
  // past the last column (the deferred wrap), an LF there cancels the wrap,
  // cursor motion stops at the scroll region's edges. It departs from it in
  // two deliberate ways:
  //
  //  * A row that was reached by wrapping stays part of the line above it
  //    until ED erases it from its first column (`clear`, Ctrl-L). xterm.js
  //    also unmarks it as soon as an LF lands on it or EL erases it from its
  //    first column - and readline moves the cursor down through its own
  //    wrapped line with exactly that LF (Home, then End). Unmarked, the tail
  //    of a half-typed command becomes a line of its own, and a tail like
  //    `x$ ` is prompt-shaped.
  //  * A resize does not reflow. Rows keep what they hold, so a line joined
  //    across its wraps reads the same whatever the width now is.
  //
  // Widths are Markus Kuhn's wcwidth, which is what xterm.js's default
  // (Unicode 6) provider implements; only the zero-width ranges that turn up
  // in practice are listed.
  const SCROLLBACK = 1000;
  const GROUND = 0, ESC = 1, ESC_INTER = 2, CSI = 3, OSC = 4, STR = 5, STR_ESC = 6;

  function width(c) {
    if (c < 0x0300) return 1;
    if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x1ab0 && c <= 0x1aff) ||
        (c >= 0x1dc0 && c <= 0x1dff) || (c >= 0x200b && c <= 0x200f) ||
        (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe00 && c <= 0xfe0f) ||
        (c >= 0xfe20 && c <= 0xfe2f) || (c >= 0xe0100 && c <= 0xe01ef)) return 0;
    if (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe10 && c <= 0xfe19) ||
        (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x2fffd) ||
        (c >= 0x30000 && c <= 0x3fffd))) return 2;
    return 1;
  }

  // A row is an array of cells: a string per column, '' for the right half of
  // a wide character, undefined for a cell nothing has been written to.
  const newRow = () => ({ cells: [], wrapped: false });
  const text = (cells, from, to) => {
    let s = '';
    for (let i = from; i < to; i++) s += cells[i] === undefined ? ' ' : cells[i];
    return s;
  };
  const blank = (cells) => !/\S/.test(text(cells, 0, cells.length));

  // Blank [from, to), and never leave half of a wide character behind at
  // either edge.
  function erase(cells, from, to) {
    if (from > 0 && cells[from] === '') cells[from - 1] = undefined;
    if (cells[to] === '') cells[to] = undefined;
    if (to >= cells.length) { if (cells.length > from) cells.length = from; }
    else for (let i = from; i < to; i++) cells[i] = undefined;
  }

  function makeScreen(geometry) {
    let cols = 0, rows = 0;
    let main, buf;                // buffers: { lines, base, keep, saved }; buf is the active one
    let x, y;                     // cursor; x === cols is the deferred wrap
    let top, bottom;              // scroll region, inclusive
    let wrap, origin, insert;
    let state = GROUND, params = '', inter = '';
    // xterm.js saves a cursor's row counted from the top of the whole buffer,
    // so one restored after the main screen has scrolled into its scrollback
    // (or been resized) comes back that many rows higher - or not, once the
    // scrollback is full. The model does not follow that arithmetic. It counts
    // those events, and a restore across any of them leaves it unsure of the
    // cursor's row until the next line starts afresh (an LF at column 0), a
    // clear, or a reset.
    let moves = 0, unsure = false;

    const size = () => {
      const g = geometry && geometry();
      return { cols: Math.max(2, (g && g.cols) | 0 || 80),
               rows: Math.max(1, (g && g.rows) | 0 || 24) };
    };
    // A buffer always holds exactly `rows` screen lines from `base` on; the
    // lines before `base` are its scrollback.
    const buffer = (keep) => {
      const b = { lines: [], base: 0, keep, saved: null };
      for (let i = 0; i < rows; i++) b.lines.push(newRow());
      return b;
    };
    const line = (i) => buf.lines[buf.base + i];

    function reset() {
      main = buf = buffer(SCROLLBACK);
      x = y = 0; top = 0; bottom = rows - 1;
      wrap = true; origin = false; insert = false;
      unsure = false;
    }

    // Follow the terminal's geometry the way xterm.js resizes: growing pulls
    // rows back out of the scrollback while the cursor is on the bottom row,
    // else adds blank ones; shrinking drops rows below the cursor, then
    // pushes rows off the top.
    function fit() {
      const g = size();
      if (g.cols === cols && g.rows === rows) return;
      moves++;
      cols = g.cols;
      for (const b of buf === main ? [main] : [main, buf]) {
        const active = b === buf;
        while (b.lines.length - b.base < g.rows) {
          if (active && b.base > 0 && y === b.lines.length - b.base - 1) { b.base--; y++; }
          else b.lines.push(newRow());
        }
        while (b.lines.length - b.base > g.rows) {
          if (active && y < b.lines.length - b.base - 1) b.lines.pop();
          else { b.base++; if (active) y--; }
        }
      }
      rows = g.rows;
      top = 0; bottom = rows - 1;
      x = Math.min(x, cols);
      y = Math.max(0, Math.min(y, rows - 1));
    }

    // As xterm.js scrolls: a region that starts at the top row pushes that row
    // into the scrollback even when it ends above the bottom one (apt's
    // progress bar), and only a region below the top drops it.
    function scrollUp(n) {
      for (let k = 0; k < n; k++) {
        if (top === 0) {
          buf.lines.splice(buf.base + bottom + 1, 0, newRow());
          if (buf === main) moves++;
          if (++buf.base > buf.keep + 64) {
            buf.lines.splice(0, buf.base - buf.keep);
            buf.base = buf.keep;
          }
        } else {
          buf.lines.splice(buf.base + top, 1);
          buf.lines.splice(buf.base + bottom, 0, newRow());
        }
      }
    }
    function scrollDown(n) {
      for (let k = 0; k < n; k++) {
        buf.lines.splice(buf.base + bottom, 1);
        buf.lines.splice(buf.base + top, 0, newRow());
      }
    }

    function lineFeed() {
      if (x >= cols) x = cols - 1;
      if (x === 0) unsure = false;            // a fresh line: what is written on it next is known
      if (y === bottom) scrollUp(1);
      else if (y < rows - 1) y++;
    }
    function reverseIndex() {
      if (x >= cols) x = cols - 1;
      if (y === top) scrollDown(1);
      else if (y > 0) y--;
    }

    function print(ch, w) {
      if (w === 0) {                          // combining: joins the cell before
        const cells = line(y).cells;
        let i = Math.min(x, cols) - 1;
        if (i > 0 && cells[i] === '') i--;
        if (i >= 0 && cells[i]) cells[i] += ch;
        return;
      }
      if (x + w > cols) {                     // deferred wrap, or a wide char that no longer fits
        if (wrap) {
          if (y === bottom) scrollUp(1);
          else if (y < rows - 1) y++;
          x = 0;
          line(y).wrapped = true;
        } else x = cols - w;
      }
      const cells = line(y).cells;
      if (insert && x < cells.length) {
        erase(cells, x, x);
        cells.splice(x, 0, ...new Array(w));
        if (cells.length > cols) cells.length = cols;
      }
      erase(cells, x, x + w);
      cells[x] = ch;
      if (w === 2) cells[x + 1] = '';
      x += w;
    }

    function control(c) {
      switch (c) {
        case 0x08: x = Math.min(x, cols - 1); if (x > 0) x--; break;
        case 0x09: x = Math.min(cols - 1, (Math.floor(Math.min(x, cols - 1) / 8) + 1) * 8); break;
        case 0x0a: case 0x0b: case 0x0c: case 0x84: lineFeed(); break;
        case 0x0d: x = 0; break;
        case 0x85: x = 0; lineFeed(); break;
        case 0x8d: reverseIndex(); break;
      }
    }

    // Each buffer has its own saved cursor, as in xterm.js; 1049 saves and
    // restores the main screen's.
    function save() { buf.saved = { x, y, origin, moves }; }
    function restore() {
      const s = buf.saved || { x: 0, y: 0, origin: false, moves };
      if (s.moves !== moves) unsure = true;
      x = Math.min(s.x, cols - 1); y = Math.min(s.y, rows - 1); origin = s.origin;
    }

    function mode(p, on) {
      if (p === 7) wrap = on;
      else if (p === 6) { origin = on; x = 0; y = on ? top : 0; }
      else if (p === 47 || p === 1047 || p === 1049) {
        if (on) {
          if (p === 1049) save();
          if (buf === main) buf = buffer(0);
        } else {
          buf = main;
          if (p === 1049) restore();
        }
      }
    }

    function dispatch(final) {
      if (inter === '!' && final === 'p') {   // DECSTR, which systemd's tty reset sends
        top = 0; bottom = rows - 1; wrap = true; origin = false; insert = false; buf.saved = null;
        return;
      }
      if (inter) return;                      // DECSCUSR and the like: nothing positional
      const priv = /^[<=>?]/.test(params) ? params[0] : '';
      const ps = (priv ? params.slice(1) : params).split(';').map((p) => parseInt(p, 10) || 0);
      const n = Math.max(1, ps[0]);
      if (priv === '?' && (final === 'h' || final === 'l')) { ps.forEach((p) => mode(p, final === 'h')); return; }
      if (priv) return;
      const toRow = (r) => (origin ? Math.min(bottom, top + r) : Math.min(rows - 1, r));
      const up = (k) => { x = Math.min(x, cols - 1); y = Math.max(y >= top ? top : 0, y - k); };
      const down = (k) => { x = Math.min(x, cols - 1); y = Math.min(y <= bottom ? bottom : rows - 1, y + k); };
      const cx = Math.min(x, cols - 1);
      const cells = line(y).cells;
      switch (final) {
        case 'A': up(n); break;
        case 'B': case 'e': down(n); break;
        case 'C': case 'a': x = Math.min(cols - 1, x + n); break;
        case 'D': x = Math.max(0, cx - n); break;
        case 'E': down(n); x = 0; break;
        case 'F': up(n); x = 0; break;
        case 'G': case '`': x = Math.min(cols - 1, n - 1); break;
        case 'd': y = toRow(n - 1); x = cx; break;
        case 'H': case 'f': y = toRow(n - 1); x = Math.min(cols - 1, Math.max(1, ps[1] || 0) - 1); break;
        case 'J':
          if (ps[0] === 3) { if (buf === main) { main.lines.splice(0, main.base); main.base = 0; moves++; } break; }
          // all of the screen: nothing is left on it that could be misplaced
          if (ps[0] === 2 || (ps[0] === 0 && x === 0 && y === 0)) unsure = false;
          // Erased from its first column, the cursor's row is no longer the
          // rest of the line above it (xterm.js unmarks it too). `clear` and
          // Ctrl-L leave the top row so, and it may have been the tail of a
          // long line whose start is now in the scrollback.
          if (ps[0] === 0 && x === 0) line(y).wrapped = false;
          if (ps[0] === 0) erase(cells, Math.min(x, cols), Infinity);
          if (ps[0] === 1) erase(cells, 0, cx + 1);
          for (let i = 0; i < rows; i++) {
            if (ps[0] === 2 || (ps[0] === 0 && i > y) || (ps[0] === 1 && i < y)) {
              buf.lines[buf.base + i] = newRow();
            }
          }
          break;
        case 'K':
          if (ps[0] === 0) erase(cells, Math.min(x, cols), Infinity);
          else if (ps[0] === 1) erase(cells, 0, cx + 1);
          else if (ps[0] === 2) erase(cells, 0, Infinity);
          break;
        case '@':
          if (cx < cells.length) {
            erase(cells, cx, cx);
            cells.splice(cx, 0, ...new Array(Math.min(n, cols)));
            if (cells.length > cols) cells.length = cols;
          }
          x = cx;
          break;
        case 'P': erase(cells, cx, cx); erase(cells, cx + n, cx + n); cells.splice(cx, n); x = cx; break;
        case 'X': erase(cells, cx, cx + n); x = cx; break;
        case 'L': case 'M':
          if (y < top || y > bottom) break;
          for (let k = Math.min(n, bottom - y + 1); k > 0; k--) {
            if (final === 'L') {
              buf.lines.splice(buf.base + bottom, 1);
              buf.lines.splice(buf.base + y, 0, newRow());
            } else {
              buf.lines.splice(buf.base + y, 1);
              buf.lines.splice(buf.base + bottom, 0, newRow());
            }
          }
          x = 0;
          break;
        case 'S': scrollUp(Math.min(n, rows)); break;
        case 'T': if (ps.length === 1) scrollDown(Math.min(n, rows)); break;
        case 'r': {
          const t = Math.max(1, ps[0]) - 1, b = Math.min(rows, ps[1] || rows) - 1;
          if (t < b) { top = t; bottom = b; x = 0; y = origin ? top : 0; }
          break;
        }
        case 's': if (!params) save(); break;
        case 'u': if (!params) restore(); break;
        case 'h': case 'l': if (ps.indexOf(4) !== -1) insert = final === 'h'; break;
      }
    }

    function escape(ch, c) {
      state = GROUND;
      switch (ch) {
        case '[': state = CSI; params = inter = ''; return;
        case ']': state = OSC; return;
        case 'P': case 'X': case '^': case '_': state = STR; return;
        case '7': save(); return;
        case '8': restore(); return;
        case 'D': lineFeed(); return;
        case 'E': x = 0; lineFeed(); return;
        case 'M': reverseIndex(); return;
        case 'c': reset(); return;
      }
      if (c >= 0x20 && c <= 0x2f) state = ESC_INTER;   // ESC ( B, ESC # 8, ...
    }

    function write(s) {
      fit();
      for (const ch of s) {
        const c = ch.codePointAt(0);
        if (state === GROUND) {
          if (c >= 0x20 && c !== 0x7f && (c < 0x80 || c >= 0xa0)) print(ch, width(c));
          else if (c === 0x1b) state = ESC;
          else if (c === 0x9b) { state = CSI; params = inter = ''; }
          else if (c === 0x9d) state = OSC;
          else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) state = STR;
          else control(c);
        } else if (c === 0x18 || c === 0x1a) {
          state = GROUND;                                 // CAN, SUB: abandon the sequence
        } else if (state === OSC || state === STR) {
          // Skipped whole. BEL ends an OSC, but in a DCS, SOS, PM or APC it is
          // payload: those end only at ST, and what follows a BEL in one is
          // still not on the screen.
          if (c === 0x9c || (c === 0x07 && state === OSC)) state = GROUND;
          else if (c === 0x1b) state = STR_ESC;
        } else if (state === STR_ESC) {
          if (ch === '\\') state = GROUND;
          else if (c === 0x1b) state = ESC;
          else if (c < 0x20) { state = ESC; control(c); }
          else escape(ch, c);
        } else if (c === 0x1b) {
          state = ESC;
        } else if (c < 0x20) {
          control(c);                                     // C0 inside a sequence still acts
        } else if (state === ESC) {
          escape(ch, c);
        } else if (state === ESC_INTER) {
          if (c > 0x2f) state = GROUND;
        } else if (c >= 0x30 && c <= 0x3f && !inter && params.length < 64) {
          params += ch;
        } else if (c >= 0x20 && c <= 0x2f && inter.length < 8) {
          inter += ch;
        } else {
          state = GROUND;
          if (c >= 0x40 && c <= 0x7e) dispatch(ch);
        }
      }
    }

    // The logical line the cursor is on - its rows joined back across soft
    // wraps - split at the cursor, whether anything is on the screen below it,
    // and whether the model can vouch for any of that. It cannot on the
    // alternate screen (a full-screen program's, never the shell's), with the
    // cursor restored across a scroll (see `unsure`), or when the line's first
    // row has gone out of the scrollback: what is left of a long line can be
    // prompt-shaped when the whole of it is not.
    function cursorLine() {
      const L = buf.lines, at = buf.base + y;
      let s = at, e = at;
      while (s > 0 && L[s].wrapped) s--;
      while (e + 1 < L.length && L[e + 1].wrapped) e++;
      let before = '', after = '';
      for (let i = s; i < at; i++) before += text(L[i].cells, 0, L[i].cells.length);
      before += text(L[at].cells, 0, x);
      after += text(L[at].cells, x, L[at].cells.length);
      for (let i = at + 1; i <= e; i++) after += text(L[i].cells, 0, L[i].cells.length);
      let below = false;
      for (let i = e + 1; i < buf.base + rows && !below; i++) below = !blank(L[i].cells);
      const sure = buf === main && !unsure && !L[s].wrapped;
      return { before, after, below, sure };
    }

    // Every logical line held - scrollback, then the screen - down to the
    // cursor or the last non-blank row, whichever is lower.
    function lines() {
      const L = buf.lines;
      let last = buf.base + y;
      for (let i = L.length - 1; i > last; i--) if (!blank(L[i].cells)) { last = i; break; }
      const out = [];
      for (let i = 0; i <= last; i++) {
        const t = text(L[i].cells, 0, L[i].cells.length);
        if (i > 0 && L[i].wrapped) out[out.length - 1] += t;
        else out.push(t);
      }
      return out.map((t) => t.replace(/ +$/, ''));
    }

    const g = size();
    cols = g.cols; rows = g.rows;
    reset();
    return {
      write,
      lines,
      cursorLine,
      lastLine() { const c = cursorLine(); return (c.before + c.after).replace(/ +$/, ''); },
    };
  }

  // ---------------------------------------------------------------- the tap
  const geometryOf = (w) => () => w.__xterm && { cols: w.__xterm.cols, rows: w.__xterm.rows };

  // The model install() keeps in step with each window's mirror, so reading
  // the screen costs nothing however long the session has run. Each chunk is
  // applied at the terminal geometry of the moment it arrived, which is the
  // geometry xterm.js drew it at.
  const live = new WeakMap();

  function install(master, win) {
    const w = win || window;
    const dec = new TextDecoder('utf-8');
    const tap = { text: '', screen: makeScreen(geometryOf(w)) };
    w.__serial = '';
    live.set(w, tap);
    master.onWrite(([buf]) => {
      const s = dec.decode(buf, { stream: true });
      // Something replaced the mirror: rebuild the model from what is there
      // now, so the two can never disagree.
      if (w.__serial !== tap.text) {
        tap.screen = makeScreen(geometryOf(w));
        tap.screen.write(String(w.__serial || ''));
      }
      w.__serial += s;
      tap.text = w.__serial;
      tap.screen.write(s);
    });
    return w;
  }

  function screenOf(win) {
    const w = win || window;
    const tap = live.get(w);
    const s = String(w.__serial || '');
    if (tap && s === tap.text) return tap.screen;
    const scr = makeScreen(geometryOf(w));
    scr.write(s);
    return scr;
  }

  // Is the console sitting at an idle shell prompt, with nothing typed after
  // it? Used before injecting anything the user did not type.
  //
  // "Ends with $ or #" is not enough. That is also what a half-typed command
  // line looks like the moment someone types a `$` and pauses — `echo $` while
  // they recall a variable name — and the page would then paste `stty rows …`
  // into the middle of it and press Enter. Require the text before the cursor
  // to be entirely prompt-shaped: no whitespace before the trailing marker,
  // which a typed command always has. The one prompt allowed spaces is
  // Ubuntu's default, `user@host:dir$ `, since the directory may have them
  // (`~/lab notes`) - and only with that marker the sole `$` or `#` on the
  // line, which rules out anything typed after it (`...$ echo $ `).
  //
  // And ask it of the screen, not of the raw mirror (#69). Read raw, a line
  // that was typed and then erased still looks typed, and the tail of a
  // half-typed command that readline wrapped and then moved back down to
  // looks like a line of its own. So: the cursor's line, joined across its
  // wraps, must be prompt-shaped up to the cursor and empty after it, and
  // nothing may be on the screen below it. A shell prompt is the last thing
  // on the screen; an editor's cursor line never is (vim's status line,
  // nano's shortcut bar), and without that test `# ` typed at the start of a
  // line in vim is a root prompt.
  //
  // Wherever the model cannot vouch for its reading of that line, the answer
  // is no. A wrong "busy" only delays the page; a wrong "idle" types into
  // whatever owns the keyboard.
  const PROMPT = /^(?:\S*|[^\s@$#]+@[^\s:$#]+:[^$#]*)[$#] $/;
  function atPrompt(win) {
    const c = screenOf(win).cursorLine();
    return c.sure && PROMPT.test(c.before) && !/\S/.test(c.after) && !c.below;
  }

  return {
    install,
    strip,
    atPrompt,
    // What the terminal holds - up to 1000 rows of scrollback, then the
    // screen - as lines of text, each soft-wrapped line joined back into one.
    screen: (win) => screenOf(win).lines(),
    // The line the cursor is on: at a prompt, the prompt and what is typed.
    lastLine: (win) => screenOf(win).lastLine(),
  };
})();
