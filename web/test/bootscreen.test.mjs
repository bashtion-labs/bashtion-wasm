import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
