import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';
import { makePage, makeXterm, posixCksum } from './fake-page.mjs';

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
  // Inside a single 512-char payload line. A window spanning a line boundary
  // (e.g. 1000..1200, which straddles 1024) can never match an echo, because
  // any echo reproduces it with the separator in the middle — so the
  // assertion held whether the payload was echoed or not.
  const probe = b64.slice(1030, 1200);
  assert.ok(!p.guest.payloadSeen().includes(probe),
            'base64 payload was echoed back over the console');
  // every payload byte went to a command reading the tty, not to a shell line
  for (const cmd of p.guest.commands) {
    assert.ok(!cmd.includes(probe), 'payload appeared on a command line: ' + cmd.slice(0, 80));
  }
});

test('#48 the echo probe would actually catch an echoing payload', async () => {
  const bin = archive(6000, 5);
  // a guest that echoes what a tty-reading command consumes, i.e. ECHO left on
  const p = sfs({ echoPayload: true });
  p.storage.files.set('bashtion-work.tgz', bin);
  await p.SERIALFS.load();
  const b64 = Buffer.from(bin).toString('base64');
  assert.ok(p.guest.payloadSeen().includes(b64.slice(1030, 1200)),
            'the probe must detect a payload that IS echoed, or it proves nothing');
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

test('#47/#61 a stalled block is recovered: the reader is freed and echo restored', async () => {
  const p = sfs({ stallAtBlock: 2 });
  p.win.__bwTimeouts = { idle: 300, work: 300, hard: 1500, hardWork: 1500 };
  p.storage.files.set('bashtion-work.tgz', archive(9000, 31));
  const ok = await p.SERIALFS.load();
  assert.equal(ok, false, 'a stalled transfer must report failure');
  assert.ok(p.guest.interrupts > 0,
            'the blocked reader was never interrupted, so recovery was eaten as payload');
  // `stty echo` must arrive as its own command line, not buried behind a Ctrl-C
  // that never happened and not as part of the happy-path unpack line.
  const recovery = p.guest.commands.filter(
    (c) => /^stty echo; rm -f /.test(c));
  assert.ok(recovery.length > 0,
            'no standalone recovery command ran; saw: ' +
            JSON.stringify(p.guest.commands.slice(-3)));
  assert.equal(p.guest.restored, null, 'nothing may be unpacked after a stall');
});

test('#47 a wedged transfer next to a chatty guest still gives up', async () => {
  const p = sfs({ stallAtBlock: 2 });
  p.win.__bwTimeouts = { idle: 400, work: 400, hard: 2000, hardWork: 2000 };
  p.storage.files.set('bashtion-work.tgz', archive(9000, 37));
  // background output refreshes the idle timer forever; only the absolute
  // deadline can end this
  const stop = p.guest.startChatter(40);
  // Without an absolute deadline this never settles at all, so race it: a hung
  // promise must surface as a failed assertion, not as a timed-out CI job.
  const ok = await Promise.race([
    p.SERIALFS.load(),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('load() never settled — background chatter kept the '
                        + 'idle timer alive and nothing bounded the wait')), 15000)),
  ]).catch((e) => { stop(); throw e; });
  stop();
  assert.equal(ok, false);
  assert.equal(findOverlay(p, 'bwOvBar').style.background, '#e0663c');
});

test('#49 a second load while one is running leaves the overlay alone', async () => {
  const p = sfs({});
  p.storage.files.set('bashtion-work.tgz', archive(6000, 41));
  const first = p.SERIALFS.load();
  const second = await p.SERIALFS.load();     // lands while the first is mid-flight
  assert.equal(second, false);
  // ov.fail would repaint the shared overlay red and arm a 6 s hide, exposing
  // the raw transfer of the run that is still going.
  assert.notEqual(findOverlay(p, 'bwOvBar').style.background, '#e0663c');
  assert.equal(await first, true);
});

test('nothing is typed at the guest when there is no shell prompt', async () => {
  const p = sfs({});
  p.storage.files.set('bashtion-work.tgz', archive(2000, 43));
  p.win.__bwTimeouts = { idle: 200, work: 200, hard: 800, hardWork: 800, prompt: 800 };
  // a guest that never shows a prompt: ensureShell must fail and we must not
  // inject shell text into whatever owns the tty (vim, less, a heredoc)
  p.guest.prompt = () => {};
  const before = p.guest.commands.length;
  assert.equal(await p.SERIALFS.load(), false);
  const typed = p.guest.commands.slice(before).filter((c) => c.trim().length > 0);
  assert.deepEqual(typed, [], 'pasted into a guest with no prompt: ' + JSON.stringify(typed));
});

test('the terminal is handed back with echo on, however a transfer ends', async () => {
  for (const opts of [{}, { unpackFails: 'tar: broken' }]) {
    const p = sfs(opts);
    p.storage.files.set('bashtion-work.tgz', archive(2500, 23));
    await p.SERIALFS.load();
    const restored = p.guest.commands.filter((c) => /(^|; )stty echo/.test(c));
    assert.ok(restored.length > 0,
              'no `stty echo` after a transfer that ' +
              (opts.unpackFails ? 'failed' : 'succeeded'));
  }
});

test('a failed save also restores echo', async () => {
  const p = sfs({ packFails: 'boom' });
  await p.SERIALFS.save();
  assert.ok(p.guest.commands.some((c) => /(^|; )stty echo/.test(c)),
            'no `stty echo` after a failed save');
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

// -------------------------------------------------------------------- #72
// What bashtion-unpack prints last when the archive came from another build
// of the image: it restored the home directory, and nothing else.
const HOME_ONLY = 'bashtion-unpack: restored home only; 4 system paths and 1 deletions ' +
                  'not applied (archive build none, this build 0123456789ab)';

test('#72 a home-only restore is reported as such, not as a plain success', async () => {
  const p = sfs({ unpackSays: HOME_ONLY });
  const status = [];
  p.win.__sfsStatus = (m) => status.push(m);
  p.storage.files.set('bashtion-work.tgz', archive(3000, 47));
  assert.equal(await p.SERIALFS.load(), 'home-only');
  const title = findOverlay(p, 'bwOvTitle').textContent;
  assert.match(title, /only your home folder/i);
  assert.doesNotMatch(title, /✓/, 'a partial restore wears the success tick: ' + title);
  assert.notEqual(findOverlay(p, 'bwOvBar').style.background, '#3ec77a',
                  'a partial restore is painted as a plain success');
  assert.match(findOverlay(p, 'bwOvSub').textContent, /different version/,
               'the overlay must say why only home came back');
  // The overlay hides itself; the status line is what is still there later.
  assert.match(status.at(-1) || '', /home folder only/);
});

test('#72 a full restore is still reported as the whole session', async () => {
  const p = sfs({ unpackSays: 'bashtion-unpack: restored; 2 deletions applied' });
  const status = [];
  p.win.__sfsStatus = (m) => status.push(m);
  p.storage.files.set('bashtion-work.tgz', archive(3000, 53));
  assert.equal(await p.SERIALFS.load(), true);
  assert.equal(findOverlay(p, 'bwOvTitle').textContent, '✓ Your work was restored');
  assert.equal(findOverlay(p, 'bwOvBar').style.background, '#3ec77a');
  assert.doesNotMatch(status.at(-1) || '', /only/);
});

test('#72 the verdict is read only once its whole line has arrived', async () => {
  // "BWR-OK bashtion-unpack: restored home" ... " only; ..." - acting on the
  // first piece reads a home-only restore as a full one.
  const p = sfs({ unpackSays: HOME_ONLY, verdictInPieces: 800 });
  p.storage.files.set('bashtion-work.tgz', archive(3000, 59));
  assert.equal(await p.SERIALFS.load(), 'home-only');
  assert.match(findOverlay(p, 'bwOvTitle').textContent, /only your home folder/i);
});

test('#72 an archive the guest refuses says why', async () => {
  const why = 'bashtion-unpack: this archive was saved by a newer bashtion ' +
              '(format 3; this one reads up to 2); nothing was restored';
  const p = sfs({ unpackFails: why });
  p.storage.files.set('bashtion-work.tgz', archive(3000, 61));
  assert.equal(await p.SERIALFS.load(), false);
  assert.equal(findOverlay(p, 'bwOvBar').style.background, '#e0663c');
  assert.equal(findOverlay(p, 'bwOvSub').textContent, why);
});

test('#72 a finished warning does not tint the next transfer', async () => {
  const p = sfs({ unpackSays: HOME_ONLY, archive: archive(1500) });
  p.storage.files.set('bashtion-work.tgz', archive(3000, 67));
  assert.equal(await p.SERIALFS.load(), 'home-only');
  // the next operation starts while the warning is still up
  const saving = p.SERIALFS.save();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(findOverlay(p, 'bwOvBar').style.background, '#4a9eff',
               'an in-progress save is still painted in the warning colour');
  await saving;
});

// -------------------------------------------------------------------- #65
// Checkpoints: the whole machine, through the monitor on the other side of
// the -nographic mux.
const LAYER = 'snapshot_blkdev root /tmp/bashtion-root.qcow2 qcow2';
const MONITOR_COMMANDS = new Set(['stop', LAYER, 'savevm bashtion', 'info snapshots',
                                  'loadvm bashtion', 'cont']);
const RESYNC = /^sudo date -u -s @(\d+) >\/dev\/null 2>&1; sudo hwclock --systohc >\/dev\/null 2>&1; stty rows 30 cols 100; clear$/;
const VIRTFS = "Migration is disabled when VirtFS export path '/share' is mounted in the guest " +
               "using mount_tag 'share0'";
const UNSYNCED = 'The time inside the machine may be wrong, and so may the screen size.';
// every wait short, so the paths that give up are reached in a test's time
const FAST = { idle: 300, work: 300, hard: 1500, hardWork: 1500, mux: 300, prompt: 300 };

function machine(guestOpts = {}, { xterm = true, termfit = true } = {}) {
  const page = makePage(guestOpts);
  if (xterm) page.term = makeXterm(page.win, page.guest);
  if (termfit) page.globals.TERMFIT = loadScript('termfit.js', 'TERMFIT', page.globals);
  page.status = [];
  page.win.__sfsStatus = (m) => page.status.push(m);
  page.seeded = [];
  page.win.__geomSync = { seed: (g) => page.seeded.push(g) };
  page.SERIALFS = loadScript('serialfs.js', 'SERIALFS', page.globals);
  return page;
}

// The trace as one line per step, with the re-sync line named.
const steps = (p, from = 0) => p.guest.trace.slice(from).map(([side, line]) =>
  side === 'shell' && RESYNC.test(line) ? 'shell: re-sync' : side + ': ' + line);

const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

test('#65 saving and going back send exactly these steps, in this order', async () => {
  const p = machine();
  assert.equal(await p.SERIALFS.checkpoint(), true);
  assert.equal(await p.SERIALFS.checkpoint(), true);
  assert.equal(await p.SERIALFS.rollback(), true);
  assert.deepEqual(steps(p), [
    // first checkpoint: a prompt, then the monitor, with the qcow2 layer
    'shell: ', 'mux: monitor', 'monitor: stop', 'monitor: ' + LAYER, 'monitor: savevm bashtion',
    'monitor: cont', 'mux: serial', 'shell: re-sync',
    // a later one: no layer
    'shell: ', 'mux: monitor', 'monitor: stop', 'monitor: savevm bashtion', 'monitor: cont',
    'mux: serial', 'shell: re-sync',
    // going back: straight to the monitor, and the prompt check only afterwards
    'mux: monitor', 'monitor: stop', 'monitor: loadvm bashtion', 'monitor: cont', 'mux: serial',
    'shell: ', 'shell: re-sync',
  ]);
  assert.equal(p.guest.running, true);
});

test('#65 the qcow2 layer is made at the first checkpoint, and only once it has worked', async () => {
  const p = machine({ layerFails: "Could not create '/tmp/bashtion-root.qcow2': No space left on device" });
  assert.equal(await p.SERIALFS.checkpoint(), false);
  // a failed layer is followed by cont, never by savevm
  assert.deepEqual(p.guest.monitor, ['stop', LAYER, 'cont']);
  assert.equal(p.SERIALFS.checkpointTime(), null);
  assert.equal(findOverlay(p, 'bwOvSub').textContent,
               "Could not create '/tmp/bashtion-root.qcow2': No space left on device.");
  p.guest.opts.layerFails = null;
  assert.equal(await p.SERIALFS.checkpoint(), true);
  assert.equal(await p.SERIALFS.checkpoint(), true);
  assert.equal(p.guest.monitor.filter((c) => c === LAYER).length, 2,
               'the failed attempt and the one that worked, and never again: ' +
               JSON.stringify(p.guest.monitor));
});

test('#65 a failed savevm resumes the machine, and info snapshots shows the earlier checkpoint survived', async () => {
  const p = machine();
  assert.equal(await p.SERIALFS.checkpoint(), true);
  const first = p.SERIALFS.checkpointTime();
  p.guest.opts.savevmFails = VIRTFS;
  const from = p.guest.monitor.length;
  assert.equal(await p.SERIALFS.checkpoint(), false);
  assert.deepEqual(p.guest.monitor.slice(from), ['stop', 'savevm bashtion', 'info snapshots', 'cont']);
  assert.equal(p.guest.running, true, 'a failed savevm left the machine stopped');
  assert.equal(findOverlay(p, 'bwOvTitle').textContent, 'Could not save a checkpoint');
  assert.equal(findOverlay(p, 'bwOvSub').textContent, VIRTFS + '.');
  assert.equal(p.SERIALFS.checkpointTime().getTime(), first.getTime());
  // and it is still there to go back to
  p.guest.opts.savevmFails = null;
  assert.equal(await p.SERIALFS.rollback(), true);
});

test('#65 a failed savevm that took the earlier checkpoint with it says so, and forgets it', async () => {
  const p = machine();
  assert.equal(await p.SERIALFS.checkpoint(), true);
  p.guest.opts.savevmFails = 'Error while writing VM state: No space left on device';
  p.guest.opts.savevmDropsOld = true;
  const from = p.guest.monitor.length;
  assert.equal(await p.SERIALFS.checkpoint(), false);
  assert.deepEqual(p.guest.monitor.slice(from), ['stop', 'savevm bashtion', 'info snapshots', 'cont']);
  assert.equal(p.guest.running, true);
  assert.equal(p.SERIALFS.checkpointTime(), null);
  assert.equal(findOverlay(p, 'bwOvSub').textContent,
               'Error while writing VM state: No space left on device. Your earlier checkpoint is gone.');
  // the status line no longer offers the time of a checkpoint that is gone
  assert.equal(p.status.at(-1), 'your earlier checkpoint is gone');
});

test('#65 a first checkpoint that fails says nothing about an earlier one', async () => {
  const p = machine({ savevmFails: VIRTFS });
  assert.equal(await p.SERIALFS.checkpoint(), false);
  assert.deepEqual(p.guest.monitor, ['stop', LAYER, 'savevm bashtion', 'info snapshots', 'cont']);
  assert.equal(findOverlay(p, 'bwOvSub').textContent, VIRTFS + '.');
  assert.equal(p.SERIALFS.checkpointTime(), null);
});

test('#65 a failed loadvm is never followed by cont, and says to reload', async () => {
  for (const opts of [{ loadvmFails: "Error -22 while loading VM state" },
                      { monitorHangs: 'loadvm bashtion' }]) {
    const p = machine(opts);
    p.win.__bwTimeouts = FAST;
    assert.equal(await p.SERIALFS.checkpoint(), true);
    const from = p.guest.trace.length;
    assert.equal(await p.SERIALFS.rollback(), false);
    assert.deepEqual(steps(p, from), ['mux: monitor', 'monitor: stop', 'monitor: loadvm bashtion',
                                      'mux: serial'], JSON.stringify(opts));
    assert.equal(p.guest.running, false);
    assert.equal(p.guest.pending, '', 'shell text was typed into the stopped machine');
    assert.equal(findOverlay(p, 'bwOvTitle').textContent, 'Could not go back to your checkpoint');
    const sub = findOverlay(p, 'bwOvSub').textContent;
    assert.match(sub, /\. Reload the page to start again\.$/);
    assert.doesNotMatch(sub, /nothing was changed/i);
    // the overlay goes; what to do about the stopped machine stays
    assert.equal(p.status.at(-1), 'could not go back to your checkpoint — reload the page');
    // and the page's terminal modes are left alone: nothing came back
    assert.ok(!p.term.events.some(([k, d]) => k === 'write' && d.includes('\x1b[?25h')));
  }
});

test('#65 going back with no checkpoint touches nothing', async () => {
  const p = machine();
  assert.equal(p.SERIALFS.checkpointTime(), null);
  assert.equal(await p.SERIALFS.rollback(), false);
  assert.deepEqual(p.guest.trace, []);
  assert.deepEqual(p.term.events, []);
  assert.equal(findOverlay(p, 'bwOvTitle'), null, 'the overlay was shown');
});

test('#65 going back works while a program has the terminal', async () => {
  const p = machine();
  p.guest.machine.marker = 'before';
  assert.equal(await p.SERIALFS.checkpoint(), true);
  const at = p.SERIALFS.checkpointTime();
  p.guest.machine = { after: true };
  const program = p.guest.hold();        // no prompt, and it reads every key
  const from = p.guest.trace.length;
  assert.equal(await p.SERIALFS.rollback(), true);
  assert.equal(program.got, '', 'the page typed into the program that had the terminal');
  assert.deepEqual(p.guest.machine, { marker: 'before' });
  assert.deepEqual(steps(p, from), ['mux: monitor', 'monitor: stop', 'monitor: loadvm bashtion',
                                    'monitor: cont', 'mux: serial', 'shell: ', 'shell: re-sync']);
  assert.equal(findOverlay(p, 'bwOvTitle').textContent, '✓ Back at your checkpoint');
  assert.equal(p.status.at(-1), 'back at your checkpoint from ' + hhmm(at));
  // it stays, so it can be gone back to again
  assert.equal(p.SERIALFS.checkpointTime().getTime(), at.getTime());
  assert.equal(await p.SERIALFS.rollback(), true);
});

test('#65 going back works while a program keeps printing', async () => {
  // `yes`, a loop, `ping`: its output buries the monitor's `(qemu) ` the
  // moment the mux prints it, and keeps every idle timer alive. Its lines
  // start `Error: `, which must not be read as a monitor failure.
  const p = machine({ writeDelayMs: 2 });
  p.win.__bwTimeouts = FAST;
  assert.equal(await p.SERIALFS.checkpoint(), true);
  const program = p.guest.spew('Error: y\r\n', 20);
  try {
    const from = p.guest.trace.length;
    assert.equal(await p.SERIALFS.rollback(), true, findOverlay(p, 'bwOvSub').textContent);
    assert.deepEqual(steps(p, from).slice(0, 5), ['mux: monitor', 'monitor: stop',
                                                  'monitor: loadvm bashtion', 'monitor: cont',
                                                  'mux: serial']);
    assert.equal(program.got, '', 'the page typed into the printing program');
    assert.equal(p.guest.focus, 'serial');
    assert.equal(p.guest.running, true);
  } finally { clearInterval(program.timer); }
});

test('#65 guest lines inside the reply to stop never make it look failed', async () => {
  // `stop` is typed while the guest runs, and the engine lets guest bytes -
  // here part of a line before the echo and a whole `Error: ...` line after
  // it - land inside its reply. Read as a failure, the machine would be left
  // stopped with no `cont`, and the reason would be the guest's garbled text.
  const p = machine({ printsAtStop: 'Error: connection refused, retrying\r\n' });
  assert.equal(await p.SERIALFS.checkpoint(), true, findOverlay(p, 'bwOvSub').textContent);
  assert.deepEqual(p.guest.monitor, ['stop', LAYER, 'savevm bashtion', 'cont']);
  assert.equal(p.guest.running, true);
  assert.equal(await p.SERIALFS.rollback(), true, findOverlay(p, 'bwOvSub').textContent);
  assert.deepEqual(p.guest.monitor.slice(-3), ['stop', 'loadvm bashtion', 'cont']);
  assert.equal(p.guest.running, true);
  assert.equal(p.guest.focus, 'serial');
  // the fake really does put the line where the old rule would have read it
  assert.match(p.guest.payloadSeen(), /\r\r\nError: connection refused, retrying\r\n\(qemu\) /);
});

test('#65 saving while a program keeps printing gives up in seconds, typing nothing more', async () => {
  // `ping` or `top` resets an idle timer forever, and the overlay keeps the
  // user from reaching the terminal to stop it: only a hard cap ends this.
  const p = machine({ writeDelayMs: 2 });
  p.win.__bwTimeouts = { idle: 300, work: 300, hard: 60000, hardWork: 60000, mux: 300, prompt: 300 };
  const program = p.guest.spew('64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.1 ms\r\n', 20);
  let late;
  try {
    const ok = await Promise.race([
      p.SERIALFS.checkpoint(),
      new Promise((_, rej) => { late = setTimeout(
        () => rej(new Error('checkpoint() was still waiting for a prompt after 5 s')), 5000); }),
    ]);
    assert.equal(ok, false);
    assert.equal(findOverlay(p, 'bwOvTitle').textContent,
                 'Click the terminal, wait for the $ prompt, then try again');
    assert.deepEqual(p.guest.monitor, []);
    assert.equal(p.guest.focus, 'serial');
    assert.equal(p.SERIALFS.isBusy(), false);
  } finally { clearInterval(program.timer); clearTimeout(late); }
});

// Download my work and Load work ask for the prompt through the same
// ensureShell(), so the same printing program must not hold them up either.
// Only the prompt cap is short, so nothing else can end the wait in time.
// Resolves with what `click` resolved with.
async function transferWhilePrinting(p, what, click) {
  p.win.__bwTimeouts = { idle: 300, work: 300, hard: 60000, hardWork: 60000, prompt: 300 };
  const program = p.guest.spew('64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.1 ms\r\n', 20);
  let late;
  try {
    const r = await Promise.race([
      click(),
      new Promise((_, rej) => { late = setTimeout(
        () => rej(new Error(what + ' was still waiting for a prompt after 5 s')), 5000); }),
    ]);
    assert.equal(findOverlay(p, 'bwOvTitle').textContent,
                 'Click the terminal, wait for the $ prompt, then try again');
    assert.equal(findOverlay(p, 'bwOvSub').textContent, 'You can keep working; nothing was changed.');
    assert.equal(findOverlay(p, 'bwOvBar').style.background, '#e0663c');
    assert.equal(program.got, '\x15\n',
                 'typed more than Ctrl-U and Enter into the printing program: ' + JSON.stringify(program.got));
    assert.deepEqual(p.guest.commands, []);
    assert.equal(p.guest.restored, null);
    assert.equal(p.SERIALFS.isBusy(), false);
    return r;
  } finally { clearInterval(program.timer); clearTimeout(late); }
}

test('#65 Download my work while a program keeps printing gives up in seconds, typing nothing more', async () => {
  const p = sfs({ archive: archive(3000), writeDelayMs: 2 });
  await transferWhilePrinting(p, 'download()', () => p.SERIALFS.download());
  assert.equal(p.storage.files.size, 0, 'a browser copy was written');
});

test('#65 Load work while a program keeps printing gives up in seconds, typing nothing more', async () => {
  // the browser copy, then a chosen file (Load from a file…)
  const p = sfs({ writeDelayMs: 2 });
  p.storage.files.set('bashtion-work.tgz', archive(2000, 43));
  assert.equal(await transferWhilePrinting(p, 'load()', () => p.SERIALFS.load()), false);
  const chosen = archive(1800, 4);
  const file = { async arrayBuffer() { return chosen.buffer.slice(0); } };
  const q = sfs({ writeDelayMs: 2 });
  assert.equal(await transferWhilePrinting(q, 'load(file)', () => q.SERIALFS.load(file)), false);
});

test('#65 a Ctrl-A the user left pending in the mux does not turn the switch around', async () => {
  // Without the Ctrl-A NUL first, the page's Ctrl-A completes the user's
  // pair and goes to the guest with its `c`, the switch never happens, and
  // the switch "back" switches in - leaving the user typing into HMP.
  const p = machine();
  p.win.__bwTimeouts = FAST;
  assert.equal(await p.SERIALFS.checkpoint(), true);
  const program = p.guest.hold();
  p.win.__paste('\x01');          // readline's start-of-line, held by the mux
  assert.equal(p.guest.escape, true);
  assert.equal(await p.SERIALFS.rollback(), true);
  assert.ok(!program.got.includes('c'), 'the switch key went to the guest: ' + JSON.stringify(program.got));
  assert.deepEqual(p.guest.monitor.slice(-3), ['stop', 'loadvm bashtion', 'cont']);
  assert.equal(p.guest.focus, 'serial');
  assert.equal(p.guest.escape, false);
  // and with nothing held, the Ctrl-A NUL reaches neither side
  const before = p.guest.trace.length;
  assert.equal(await p.SERIALFS.checkpoint(), true);
  assert.deepEqual(steps(p, before), ['shell: ', 'mux: monitor', 'monitor: stop',
                                      'monitor: savevm bashtion', 'monitor: cont', 'mux: serial',
                                      'shell: re-sync']);
});

test('#65 the re-sync is done only once its clear has run, not at a stale prompt', async () => {
  // a checkpoint taken between two of bash's prompts: the first line after
  // `cont` is echoed and followed by a prompt, and runs only later
  const p = machine({ betweenPrompts: 600 });
  assert.equal(await p.SERIALFS.checkpoint(), true);
  assert.equal(steps(p).at(-1), 'shell: re-sync', 'reported before the re-sync ran');
  assert.equal(findOverlay(p, 'bwOvTitle').textContent, '✓ Checkpoint saved');
  assert.match(p.guest.payloadSeen(), /\x1b\[H\x1b\[2Juser@bashtion:~\$ $/);
});

test('#65 going back puts back the terminal modes a program left behind', async () => {
  const p = machine();
  assert.equal(await p.SERIALFS.checkpoint(), true);
  p.term.events.length = 0;
  assert.equal(await p.SERIALFS.rollback(), true);
  const ev = p.term.events;
  const loaded = ev.findIndex(([k, d]) => k === 'paste' && d === 'loadvm bashtion\n');
  const reset = ev.findIndex(([k, d]) => k === 'write' && d.includes('\x1b[?25h'));
  const resync = ev.findIndex(([k, d]) => k === 'paste' && /^sudo date/.test(d));
  assert.ok(loaded >= 0 && reset > loaded && reset < resync,
            'cursor, colours and input modes not put back between loadvm and the re-sync');
  for (const m of ['\x1b[?25h', '\x1b[0m', '\x1b[?1l', '\x1b>', '\x1b[?1000l', '\x1b[?1002l',
                   '\x1b[?1003l', '\x1b[?1006l', '\x1b[?1004l']) {
    assert.ok(ev[reset][1].includes(m), JSON.stringify(m) + ' missing');
  }
});

test('#65 the re-sync line carries the time and the grid, and goes to the shell', async () => {
  const p = machine();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await p.SERIALFS.checkpoint(), true);
  assert.equal(await p.SERIALFS.rollback(), true);
  const resyncs = p.guest.commands.filter((c) => /^sudo date/.test(c));
  assert.equal(resyncs.length, 2);
  for (const line of resyncs) {
    const m = line.match(RESYNC);
    assert.ok(m, 'not the re-sync line: ' + line);
    assert.ok(Math.abs(Number(m[1]) - now) <= 5, 'the clock was set to ' + m[1] + ', not ' + now);
  }
  assert.ok(!p.guest.monitor.some((c) => /sudo|stty|clear/.test(c)), 'the re-sync reached the monitor');
  // the resize sync is told what the guest now believes
  assert.deepEqual(p.seeded, [{ cols: 100, rows: 30 }, { cols: 100, rows: 30 }]);
  assert.equal(p.status[0], 'checkpoint saved at ' + hhmm(p.SERIALFS.checkpointTime()));
});

test('#65 with no grid to tell the guest, the re-sync is the clock and clear', async () => {
  for (const without of [{ termfit: false }, { xterm: false }]) {
    const p = machine({}, without);
    assert.equal(await p.SERIALFS.checkpoint(), true);
    assert.match(p.guest.commands.at(-1),
                 /^sudo date -u -s @\d+ >\/dev\/null 2>&1; sudo hwclock --systohc >\/dev\/null 2>&1; clear$/);
    assert.deepEqual(p.seeded, []);
  }
});

test('#65 a re-sync that never finishes ends in a warning, not a ✓', async () => {
  // The monitor part worked, so the checkpoint is saved, or the machine is
  // back at it, but the clock and the tty size were never put right: a sudo
  // asking for a password holds the line before its `clear`, and with no
  // prompt after loadvm the line is not typed at all.
  // [what, guest options from the start, set after a first checkpoint, steps]
  const cases = [
    ['save', { sudoAsks: true }, null,
     ['shell: ', 'mux: monitor', 'monitor: stop', 'monitor: ' + LAYER, 'monitor: savevm bashtion',
      'monitor: cont', 'mux: serial', 'shell: re-sync']],
    ['back, the re-sync hangs', {}, (p) => { p.guest.opts.sudoAsks = true; },
     ['mux: monitor', 'monitor: stop', 'monitor: loadvm bashtion', 'monitor: cont', 'mux: serial',
      'shell: ', 'shell: re-sync']],
    ['back, no prompt', {}, (p) => { p.guest.prompt = () => {}; },
     ['mux: monitor', 'monitor: stop', 'monitor: loadvm bashtion', 'monitor: cont', 'mux: serial',
      'shell: ']],
  ];
  for (const [what, opts, stop, want] of cases) {
    const p = machine(opts);
    p.win.__bwTimeouts = FAST;
    let at = null;
    if (stop) {
      assert.equal(await p.SERIALFS.checkpoint(), true, what);
      assert.equal(findOverlay(p, 'bwOvTitle').textContent, '✓ Checkpoint saved', what);
      at = p.SERIALFS.checkpointTime();
      stop(p);
    }
    const from = p.guest.trace.length;
    assert.equal(await (stop ? p.SERIALFS.rollback() : p.SERIALFS.checkpoint()), true, what);
    assert.deepEqual(steps(p, from), want, what);
    const when = p.SERIALFS.checkpointTime();
    assert.ok(when, what);
    if (at) assert.equal(when.getTime(), at.getTime(), what);
    assert.equal(findOverlay(p, 'bwOvTitle').textContent, stop
      ? 'Back at your checkpoint, but the clock could not be set'
      : 'Checkpoint saved, but the clock could not be set', what);
    assert.equal(findOverlay(p, 'bwOvSub').textContent, UNSYNCED, what);
    assert.equal(findOverlay(p, 'bwOvBar').style.background, '#e0a93c', what);
    assert.equal(p.status.at(-1), (stop ? 'back at your checkpoint from ' : 'checkpoint saved at ') +
                 hhmm(when) + ' — clock not set', what);
    assert.equal(p.guest.running, true, what);
    assert.equal(p.guest.focus, 'serial', what);
    assert.equal(p.term.focused, true, what);
    assert.equal(p.SERIALFS.isBusy(), false, what);
  }
});

test('#65 a failed checkpoint stays a failure, even after a re-sync that never finishes', async () => {
  const p = machine({ sudoAsks: true, savevmFails: VIRTFS });
  p.win.__bwTimeouts = FAST;
  assert.equal(await p.SERIALFS.checkpoint(), false);
  assert.equal(steps(p).at(-1), 'shell: re-sync');
  assert.equal(findOverlay(p, 'bwOvTitle').textContent, 'Could not save a checkpoint');
  assert.equal(findOverlay(p, 'bwOvSub').textContent, VIRTFS + '.');
  assert.equal(findOverlay(p, 'bwOvBar').style.background, '#e0663c');
  assert.equal(p.SERIALFS.checkpointTime(), null);
  assert.deepEqual(p.status, []);
});

test('#65 bracketed paste is turned off before the switch, so the mux sees Ctrl-A c', async () => {
  const p = machine();
  p.win.__bwTimeouts = FAST;
  assert.equal(await p.SERIALFS.checkpoint(), true);
  p.guest.hold();
  p.term.modes.bracketedPasteMode = true;     // what `printf '\e[?2004h'` leaves behind
  p.term.events.length = 0;
  assert.equal(await p.SERIALFS.rollback(), true);
  const reset = p.term.events.findIndex(([k, d]) => k === 'write' && d === '\x1b[?2004l');
  const ctrlA = p.term.events.findIndex(([k, d]) => k === 'paste' && d === '\x01');
  assert.ok(reset >= 0, 'bracketed paste was never turned off');
  assert.ok(reset < ctrlA, 'Ctrl-A went out while pastes were still bracketed');
  assert.ok(p.guest.monitor.includes('loadvm bashtion'));
  assert.equal(p.guest.focus, 'serial');
});

test('#65 the fake mux really does lose a bracketed Ctrl-A c', () => {
  const p = machine();
  p.term.modes.bracketedPasteMode = true;
  p.win.__paste('\x01'); p.win.__paste('c');
  assert.equal(p.guest.focus, 'serial', 'the probe cannot tell whether the reset matters');
  p.term.modes.bracketedPasteMode = false;
  p.win.__paste('\x01'); p.win.__paste('c');
  assert.equal(p.guest.focus, 'monitor');
});

test('#65 the mux is left on the serial side and the terminal focused, however it ends', async () => {
  // [operation, guest options, whether the machine is running at the end]
  const cases = [
    ['save', {}, true],
    ['save', { layerFails: 'Could not open backing file' }, true],
    ['save', { savevmFails: VIRTFS }, true],
    // the switch never answered: no `stop`, so no `cont`
    ['save', { monitorHangs: true }, true],
    // `stop` never answered, whether it hung before running or ran and its
    // prompt was lost: one short `cont` follows either way
    ['save', { monitorHangs: 'stop' }, true],
    ['save', { stopPromptLost: true }, true],
    // took `stop`, then hung: cont is still sent, but nothing answers it
    ['save', { monitorHangs: 'savevm bashtion' }, false],
    ['back', {}, true],
    ['back', { loadvmFails: "Snapshot 'bashtion' does not exist in one or more devices" }, false],
    ['back', { monitorHangs: 'stop' }, true],
    ['back', { stopPromptLost: true }, true],
    ['back', { monitorHangs: 'loadvm bashtion' }, false],
  ];
  for (const [op, opts, running] of cases) {
    const what = op + ' ' + JSON.stringify(opts);
    const p = machine(op === 'save' ? opts : {});
    p.win.__bwTimeouts = FAST;
    const blurred = [];
    const hmp = p.guest.hmp.bind(p.guest);
    p.guest.hmp = (line) => { blurred.push(!p.term.focused); hmp(line); };
    if (op === 'back') {
      assert.equal(await p.SERIALFS.checkpoint(), true, what);
      Object.assign(p.guest.opts, opts);
      await p.SERIALFS.rollback();
    } else {
      await p.SERIALFS.checkpoint();
    }
    assert.equal(p.guest.focus, 'serial', what);
    assert.equal(p.guest.trace.filter(([k]) => k === 'mux').length % 2, 0, what);
    assert.equal(p.term.focused, true, what);
    assert.ok(blurred.every(Boolean), 'the keyboard was on the terminal in the monitor: ' + what);
    assert.equal(p.SERIALFS.isBusy(), false, what);
    assert.equal(p.guest.running, running, what);
    if (opts.monitorHangs === 'savevm bashtion') assert.equal(p.guest.monitor.at(-1), 'cont', what);
    if (opts.monitorHangs === 'stop' || opts.stopPromptLost) {
      assert.deepEqual(p.guest.monitor.slice(-2), ['stop', 'cont'], what);
    }
    if (opts.monitorHangs === true) assert.deepEqual(p.guest.monitor, [], what);
  }
});

test('#65 a stop that never answers is followed by one short cont, so the machine runs on', async () => {
  // QEMU runs `stop` as soon as it reads the line, so a prompt that is lost,
  // or lands after the page has given up, leaves the machine stopped unless
  // the page sends `cont` anyway.
  for (const op of ['save', 'back']) {
    for (const lost of [true, 1000]) {
      const what = op + ' ' + JSON.stringify({ stopPromptLost: lost });
      const p = machine();
      p.win.__bwTimeouts = FAST;
      assert.equal(await p.SERIALFS.checkpoint(), true, what);
      const at = p.SERIALFS.checkpointTime();
      p.guest.opts.stopPromptLost = lost;
      const from = p.guest.trace.length;
      const out = p.guest.out.length;
      assert.equal(await (op === 'save' ? p.SERIALFS.checkpoint() : p.SERIALFS.rollback()), false, what);
      // `stop` went before the call returned, so its late prompt has landed by now
      if (lost !== true) await new Promise((r) => setTimeout(r, lost));
      // the switch's prompt and cont's, and the late one of stop
      assert.equal(p.guest.out.slice(out).filter((s) => s === '(qemu) ').length,
                   lost === true ? 2 : 3, what);
      assert.deepEqual(steps(p, from), op === 'save'
        ? ['shell: ', 'mux: monitor', 'monitor: stop', 'monitor: cont', 'mux: serial', 'shell: re-sync']
        : ['mux: monitor', 'monitor: stop', 'monitor: cont', 'mux: serial'], what);
      assert.equal(p.guest.running, true, what);
      assert.equal(findOverlay(p, 'bwOvTitle').textContent, op === 'save'
        ? 'Could not save a checkpoint' : 'Could not go back to your checkpoint', what);
      assert.equal(findOverlay(p, 'bwOvSub').textContent, 'The machine did not answer.', what);
      assert.equal(p.guest.focus, 'serial', what);
      assert.equal(p.term.focused, true, what);
      assert.equal(p.SERIALFS.isBusy(), false, what);
      assert.equal(p.SERIALFS.checkpointTime().getTime(), at.getTime(), what);
    }
  }
});

test('#65 the cont after a stop that never answers is sent once and waits only briefly, even while the guest prints', async () => {
  // A `stop` that never ran leaves the guest running, and what it prints
  // would keep an idle timer alive for the 15-minute cap: only the short cap
  // ends the wait. Here the monitor hangs before `stop`, so `cont` goes
  // unanswered too, and the chatter starts as it is sent. `stale`: an earlier
  // Save's `cont` ran but its prompt was lost, so the page still thinks the
  // machine is stopped from then, and must not give this `cont` the long wait.
  for (const op of ['save', 'back']) {
    for (const stale of [false, true]) {
      const what = op + (stale ? ' (after a cont that never answered)' : '');
      const p = machine();
      const hmp = p.guest.hmp.bind(p.guest);
      if (stale) {
        p.win.__bwTimeouts = FAST;
        const write = p.guest.write.bind(p.guest);
        p.guest.hmp = (line) => {
          p.guest.write = (s) => { if (line !== 'cont' || s !== '(qemu) ') write(s); };
          try { hmp(line); } finally { p.guest.write = write; }
        };
        // it fails, but savevm answered: there is a checkpoint to go back to
        assert.equal(await p.SERIALFS.checkpoint(), false, what);
        assert.equal(p.guest.running, true, what);
      } else if (op === 'back') assert.equal(await p.SERIALFS.checkpoint(), true, what);
      p.guest.opts.monitorHangs = 'stop';
      p.win.__bwTimeouts = { ...FAST, hard: 60000, hardWork: 60000 };
      let chatter = null;
      p.guest.hmp = (line) => { if (line === 'cont' && !chatter) chatter = p.guest.startChatter(); hmp(line); };
      const from = p.guest.monitor.length;
      let late;
      try {
        const ok = await Promise.race([
          op === 'save' ? p.SERIALFS.checkpoint() : p.SERIALFS.rollback(),
          new Promise((_, rej) => { late = setTimeout(
            () => rej(new Error(what + ' was still waiting for cont after 5 s')), 5000); }),
        ]);
        assert.equal(ok, false, what);
        assert.deepEqual(p.guest.monitor.slice(from), ['stop', 'cont'], what);
      } finally { if (chatter) chatter(); clearTimeout(late); }
    }
  }
});

test('#65 a thrown error still hands the console back', async () => {
  const p = machine();
  const paste = p.win.__paste;
  let armed = 'savevm bashtion\n';
  p.win.__paste = (s) => {
    if (s === armed) { armed = null; throw new Error('boom'); }
    return paste(s);
  };
  await assert.rejects(p.SERIALFS.checkpoint(), /boom/);
  assert.deepEqual(p.guest.monitor, ['stop', LAYER, 'cont'], 'the stopped machine was not resumed');
  assert.equal(p.guest.running, true);
  assert.equal(p.guest.focus, 'serial');
  assert.equal(p.term.focused, true);
  assert.equal(p.SERIALFS.isBusy(), false);

  // going back, after loadvm answered cleanly: resumed
  assert.equal(await p.SERIALFS.checkpoint(), true);
  armed = 'cont\n';
  await assert.rejects(p.SERIALFS.rollback(), /boom/);
  assert.deepEqual(p.guest.monitor.slice(-3), ['stop', 'loadvm bashtion', 'cont']);
  assert.equal(p.guest.running, true, 'a loaded machine was left stopped');
  assert.equal(p.guest.focus, 'serial');
  assert.equal(p.SERIALFS.isBusy(), false);

  // going back, while loadvm was being sent: the page cannot tell whether it
  // got there, so the machine stays stopped, as after a failed one
  armed = 'loadvm bashtion\n';
  await assert.rejects(p.SERIALFS.rollback(), /boom/);
  assert.equal(p.guest.monitor.at(-1), 'stop');
  assert.equal(p.guest.running, false);
  assert.equal(p.guest.focus, 'serial');
  assert.equal(p.term.focused, true);
  assert.equal(p.SERIALFS.isBusy(), false);
});

test('#65 the monitor is only ever given the six constant commands', async () => {
  const seen = new Set();
  for (const opts of [{}, { savevmFails: VIRTFS }, { savevmFails: VIRTFS, savevmDropsOld: true },
                      { layerFails: 'x' }, { loadvmFails: 'y' }, { monitorHangs: 'savevm bashtion' }]) {
    const p = machine(opts);
    p.win.__bwTimeouts = FAST;
    await p.SERIALFS.checkpoint();
    p.guest.opts.savevmFails = null;
    await p.SERIALFS.checkpoint();
    await p.SERIALFS.rollback();
    for (const c of p.guest.monitor) seen.add(c);
  }
  for (const c of seen) assert.ok(MONITOR_COMMANDS.has(c), 'the monitor was sent ' + JSON.stringify(c));
  assert.deepEqual([...seen].sort(), [...MONITOR_COMMANDS].sort());
});

test('#65 saving needs a prompt, and without one nothing reaches the monitor', async () => {
  const p = machine();
  p.win.__bwTimeouts = FAST;
  p.guest.prompt = () => {};
  assert.equal(await p.SERIALFS.checkpoint(), false);
  assert.deepEqual(p.guest.monitor, []);
  assert.equal(p.guest.focus, 'serial');
  assert.equal(findOverlay(p, 'bwOvTitle').textContent,
               'Click the terminal, wait for the $ prompt, then try again');
  assert.equal(p.SERIALFS.checkpointTime(), null);
});

test('#65 the overlay covers the monitor the whole time, and says what is happening', async () => {
  const p = machine();
  const seen = [];
  const hmp = p.guest.hmp.bind(p.guest);
  p.guest.hmp = (line) => {
    seen.push([line, overlay(p).style.display, findOverlay(p, 'bwOvTitle').textContent,
               findOverlay(p, 'bwOvSub').textContent]);
    hmp(line);
  };
  assert.equal(await p.SERIALFS.checkpoint(), true);
  assert.equal(findOverlay(p, 'bwOvTitle').textContent, '✓ Checkpoint saved');
  const at = hhmm(p.SERIALFS.checkpointTime());
  assert.equal(await p.SERIALFS.rollback(), true);
  for (const [line, display, title, sub] of seen) {
    assert.equal(display, 'flex', line + ' ran with the terminal showing');
    if (line === 'savevm bashtion') {
      assert.equal(title, 'Saving a checkpoint…');
      assert.equal(sub, 'The whole machine, kept in this tab until you close or reload it.');
    }
    if (line === 'loadvm bashtion') {
      assert.equal(title, 'Going back to your checkpoint…');
      assert.equal(sub, 'Undoing everything since ' + at + '.');
    }
  }
  assert.equal(seen.length, 7);
});

test('#65 a checkpoint and a save or load never share the console', async () => {
  // a checkpoint or going back asked for while a save or a load runs
  {
    const p = machine({ archive: archive(3000) });
    const saving = p.SERIALFS.save();
    assert.equal(await p.SERIALFS.checkpoint(), false);
    await saving;
    assert.ok(p.storage.files.has('bashtion-work.tgz'), 'the save was disturbed');
    assert.deepEqual(p.guest.monitor, []);
    assert.equal(p.SERIALFS.checkpointTime(), null);
  }
  {
    const p = machine();
    assert.equal(await p.SERIALFS.checkpoint(), true);
    const from = p.guest.monitor.length;
    p.storage.files.set('bashtion-work.tgz', archive(6000, 41));
    const loading = p.SERIALFS.load();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await p.SERIALFS.rollback(), false);
    assert.equal(await p.SERIALFS.checkpoint(), false);
    assert.equal(await loading, true);
    assert.deepEqual(p.guest.monitor.slice(from), []);
  }
  // a save or a load asked for while a checkpoint or going back runs
  for (const op of ['checkpoint', 'rollback']) {
    const p = machine({ archive: archive(3000) });
    if (op === 'rollback') assert.equal(await p.SERIALFS.checkpoint(), true);
    const running = p.SERIALFS[op]();
    await p.SERIALFS.save();
    assert.equal(p.storage.files.has('bashtion-work.tgz'), false, 'a save ran during ' + op);
    p.storage.files.set('bashtion-work.tgz', archive(2000, 43));
    assert.equal(await p.SERIALFS.load(), false);
    assert.equal(await running, true);
    assert.ok(!p.guest.commands.some((c) => /bashtion-(un)?pack/.test(c)),
              'a transfer reached the shell during ' + op);
    assert.notEqual(findOverlay(p, 'bwOvBar').style.background, '#e0663c',
                    'the refused request repainted the overlay');
  }
});

test('#65 isBusy() holds for the whole of either operation', async () => {
  const p = machine();
  const during = [];
  const hmp = p.guest.hmp.bind(p.guest);
  p.guest.hmp = (line) => { during.push(p.SERIALFS.isBusy()); hmp(line); };
  const saving = p.SERIALFS.checkpoint();
  assert.equal(p.SERIALFS.isBusy(), true);
  assert.equal(await saving, true);
  assert.equal(p.SERIALFS.isBusy(), false);
  const going = p.SERIALFS.rollback();
  assert.equal(p.SERIALFS.isBusy(), true);
  assert.equal(await going, true);
  assert.equal(p.SERIALFS.isBusy(), false);
  assert.equal(during.length, 7);
  assert.ok(during.every(Boolean), 'not busy while in the monitor');
});

function overlay(page) {
  return page.globals.document.body.children.find((el) => el.id === 'bwOverlay') || null;
}

function findOverlay(page, id) {
  const el = overlay(page);
  return el ? el.querySelector('#' + id) : null;
}
