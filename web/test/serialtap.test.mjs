import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';
import { CAPTURES, mirror } from './console-captures.mjs';

// A fake xterm-pty master: it hands consumers byte chunks the way the real one
// does, splitting at a fixed size regardless of character boundaries.
function fakeMaster(chunkSize = 8) {
  const sinks = [];
  return {
    onWrite: (fn) => sinks.push(fn),
    emit(bytes) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        for (const fn of sinks) fn([chunk]);
      }
    },
  };
}

const SAMPLE = 'user@bashtion:~$ ┌─┐ café ✓ αβγ\r\n';
const BYTES = new TextEncoder().encode(SAMPLE);

test('root cause: a fresh TextDecoder per chunk mangles straddling sequences', () => {
  const master = fakeMaster(8);
  let out = '';
  master.onWrite(([buf]) => { out += new TextDecoder().decode(buf); });
  master.emit(BYTES);
  assert.notEqual(out, SAMPLE, 'expected the old per-chunk decode to corrupt');
  assert.ok(out.includes('�'), 'expected replacement characters');
});

test('SERIALTAP mirrors multi-byte output exactly across chunk boundaries', () => {
  const win = {};
  const master = fakeMaster(8);
  const tap = loadScript('serialtap.js', 'SERIALTAP', { TextDecoder });
  tap.install(master, win);
  master.emit(BYTES);
  assert.equal(win.__serial, SAMPLE);
  assert.ok(!win.__serial.includes('�'));
});

test('SERIALTAP is exact for every chunk size', () => {
  for (let n = 1; n <= 16; n++) {
    const win = {};
    const master = fakeMaster(n);
    const tap = loadScript('serialtap.js', 'SERIALTAP', { TextDecoder });
    tap.install(master, win);
    master.emit(BYTES);
    assert.equal(win.__serial, SAMPLE, `chunk size ${n}`);
  }
});

test('SERIALTAP starts each session with an empty mirror', () => {
  const win = { __serial: 'stale' };
  loadScript('serialtap.js', 'SERIALTAP', { TextDecoder }).install(fakeMaster(), win);
  assert.equal(win.__serial, '');
});

// ---------------------------------------------------------------- atPrompt
const tap = () => loadScript('serialtap.js', 'SERIALTAP', { TextDecoder });
const at = (mirror) => tap().atPrompt({ __serial: mirror });

test('atPrompt accepts a real idle prompt', () => {
  assert.equal(at('\r\nuser@bashtion:~$ '), true);
  assert.equal(at('some output\r\nuser@bashtion:/etc$ '), true);
  assert.equal(at('\r\nroot@bashtion:/home/user# '), true);
});

test('#60 atPrompt rejects a half-typed command line that ends in $', () => {
  // the exact case the page used to inject into: someone typed `echo $` and
  // paused to recall the variable name
  assert.equal(at('\r\nuser@bashtion:~$ echo $'), false);
  assert.equal(at('\r\nuser@bashtion:~$ echo $ '), false);
  assert.equal(at('\r\nuser@bashtion:~$ awk \'{print $'), false);
  assert.equal(at('\r\nuser@bashtion:~$ grep # '), false);
});

test('#69 atPrompt accepts Ubuntu\'s prompt in a directory with a space in it', () => {
  // The default PS1 is \u@\h:\w\$ , and \w is the working directory as it is
  assert.equal(at('\r\nuser@bashtion:~/lab notes$ '), true);
  assert.equal(at('\r\nroot@bashtion:/srv/my files/a b# '), true);
  // ... but a command typed after it adds a second marker, or none at the end
  assert.equal(at('\r\nuser@bashtion:~/lab notes$ echo $ '), false);
  assert.equal(at('\r\nuser@bashtion:~/lab notes$ grep # '), false);
  assert.equal(at('\r\nuser@bashtion:~/lab notes$ ls'), false);
  // and outside that shape, whitespace still rules a line out
  assert.equal(at('\r\n$ echo a b$ '), false);
  assert.equal(at('\r\nnotes: see ~/a b$ '), false);
  assert.equal(at('\r\n> echo me@host:a b$ '), false);
});

test('atPrompt rejects a console in the middle of output', () => {
  assert.equal(at('\r\nReading package lists... 47%'), false);
  assert.equal(at('\r\nuser@bashtion:~$ sudo apt install tree\r\nUnpacking tree ...'), false);
  assert.equal(at(''), false);
});

// -------------------------------------------------------------------- #69
// window.__serial is what the guest WROTE: not what it received, and not what
// the screen shows. Read as text - escapes stripped and CR deleted, which is
// what atPrompt() used to do - every line-editor redraw turns into input the
// guest never had. The streams below are real program output, captured byte
// for byte; see console-captures.mjs for how.

const flat = (raw) => tap().strip(raw).replace(/\r/g, '');
const screenOf = (raw, geom) => tap().screen({ __serial: raw, __xterm: geom });
const lastOf = (raw) => tap().lastLine({ __serial: raw });
const atCap = (name, step) => at(mirror(name, step));

test('root cause: the raw mirror is the line editors\' redraws, not the input', () => {
  // QEMU's monitor reprints its whole buffer after N cursor-lefts per keystroke
  assert.ok(flat(mirror('monitor', 'cont')).includes('(qemu) ccoconcont'));
  // readline crossing the right margin writes the new row's first character,
  // then CR, then writes it again: typeahead, and a byte at a time
  assert.ok(mirror('lvm-batch-C', 'type').includes('sudo lv\rvcreate'));
  assert.ok(flat(mirror('lvm-batch-C', 'type')).includes('sudo lvvcreate'));
  assert.ok(flat(mirror('lvm-perchar', 'type')).includes('sudo l vcreate'));
  // the guest's ONLCR, then xterm-pty's
  assert.ok(mirror('lvm-batch-C').includes('created.\r\r\n'));
});

test('#69 screen() reads the monitor\'s redraws as the commands typed', () => {
  assert.deepEqual(screenOf(mirror('monitor', 'cont')), [
    'QEMU 10.2.1 monitor - type \'help\' for more information',
    '(qemu) cont',
    '(qemu)',
  ]);
  // a keystroke at a time: eleven redraws, one line
  assert.deepEqual(screenOf(mirror('monitor', 'info status')).slice(-3),
    ['(qemu) info status', 'VM status: running', '(qemu)']);
});

test('#69 screen() reads readline\'s redraw at the right margin as one lvcreate', () => {
  const cmd = 'user@bashtion:~$ sudo pvcreate /dev/vdb && sudo vgcreate vg00 /dev/vdb && ' +
              'sudo lvcreate -y -L 100M -n lab vg00';
  for (const name of ['lvm-batch-C', 'lvm-perchar']) {
    assert.equal(lastOf(mirror(name, 'type')), cmd, name);
    // and CR CR LF is one line break, not two and not a stray CR
    assert.deepEqual(screenOf(mirror(name)), [
      cmd,
      '  Physical volume "/dev/vdb" successfully created.',
      '  Volume group "vg00" successfully created',
      '  Logical volume "lab" created.',
      'user@bashtion:~$',
    ], name);
  }
});

test('#69 atPrompt: a line typed and then erased is idle again', () => {
  // Raw, every one of these still reads as typed: the erase is BS and ESC[K,
  // or cursor motion and a redraw, and the raw mirror carries out neither.
  // That starved the resize sync until the next command was run.
  for (const [name, typed, erased] of [
    ['erase', 'type', 'bs'],
    ['kill-line', 'type', 'ctrl-u'],
    ['history', 'up', 'down'],
    ['wrapped-kill', 'type', 'ctrl-u'],
    ['wrapped-kill-C', 'type', 'ctrl-u'],
    ['ctrl-c', 'type', 'ctrl-c'],
  ]) {
    assert.equal(atCap(name, typed), false, `${name}/${typed}`);
    assert.equal(atCap(name, erased), true, `${name}/${erased}`);
    assert.equal(lastOf(mirror(name, erased)), 'user@bashtion:~$', `${name}/${erased}`);
  }
  assert.equal(atCap('clear', 'clear'), true);
});

test('#69 atPrompt: a clear after long wrapped output leaves a prompt, not a tail', () => {
  // A paragraph of output 39 rows long, then the prompt: the top row of the
  // screen is now the middle of that paragraph, a row reached by wrapping.
  // `clear` (captured: ESC[H ESC[J under TERM=vt220) and readline's Ctrl-L
  // (the same terminfo `clear`, then the prompt redrawn) erase it from its
  // first column, and the prompt is drawn there. It is a line of its own, as
  // xterm.js has it - not the end of the paragraph's last scrolled-off row.
  const prompt = mirror('clear', 'boot');
  const paragraph = prompt + 'cat notes.txt\r\r\n' + 'lorem ipsum '.repeat(260) + '\r\r\n' + prompt;
  for (const [how, clear] of [['clear', 'clear\r\r\n\x1b[H\x1b[J' + prompt], ['ctrl-l', '\x1b[H\x1b[J' + prompt]]) {
    const raw = paragraph + clear;
    assert.equal(lastOf(raw), 'user@bashtion:~$', how);
    assert.equal(at(raw), true, how);
  }
});

test('#69 atPrompt: the wrapped tail of a half-typed line is not a prompt', () => {
  // `echo aaa…a x$ ` crosses the margin so that its second row reads `x$ `.
  // Home then End has readline move back down onto that row with an LF (and,
  // in the C locale, reprint it). Read raw, the last line was then `x$ ` - and
  // the page would type `stty rows …` into the middle of the command and
  // press Enter.
  for (const name of ['home-end', 'home-end-C']) {
    for (const step of ['type', 'home', 'end']) {
      assert.equal(atCap(name, step), false, `${name}/${step}`);
    }
    assert.equal(lastOf(mirror(name)), 'user@bashtion:~$ echo ' + 'a'.repeat(58) + 'x$', name);
  }
});

test('#69 atPrompt: `# ` typed in an editor is not a root prompt', () => {
  // vim and nano address the cursor directly. On the screen the cursor's line
  // is the file's first line, `# ` with nothing after it - prompt-shaped. What
  // rules it out is the status line and the shortcut bar below it.
  for (const name of ['vim', 'nano']) {
    assert.equal(lastOf(mirror(name, 'comment')), '#', name);
    assert.equal(atCap(name, 'comment'), false, name);
  }
});

test('#69 atPrompt: `# ` typed into a running command is not a prompt', () => {
  // `cat > notes` reads the tty itself, and under TERM=vt220 vim draws its
  // `/` search on the main screen's bottom row. Either way `# ` is the last
  // thing on the screen with nothing after it - prompt-shaped - and the page
  // would type `stty rows …` and Enter into the file or the search. What
  // rules it out is the shell's own word (OSC 3008) that a command has the
  // terminal. A nested bash reads no profile.d and says nothing, so the
  // login shell's word stands until it exits: neither its Ubuntu PS1 nor a
  // bare `# ` in a command it runs is taken for the login shell's prompt.
  for (const [step, line, idle] of [
    ['boot', 'user@bashtion:~$', true],
    ['comment', '#', false],
    ['eof', 'user@bashtion:~$', true],
    ['search', '/#', false],
    ['quit', 'user@bashtion:~$', true],
    ['bash', 'user@bashtion:~$', false],
    ['nested comment', '#', false],
    ['nested eof', 'user@bashtion:~$', false],
    ['exit', 'user@bashtion:~$', true],
    ['enter', 'user@bashtion:~$', true],
  ]) {
    assert.equal(lastOf(mirror('shell-context', step)), line, step);
    assert.equal(atCap('shell-context', step), idle, step);
  }
});

test('#69 atPrompt: a whole Ubuntu prompt is not a prompt while a command has the terminal', () => {
  // The login shell has said a command has the terminal, and the screen then
  // ends `user@bashtion:~$ ` with nothing after it: typed into `cat`, or
  // printed by `read -p`. Neither is a shell, and the page would type
  // `stty rows …` and Enter into the file or the answer - and record the
  // geometry as told. Shape cannot tell them from a nested shell's prompt,
  // so while a command has the terminal nothing is a prompt. That includes
  // the root shell `sudo -s` starts, which is a shell but says nothing: under
  // Ubuntu's sudo (Defaults use_pty) it is on a pty of its own, and `stty`
  // typed into it resizes that pty alone - the login shell's tty keeps its
  // old size after `exit`. The login shell's own prompt is where it lands.
  for (const [step, line, idle] of [
    ['boot', 'user@bashtion:~$', true],
    ['cat', '', false],
    ['type', 'user@bashtion:~$', false],
    ['eof', 'user@bashtion:~$', true],
    ['read', 'user@bashtion:~$', false],
    ['answer', 'user@bashtion:~$', true],
    ['sudo -s', 'root@bashtion:/home/user#', false],
    ['exit', 'user@bashtion:~$', true],
  ]) {
    assert.equal(lastOf(mirror('foreground-prompt', step)), line, step);
    assert.equal(atCap('foreground-prompt', step), idle, step);
  }
});

test('#69 atPrompt takes the shell\'s last complete word on whose the terminal is', () => {
  const word = (type, end = '\x1b\\') => `\x1b]3008;start=1f;user=user;hostname=bashtion;type=${type}${end}`;
  const read = (said) => at('\r\n' + said + '$ ');   // e.g. `read -p '$ '`
  assert.equal(read(''), true, 'no word from the shell: the shape decides');
  assert.equal(read(word('shell')), true);
  for (const end of ['\x1b\\', '\x07', '\x9c']) assert.equal(read(word('command', end)), false, JSON.stringify(end));
  // anything the shell hands the terminal to, and only until it takes it back
  assert.equal(read(word('elevate')), false);
  assert.equal(read(word('command') + '\x1b]3008;end=1f;exit=success\x1b\\' + word('shell')), true);
  // a terminal reset or a clear is not the shell taking the terminal back
  assert.equal(read(word('command') + '\x1bc\x1b[H\x1b[J'), false);
  // an OSC abandoned before its end is not a word, and nor is a DCS saying it
  assert.equal(read(word('command') + word('shell', '\x18')), false);
  assert.equal(read(word('command') + '\x1bP3008;start=1f;type=shell\x1b\\'), false);
  // nor is any shape an exception: a whole `user@host:dir$ ` is what a
  // program prompting like a shell prints too (`input('root@bashtion:… ')`)
  assert.equal(at(word('command') + '\r\nroot@bashtion:/srv/my files# '), false);
  assert.equal(at(word('shell') + '\r\nroot@bashtion:/srv/my files# '), true);
});

test('#69 atPrompt follows apt\'s progress bar through its scroll region', () => {
  // apt pins the bar to the bottom row by narrowing the scroll region above
  // it, and redraws it by absolute address between a save and a restore of
  // the cursor. Output scrolls inside the region; the bar never moves.
  const raw = mirror('apt');
  const mid = raw.slice(0, raw.indexOf('Setting up tree'));
  const during = screenOf(mid);
  assert.equal(at(mid), false);
  assert.deepEqual(during.slice(-3).map((l) => l.replace(/█+/, '█')),
    ['Unpacking tree (2.3.1-1) ...', '', 'Progress: [ 40%] [█▏                                  ]']);
  assert.equal(during.filter((l) => l.startsWith('Progress:')).length, 1,
    'an earlier bar scrolled up into the output');
  // done: the region is reset, the bar erased, and the prompt is back
  assert.equal(at(raw), true);
  assert.deepEqual(screenOf(raw).slice(-4), [
    'Preparing to unpack .../tree_2.3.1-1_arm64.deb ...',
    'Unpacking tree (2.3.1-1) ...',
    'Setting up tree (2.3.1-1) ...',
    'root@bashtion:~#',
  ]);
});

test('#69 atPrompt through the restore page\'s resume', () => {
  // (qemu) is not a shell prompt; the guest's is, once Enter has woken it.
  assert.equal(atCap('monitor', 'ctrl-a c'), false);
  assert.equal(atCap('monitor', 'cont'), false);
  // the mux's newline on switching back (captured), then the guest's answer
  // to Enter - a newline and its prompt, through both ONLCRs (written here)
  const woken = mirror('monitor', 'cont') + '\r\r\n' + '\r\r\nuser@bashtion:~$ ';
  assert.equal(at(woken), true);
  assert.equal(lastOf(woken), 'user@bashtion:~$');
});

// Where the model cannot vouch for what is at the cursor, atPrompt() says no.
const PS1 = 'user@bashtion:~$ ';

test('#69 atPrompt: never on the alternate screen', () => {
  // Under an xterm TERM, vim, less and the like switch to the alternate screen
  // (terminfo smcup, ESC[?1049h ESC[22;0;0t) and back (rmcup, ESC[?1049l
  // ESC[23;0;0t). Whatever is at the cursor there is theirs: here vim's
  // command line part-way through `:%s/# /`, prompt-shaped and the last thing
  // on the screen.
  const smcup = '\x1b[?1049h\x1b[22;0;0t', rmcup = '\x1b[?1049l\x1b[23;0;0t';
  const vim = PS1 + 'vim notes.sh\r\r\n' + smcup + '\x1b[1;24r\x1b[H\x1b[2J' +
              '~\r\n'.repeat(23) + '\x1b[24;1H:%s/# ';
  assert.equal(lastOf(vim), ':%s/#');
  assert.equal(at(vim), false);
  // 47 and 1047 switch to it too, without saving the cursor
  for (const on of ['\x1b[?47h', '\x1b[?1047h']) {
    assert.equal(at('\r\n' + on + '\x1b[H\x1b[2J# '), false, JSON.stringify(on));
  }
  // rmcup: the main screen again, the cursor back where smcup saved it, and
  // the shell's prompt there is real
  const quit = vim + '\x1b[24;1H\x1b[K' + rmcup + PS1;
  assert.deepEqual(screenOf(quit), [PS1 + 'vim notes.sh', 'user@bashtion:~$']);
  assert.equal(at(quit), true);
});

test('#69 atPrompt: not with the cursor restored across a scroll', () => {
  // DECSC (ESC 7, or CSI s) saves the cursor, DECRC (ESC 8, CSI u) restores
  // it. xterm.js counts the saved row from the top of the whole buffer, so if
  // lines have scrolled into the scrollback in between, the cursor comes back
  // with the text it was saved on - higher up the screen - until the
  // scrollback is full. Here it is saved after `ab`, a line scrolls off, and
  // xterm.js restores it after `ab`, one row up: the row the cursor was saved
  // on now holds `# `, with nothing after it or below it.
  const fill = 'x\r\n'.repeat(22);
  for (const [sc, rc] of [['\x1b7', '\x1b8'], ['\x1b[s', '\x1b[u']]) {
    assert.equal(at(fill + 'ab' + sc + '\r\n# \r\n' + rc), false, JSON.stringify(sc));
  }
  // A scroll region that starts at the top row (apt's) scrolls into the
  // scrollback in xterm.js as well.
  assert.equal(at('\x1b[1;23r' + fill + 'ab\x1b7\r\n# \x1b8'), false);
  // So does a resize: growing by a row with the cursor on the bottom one
  // pulls a row back out of the scrollback, and xterm.js's saved cursor stays
  // with its text, a row further down than where it was saved.
  const win = { __xterm: { cols: 80, rows: 24 } };
  const master = fakeMaster(4096);
  const t = tap();
  t.install(master, win);
  master.emit(new TextEncoder().encode('x\r\n'.repeat(30) + '# \r\n  \x1b7'));
  win.__xterm.rows = 25;
  master.emit(new TextEncoder().encode('\x1b8'));
  assert.equal(t.atPrompt(win), false);
  master.emit(new TextEncoder().encode('\r\n' + PS1));
  assert.equal(t.atPrompt(win), true);
  // With no scroll in between the restore is exact: a size probe (save, move
  // far away, ask where the cursor is, restore) leaves the prompt a prompt.
  assert.equal(at('\r\n' + PS1 + '\x1b7\x1b[32766;32766H\x1b[6n\x1b8'), true);
  // A new line, a clear or a reset ends the doubt.
  const restored = fill + 'ab\x1b7\r\n# \r\n\x1b8';
  assert.equal(at(restored + '\r\n' + PS1), true);
  assert.equal(at(restored + '\x1b[H\x1b[J' + PS1), true);
  assert.equal(at(restored + '\x1bc' + PS1), true);
});

test('#69 atPrompt: not on a line whose start has left the scrollback', () => {
  // The model keeps 1000 rows of scrollback. A command line longer than that
  // - a long paste - loses its start, prompt and all, and what is left of
  // `echo aaa…a$ ` is `aaa…a$ `: prompt-shaped.
  const long = '\r\n' + PS1 + 'echo ' + 'a'.repeat(80 * 1100) + '$ ';
  assert.match(lastOf(long), /^a+\$$/);
  assert.equal(at(long), false);
});

// Where each capture ends, from what the program was doing when it was
// captured: the line the cursor is on, and whether it is an idle shell prompt.
const ENDS = {
  'lvm-batch-C': ['user@bashtion:~$', true],
  'lvm-perchar': ['user@bashtion:~$', true],
  erase: ['user@bashtion:~$', true],
  'kill-line': ['user@bashtion:~$', true],
  history: ['user@bashtion:~$', true],
  'home-end': ['user@bashtion:~$ echo ' + 'a'.repeat(58) + 'x$', false],
  'home-end-C': ['user@bashtion:~$ echo ' + 'a'.repeat(58) + 'x$', false],
  'wrapped-kill': ['user@bashtion:~$', true],
  'wrapped-kill-C': ['user@bashtion:~$', true],
  'ctrl-c': ['user@bashtion:~$', true],
  clear: ['user@bashtion:~$', true],
  vim: ['#', false],             // `# ` typed on the file's first line
  nano: ['#', false],
  apt: ['root@bashtion:~#', true],
  'shell-context': ['user@bashtion:~$', true],
  'foreground-prompt': ['user@bashtion:~$', true],
  monitor: ['(qemu)', false],    // after `info status`
};

test('#69 the live screen ends where each capture does, however the bytes are chunked', () => {
  // install() keeps a model in step with the mirror rather than replaying the
  // whole session on every question. Escape sequences and UTF-8 straddle the
  // chunk boundaries here; the mirror itself must stay raw.
  assert.deepEqual(Object.keys(ENDS).sort(), Object.keys(CAPTURES).sort());
  const enc = new TextEncoder();
  for (const [name, [line, idle]] of Object.entries(ENDS)) {
    const raw = mirror(name);
    for (const n of [1, 3, 7, 4096]) {
      const win = {};
      const master = fakeMaster(n);
      const t = tap();
      t.install(master, win);
      master.emit(enc.encode(raw));
      assert.equal(win.__serial, raw, `${name}/${n}: the mirror is not raw`);
      assert.equal(t.lastLine(win), line, `${name}/${n}`);
      assert.equal(t.atPrompt(win), idle, `${name}/${n}`);
    }
  }
});

test('the live screen draws each chunk at the geometry it arrived at', () => {
  // 100 columns of x at 80 wide is two rows; the terminal then grows to 120
  // and the cursor goes up a row. Replayed at 120 from the start, the x's
  // were one row and the Z lands at its end instead.
  const enc = new TextEncoder();
  const win = { __xterm: { cols: 80, rows: 24 } };
  const master = fakeMaster(4096);
  const t = tap();
  t.install(master, win);
  master.emit(enc.encode('x'.repeat(100)));
  win.__xterm.cols = 120;
  master.emit(enc.encode('\x1b[AZ'));
  assert.deepEqual(t.screen(win), ['x'.repeat(20) + 'Z' + 'x'.repeat(79)]);
  assert.deepEqual(t.screen({ __serial: win.__serial, __xterm: win.__xterm }),
    ['x'.repeat(100) + 'Z']);
});

test('the live screen starts again from the mirror if the mirror is replaced', () => {
  const enc = new TextEncoder();
  const win = {};
  const master = fakeMaster(64);
  const t = tap();
  t.install(master, win);
  master.emit(enc.encode('some output\r\r\n'));
  win.__serial = 'user@bashtion:~$ ';
  assert.equal(t.atPrompt(win), true);
  master.emit(enc.encode('ls'));
  assert.equal(win.__serial, 'user@bashtion:~$ ls');
  assert.deepEqual(t.screen(win), ['user@bashtion:~$ ls']);
});

// ------------------------------------------------------------ the model
test('the deferred wrap: a full row wraps on the next character, not before', () => {
  const x80 = 'x'.repeat(80);
  // a line exactly as wide as the terminal, then CR LF: no blank line after it
  assert.deepEqual(screenOf(x80 + '\r\r\nnext'), [x80, 'next']);
  // one more character wraps, and the two rows are one line
  assert.deepEqual(screenOf(x80 + 'y'), [x80 + 'y']);
  // CR at the margin has not wrapped yet: it returns to the start of the SAME row
  assert.deepEqual(screenOf(x80 + '\rZ'), ['Z' + x80.slice(1)]);
  // BS from the margin lands on the second-last column, as xterm.js does
  assert.deepEqual(screenOf(x80 + '\bZ'), [x80.slice(0, 78) + 'Zx']);
  // and the wrap point is the terminal's width
  assert.deepEqual(screenOf('x'.repeat(100) + '\rZ'), [x80 + 'Z' + 'x'.repeat(19)]);
  assert.deepEqual(screenOf('x'.repeat(100) + '\rZ', { cols: 120, rows: 24 }), ['Z' + 'x'.repeat(99)]);
});

test('autowrap off (SeaBIOS sends ESC[?7l) overwrites the last column; a reset turns it back on', () => {
  assert.deepEqual(screenOf('\x1b[?7l' + 'a'.repeat(79) + 'bcd'), ['a'.repeat(79) + 'd']);
  assert.deepEqual(screenOf('\x1b[?7l\x1bc' + 'a'.repeat(81)), ['a'.repeat(81)]);
  // ... and so does a soft reset (DECSTR), which is what systemd's tty reset sends
  assert.deepEqual(screenOf('\x1b[?7l\x1b[!p' + 'a'.repeat(81)), ['a'.repeat(81)]);
  // what SeaBIOS actually sent: RIS, autowrap off, clear - the monitor above it is gone
  assert.equal(screenOf(mirror('monitor', 'seabios'))[0],
    'SeaBIOS (version 1.17.0-debian-1.17.0-1ubuntu1)');
});

test('wide characters take two cells, combining ones none', () => {
  // two backspaces land on 本's first half; overwriting half of it blanks it
  assert.deepEqual(screenOf('日本\b\bx'), ['日x']);
  // a wide character that no longer fits wraps whole
  assert.deepEqual(screenOf('a'.repeat(79) + '日'), ['a'.repeat(79) + '日']);
  assert.deepEqual(screenOf('éx\bY'), ['éY']);
});

test('OSC, DCS and the other strings are skipped whole, whichever way they end', () => {
  // 26.04's shell integration brackets the prompt; vim probes with a DCS
  const ctx = '\x1b]3008;start=0f3c;user=user;hostname=bashtion;type=shell\x1b\\';
  assert.equal(at('\r\n' + ctx + 'user@bashtion:~$ \x1b]0;user@bashtion: ~\x07'), true);
  assert.deepEqual(screenOf('a\x1bPzz\x1b\\b\x1b_apc\x1b\\c'), ['abc']);
});

test('#69 BEL ends an OSC, but a DCS, SOS, PM or APC only at ST', () => {
  // xterm's parser (the VT500 one) lets BEL end an OSC. The other control
  // strings end only at ST: a BEL inside one is payload, and so is anything
  // prompt-shaped after it - none of it reaches the screen.
  const prompt = 'user@bashtion:~$ ';
  for (const open of ['\x1bP+q', '\x1bX', '\x1b^', '\x1b_G', '\x90', '\x98']) {
    const raw = 'output\r\r\n' + open + '6b63\x07' + prompt;
    assert.equal(at(raw), false, JSON.stringify(open));
    assert.equal(lastOf(raw), '', JSON.stringify(open));
    // ST closes it, and the shell's prompt after that is real
    for (const st of ['\x1b\\', '\x9c']) {
      assert.equal(at(raw + st + prompt), true, JSON.stringify(open + st));
      assert.equal(lastOf(raw + st + prompt), 'user@bashtion:~$', JSON.stringify(open + st));
    }
  }
  assert.equal(at('output\r\r\n\x1b]2;title\x07' + prompt), true);
  assert.equal(at('output\r\r\n\x9d2;title\x07' + prompt), true);
});
