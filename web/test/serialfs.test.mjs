import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';
import { makePage, posixCksum } from './fake-page.mjs';

function sfs(guestOpts = {}) {
  const page = makePage(guestOpts);
  page.SERIALFS = loadScript('serialfs.js', 'SERIALFS', page.globals);
  return page;
}

const archive = (n, seed = 7) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 17) & 0xff;
  return b;
};

// --------------------------------------------------------------- integrity
test('the page computes POSIX cksum exactly as coreutils does', () => {
  const { SERIALFS } = sfs();
  const enc = (s) => new TextEncoder().encode(s);
  // values taken from `cksum` on Ubuntu 26.04 coreutils
  assert.equal(SERIALFS._cksum(enc('')), 4294967295);
  assert.equal(SERIALFS._cksum(enc('a')), 1220704766);
  assert.equal(SERIALFS._cksum(enc('hello world')), 1135714720);
  assert.equal(SERIALFS._cksum(enc('The quick brown fox jumps over the lazy dog')), 2074844392);
  assert.equal(SERIALFS._cksum(new Uint8Array(1000)), 2610763910);
});

// -------------------------------------------------------------------- save
test('save captures the archive the guest packed and verifies it', async () => {
  const want = archive(6000);
  const p = sfs({ archive: want });
  await p.SERIALFS.save();
  const saved = p.storage.files.get('bashtion-work.tgz');
  assert.deepEqual(saved, want);
});

test('#61 save reports a damaged transfer instead of storing it', async () => {
  const want = archive(4000);
  // one duplicated character mid-stream, exactly the reported corruption
  const p = sfs({ archive: want, mangleSave: (b64) => b64.slice(0, 900) + b64[900] + b64.slice(900) });
  await p.SERIALFS.save();
  assert.equal(p.storage.files.has('bashtion-work.tgz'), false);
});

test('save surfaces a guest-side failure rather than a blank overlay', async () => {
  const p = sfs({ packFails: 'no space left on device' });
  await p.SERIALFS.save();
  assert.equal(p.storage.files.has('bashtion-work.tgz'), false);
});

// ----------------------------------------------------------------- restore
test('restore delivers the exact bytes to the guest', async () => {
  const bin = archive(9000, 3);
  const p = sfs({});
  p.storage.files.set('bashtion-work.tgz', bin);
  assert.equal(await p.SERIALFS.load(), true);
  assert.deepEqual(p.guest.restored, bin);
});

test('#48 the payload is never echoed back, and never reaches readline', async () => {
  const bin = archive(6000, 5);
  const p = sfs({});
  p.storage.files.set('bashtion-work.tgz', bin);
  await p.SERIALFS.load();

  const b64 = Buffer.from(bin).toString('base64');
  const probe = b64.slice(1000, 1200);
  assert.ok(!p.guest.payloadSeen().includes(probe),
            'base64 payload was echoed back over the console');
  // every payload byte went to a command reading the tty, not to a shell line
  for (const cmd of p.guest.commands) {
    assert.ok(!cmd.includes(probe), 'payload appeared on a command line: ' + cmd.slice(0, 80));
  }
});

test('#48 blocks stay inside the tty line-discipline buffer', async () => {
  const bin = archive(20000, 9);
  const p = sfs({});
  p.storage.files.set('bashtion-work.tgz', bin);
  await p.SERIALFS.load();
  const reads = p.guest.commands
    .map((c) => c.match(/head -c (\d+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  assert.ok(reads.length > 1, 'expected the transfer to be split into blocks');
  for (const n of reads) assert.ok(n <= 4096, 'block of ' + n + ' bytes exceeds the tty buffer');
});

test('#61 a corrupted block is caught before anything is unpacked', async () => {
  const bin = archive(7000, 11);
  const p = sfs({ mangleBlock: (d, i) => (i === 2 ? d.slice(0, 40) + d[40] + d.slice(40) : d) });
  p.storage.files.set('bashtion-work.tgz', bin);
  assert.equal(await p.SERIALFS.load(), false);
  assert.equal(p.guest.restored, null, 'a damaged archive must not be unpacked');
});

test('#47 a failed restore reports failure instead of spinning forever', async () => {
  const bin = archive(3000, 13);
  const p = sfs({ unpackFails: 'tar: Error is not recoverable' });
  p.storage.files.set('bashtion-work.tgz', bin);
  const ok = await p.SERIALFS.load();
  assert.equal(ok, false);
  const title = findOverlay(p, 'bwOvTitle');
  const bar = findOverlay(p, 'bwOvBar');
  // The original bug: load() took neither the done nor the fail branch, so the
  // overlay sat on "Restoring your work..." forever and the only recovery a
  // user could think of was a reload, which destroys the very work being
  // restored. The overlay must reach a terminal state that says so.
  assert.equal(bar.style.background, '#e0663c', 'overlay never entered its failure state');
  assert.ok(title && title.textContent && !/Restoring/.test(title.textContent),
            'overlay was left on the in-progress message: ' + (title && title.textContent));
  assert.ok(findOverlay(p, 'bwOvSub').textContent.length > 0, 'failure must be explained');
});

test('#47 a guest that goes silent is reported, not waited on forever', async () => {
  const p = sfs({});
  p.storage.files.set('bashtion-work.tgz', archive(2000, 19));
  // a guest that answers nothing at all: no prompt, no markers
  p.win.__paste = () => {};
  const t0 = Date.now();
  const ok = await p.SERIALFS.load();
  assert.equal(ok, false);
  assert.equal(findOverlay(p, 'bwOvBar').style.background, '#e0663c');
  assert.ok(Date.now() - t0 < 30000, 'gave up in a bounded time');
});

test('#47 markers are never matched against their own command echo', async () => {
  const p = sfs({ archive: archive(2000) });
  await p.SERIALFS.save();
  for (const cmd of p.guest.commands) {
    for (const tag of ['BWT-BEGIN', 'BWT-END', 'BWR-READY', 'BWR-OK', 'BWR-SUM', 'BWR-BLK']) {
      assert.ok(!cmd.includes(tag),
                'command line contains a bare marker (' + tag + '): ' + cmd.slice(0, 120));
    }
  }
});

// -------------------------------------------------------------------- #49
test('#49 Load with no file restores the copy this browser remembers', async () => {
  const bin = archive(2500, 17);
  const p = sfs({});
  p.storage.files.set('bashtion-work.tgz', bin);
  assert.equal(await p.SERIALFS.hasSaved(), true);
  assert.equal(await p.SERIALFS.load(), true);   // no argument
  assert.deepEqual(p.guest.restored, bin);
});

test('#49 hasSaved is false when the browser has nothing', async () => {
  const p = sfs({});
  assert.equal(await p.SERIALFS.hasSaved(), false);
  assert.equal(await p.SERIALFS.load(), false);
  assert.equal(p.guest.restored, null);
});

test('#49 a chosen file still takes precedence over the browser copy', async () => {
  const stored = archive(1500, 2);
  const chosen = archive(1800, 4);
  const p = sfs({});
  p.storage.files.set('bashtion-work.tgz', stored);
  const file = { async arrayBuffer() { return chosen.buffer.slice(0); } };
  assert.equal(await p.SERIALFS.load(file), true);
  assert.deepEqual(p.guest.restored, chosen);
});

// -------------------------------------------------------------------- #50/#51
test('#50/#51 save and restore go through the guest helpers, not a bare tar of $HOME', async () => {
  const p = sfs({ archive: archive(1200) });
  await p.SERIALFS.save();
  const packCmd = p.guest.commands.find((c) => c.includes('bashtion-pack'));
  assert.ok(packCmd, 'save must call the guest packer');
  assert.ok(!/--exclude=persist/.test(packCmd), 'the persist exclusion must be gone');
  assert.ok(!/tar czf - -C \/home\/user/.test(packCmd), 'save must not be a bare tar of $HOME');
});

function findOverlay(page, id) {
  for (const el of page.globals.document.body.children) {
    if (el.id === 'bwOverlay') return el.querySelector('#' + id);
  }
  return null;
}
