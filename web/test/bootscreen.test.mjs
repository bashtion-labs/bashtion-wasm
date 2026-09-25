import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadScript } from './load.mjs';
import { makeDocument } from './fake-page.mjs';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'bootscreen.js'), 'utf8');

function tower() {
  const m = SRC.match(/const TOWER = ("(?:[^"\\]|\\.)*");/);
  assert.ok(m, 'could not find TOWER in bootscreen.js');
  return JSON.parse(m[1]).split('\n');
}

// The banner is a <pre> centred as a flex item, so the box it is centred in is
// as wide as its LONGEST line. Leading spaces that are not balanced by trailing
// ones therefore push the drawing off-centre inside its own box, while the text
// underneath is centred properly — which is exactly how it shipped: every line
// carried a 4-column indent, so the tower sat 2 columns right of the wordmark.
test('the banner is centred inside the box its longest line defines', () => {
  const lines = tower();
  const box = Math.max(...lines.map((l) => l.length));
  const centres = lines.map((l) => (l.search(/\S/) + l.replace(/\s+$/, '').length) / 2);
  const drawing = (Math.min(...centres) + Math.max(...centres)) / 2;
  assert.equal(drawing, box / 2,
    `drawing centre ${drawing} vs box centre ${box / 2} — ` +
    `${Math.abs(drawing - box / 2)} columns off`);
});

test('no line carries an indent every other line shares', () => {
  const lines = tower();
  assert.equal(Math.min(...lines.map((l) => l.search(/\S/))), 0,
    'a common leading indent shifts the drawing right of centre');
});

test('the drawing is internally consistent', () => {
  const lines = tower();
  const centres = new Set(
    lines.map((l) => (l.search(/\S/) + l.replace(/\s+$/, '').length) / 2));
  assert.equal(centres.size, 1, 'the tower rows are not centred on each other');
});

test('letter-spacing on the wordmark is compensated', () => {
  // letter-spacing adds its gap AFTER the last glyph too, so a centred block
  // renders its visible text half a gap left of true centre.
  const m = SRC.match(/letter-spacing:(\d+)px([^"]*)/);
  assert.ok(m, 'no letter-spacing found');
  assert.ok(m[2].includes(`margin-right:-${m[1]}px`),
    'letter-spacing is not offset by a negative right margin');
});

// ------------------------------------------------------------- behaviour
// The cover lifts in two steps: once the console has sat at a prompt for a
// moment, the handover is typed into it; once that has run, the cover fades.
// Both are questions about the screen, asked of SERIALTAP.

function boot(t, serial) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const pasted = [];
  const win = { __serial: serial, __paste: (s) => pasted.push(s) };
  const document = makeDocument();
  const SERIALTAP = loadScript('serialtap.js', 'SERIALTAP', { TextDecoder });
  loadScript('bootscreen.js', 'BOOTSCREEN', { window: win, document, SERIALTAP });
  const cover = document.body.children[0];
  // one mock tick per 100 ms: a single long tick runs each interval once
  const wait = (ms) => { for (let i = 0; i < ms; i += 100) t.mock.timers.tick(100); };
  return { win, pasted, wait, lifted: () => cover.style.opacity === '0' };
}

test('#69 the boot screen does not type the handover into a half-typed line', (t) => {
  // `echo $` ends in `$`, which is all the old check asked for
  const b = boot(t, '\r\r\nuser@bashtion:~$ echo $');
  b.wait(10000);
  assert.deepEqual(b.pasted, [], 'the handover went into `echo $`');
  // erased again (readline: a BS and ESC[K per character) - now it is idle
  b.win.__serial += '\b\x1b[K'.repeat(6);
  b.wait(2000);
  assert.equal(b.pasted.length, 1);
  assert.match(b.pasted[0], /; clear; cat \/etc\/motd/);
});

test('#69 the cover lifts once the handover\'s clear has run and the prompt is back', (t) => {
  const b = boot(t, '\r\r\nuser@bashtion:~$ ');
  b.wait(2000);
  assert.equal(b.pasted.length, 1);
  const echo = b.pasted[0].replace(/\n$/, '');
  // readline has echoed the command line; nothing has run yet
  b.win.__serial += echo;
  b.wait(1000);
  assert.equal(b.lifted(), false);
  // ran: `clear` (vt220: ESC[H ESC[J), the motd, a fresh prompt
  b.win.__serial += '\r\r\n\x1b[H\x1b[JWelcome to bashtion.\r\r\nuser@bashtion:~$ ';
  b.wait(300);
  assert.equal(b.lifted(), true);
});

test('#69 a margin redraw that splits the echoed `clear` does not hold the cover up', (t) => {
  // readline's redraw across the right margin writes the new row's first
  // character, CR, then that character again (see console-captures.mjs,
  // lvm-batch-C). When the margin falls inside `clear`, the echo never
  // contains the word, and only what `clear` printed says it ran.
  const b = boot(t, '\r\r\nuser@bashtion:~$ ');
  b.wait(2000);
  const echo = b.pasted[0].replace(/\n$/, '').replace('clear', 'cle\rear');
  b.win.__serial += echo + '\r\r\n\x1b[H\x1b[JWelcome to bashtion.\r\r\nuser@bashtion:~$ ';
  b.wait(300);
  assert.equal(b.lifted(), true, 'the cover waited out its 15 s fallback');
});
