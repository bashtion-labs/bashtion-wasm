import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';

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
