import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/pack-site.sh decides everything that pairs the release before it
// packages anything: which fork tree each artifact came from (#73), and the
// name the engine is published under, which out.js must fetch (#74). Those
// checks run here against stand-in artifacts; a stub `docker` ends the run
// where emscripten's file_packager would start, so no container is needed.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACK = join(ROOT, 'scripts', 'pack-site.sh');
const REV = '0ef7b4e2814b231705d8371dd7997f5b72e70baf';
const OTHER = 'a5be3d9870154c4484f0928578edd9eaa35f4745';

const put = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };

// What emscripten 3.1.50 writes: the engine's name as a string literal, once
// for Module.locateFile and once for import.meta.url.
const LOADER = [
  'if (Module["locateFile"]) {',
  ' wasmBinaryFile = "qemu-system-x86_64.wasm";',
  '} else {',
  ' wasmBinaryFile = new URL("qemu-system-x86_64.wasm", import.meta.url).href;',
  '}',
].join('\n');

function engine(dir, { rev = REV, wasm = `engine built from ${rev}`, loader = LOADER } = {}) {
  put(join(dir, 'qemu-system-x86_64'), loader);
  put(join(dir, 'qemu-system-x86_64.wasm'), wasm);
  put(join(dir, 'qemu-system-x86_64.worker.js'), '// pthread worker');
  for (const v of ['xterm.js', 'xterm.css', 'xterm-pty.js']) put(join(dir, 'vendor', v), v);
  for (const r of ['bios-256k.bin', 'vgabios-stdvga.bin', 'kvmvapic.bin', 'linuxboot_dma.bin']) {
    put(join(dir, 'pc-bios', r), r);
  }
  if (rev !== null) put(join(dir, 'FORK_REVISION'), `${rev}\n`);
  return dir;
}

function guest(dir, { rev = REV } = {}) {
  put(join(dir, 'image', 'vmlinuz'), 'kernel');
  for (const f of ['rootfs-booted.ext4', 'vdb.qcow2', 'vm.state']) put(join(dir, 'snapshot', f), f);
  if (rev !== null) put(join(dir, 'snapshot', 'FORK_REVISION'), `${rev}\n`);
  return dir;
}

const scratch = () => mkdtempSync(join(tmpdir(), 'pack-site-'));
const bin = scratch();
put(join(bin, 'docker'), '#!/bin/sh\necho "stub docker: $*" >&2\nexit 97\n');
chmodSync(join(bin, 'docker'), 0o755);

function pack(engineDir, guestDir) {
  const out = join(scratch(), 'site');
  const r = spawnSync('bash', [PACK, '--engine', engineDir, '--guest', guestDir, '--out', out, '--r2-tag', 'v3'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { ...r, out, said: r.stdout + r.stderr };
}

// Refused before anything is packaged: file_packager never ran.
function refused(r, why) {
  assert.notEqual(r.status, 0, r.said);
  assert.ok(!r.said.includes('stub docker'), `went on to package:\n${r.said}`);
  assert.match(r.said, why);
}

// Every check passed, and the run stopped only at the stub.
function packed(r) {
  assert.match(r.said, /stub docker: run/, r.said);
  assert.match(r.said, /engine and snapshot agree/);
}

test('#73 an engine and a snapshot from the same fork commit go on to packaging', () => {
  const d = scratch();
  packed(pack(engine(join(d, 'engine')), guest(join(d, 'guest'))));
});

test('#73 an engine and a snapshot from different fork commits are refused', () => {
  const d = scratch();
  refused(pack(engine(join(d, 'engine')), guest(join(d, 'guest'), { rev: OTHER })), /different fork trees/);
});

test('#73 an artifact that records no fork commit is refused, on either side', () => {
  const d = scratch();
  refused(pack(engine(join(d, 'e1'), { rev: null }), guest(join(d, 'g1'))), /qemu-engine artifact records no FORK_REVISION/);
  refused(pack(engine(join(d, 'e2')), guest(join(d, 'g2'), { rev: null })), /snapshot-set artifact records no FORK_REVISION/);
});

test('#73 a fork commit that is not a full id is refused', () => {
  const d = scratch();
  refused(pack(engine(join(d, 'engine')), guest(join(d, 'guest'), { rev: '0ef7b4e' })), /not a commit id/);
});

test('#73 each marker speaks for its own artifact, even with both in one directory', () => {
  // Passing one download directory as both --engine and --guest: a marker
  // found by name alone would be the same file twice, and always agree.
  const bad = scratch();
  engine(join(bad, 'qemu-engine'));
  guest(join(bad, 'snapshot-set'), { rev: OTHER });
  refused(pack(bad, bad), /different fork trees/);

  const good = scratch();
  engine(join(good, 'qemu-engine'));
  guest(join(good, 'snapshot-set'));
  packed(pack(good, good));
});

test('#73 a directory holding two of an artifact is refused, not guessed at', () => {
  const d = scratch();
  guest(join(d, 'guest'));
  guest(join(d, 'guest', 'snapshot-set'), { rev: OTHER });     // an older download left behind
  refused(pack(engine(join(d, 'engine')), join(d, 'guest')), /2 copies of vmlinuz/);

  const e = scratch();
  engine(join(e, 'engine'));
  engine(join(e, 'engine', 'qemu-engine'));
  refused(pack(join(e, 'engine'), guest(join(e, 'guest'))), /2 copies of out\.js \(or qemu-system-x86_64\)/);
});

test('#74 the engine is published under its hash, and out.js fetches exactly that', () => {
  const d = scratch();
  const wasm = 'the engine bytes';
  const r = pack(engine(join(d, 'engine'), { wasm }), guest(join(d, 'guest')));
  packed(r);
  const name = `qemu-system-x86_64.${createHash('sha256').update(wasm).digest('hex').slice(0, 16)}.wasm`;
  assert.equal(readFileSync(join(r.out, name), 'utf8'), wasm);
  assert.ok(!existsSync(join(r.out, 'qemu-system-x86_64.wasm')), 'the engine was also published under its fixed name');
  const js = readFileSync(join(r.out, 'out.js'), 'utf8');
  assert.equal(js.split(`"${name}"`).length - 1, 2, js);
  assert.ok(!js.includes('qemu-system-x86_64.wasm'), js);
  assert.match(r.said, new RegExp(`out\\.js fetches ${name.replace(/\./g, '\\.')} \\(2 references renamed\\)`));
});

test('#74 an out.js that does not name the engine the expected way is refused', () => {
  const d = scratch();
  const loader = "wasmBinaryFile = locateFile('qemu-system-x86_64.wasm');";
  const r = pack(engine(join(d, 'engine'), { loader }), guest(join(d, 'guest')));
  refused(r, /out\.js never names "qemu-system-x86_64\.wasm"/);
});
