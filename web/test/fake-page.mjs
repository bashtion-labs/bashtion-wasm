// A browser-shaped scope just large enough to run the page's classic scripts,
// plus a guest that speaks the save/load protocol back over a fake console.
//
// The guest is a mock, not an emulator: it recognises the exact command lines
// serialfs sends and answers the way a real shell would. What it does model
// faithfully is the two things the protocol has to survive - readline echoing
// every command line back before running it, and a command reading the tty
// directly with echo off - because those are what the bugs were about.
//
// In front of it sits QEMU's -nographic mux and, on its other side, the HMP
// monitor that checkpoints use (#65), answering the way the engine was
// measured to: a redrawn echo, `Error: <reason>` on failure, and a fresh
// `(qemu) ` at the end of every reply.

// ---------------------------------------------------------------- fake DOM
function element(tag) {
  const el = {
    tagName: tag, id: '', textContent: '', innerHTML: '', href: '', download: '',
    children: [],
    style: new Proxy({ cssText: '' }, { set: (t, k, v) => (t[k] = v, true) }),
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 contains(c) { return this._s.has(c); } },
    appendChild(c) { el.children.push(c); return c; },
    querySelector(sel) {
      const id = sel.replace(/^#/, '');
      if (!el._byId) {
        el._byId = {};
        for (const m of String(el.innerHTML).matchAll(/id="([^"]+)"/g)) {
          el._byId[m[1]] = element('div');
        }
      }
      return el._byId[id] || null;
    },
    click() { el._clicked = true; },
  };
  return el;
}

export function makeDocument() {
  const body = element('body');
  const head = element('head');
  return { body, head, createElement: element };
}

// --------------------------------------------------------------- fake OPFS
export function makeStorage() {
  const files = new Map();
  return {
    files,
    api: {
      async getDirectory() {
        return {
          async getFileHandle(name, opts) {
            if (!files.has(name) && !(opts && opts.create)) throw new Error('NotFound');
            return {
              async createWritable() {
                return {
                  async write(bin) { files.set(name, new Uint8Array(bin)); },
                  async close() {},
                };
              },
              async getFile() {
                const b = files.get(name);
                return { async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
              },
            };
          },
        };
      },
    },
  };
}

// -------------------------------------------------------------- fake guest
const PROMPT = 'user@bashtion:~$ ';

export class FakeGuest {
  constructor(opts = {}) {
    this.opts = opts;
    this.out = [];              // everything the page would see on the console
    this.b64 = '';              // /tmp/bw-load.b64
    this.tgz = null;            // /tmp/bw-load.tgz
    this.restored = null;       // what bashtion-unpack was handed
    this.echo = true;           // tty ECHO; readline echoes regardless
    this.pending = '';
    this.reader = null;         // set while a command is reading the tty
    this.commands = [];
    this.blocks = 0;
    this.sink = null;
    // the mux and the monitor (#65)
    this.focus = 'serial';      // which side of the mux has the keyboard
    this.escape = false;        // Ctrl-A seen, waiting for the key after it
    this.monitor = [];          // command lines the monitor was given
    this.monPending = '';
    this.trace = [];            // shell lines, monitor lines and switches, in order
    this.running = true;        // the VM: `stop` pauses it, `cont` resumes it
    this.layered = false;       // snapshot_blkdev has put a qcow2 over root
    this.slot = null;           // the `bashtion` snapshot
    this.hung = false;
    this.machine = {};          // guest state a test can change, and loadvm puts back
  }

  attach(win) {
    this.sink = () => { win.__serial = this.out.join(''); };
    // xterm.paste() normalises every newline to CR before it reaches the tty.
    win.__paste = (s) => this.feed(String(s).replace(/\r?\n/g, '\r'));
    win.__serial = '';
    return win;
  }

  write(s) { this.out.push(s); if (this.sink) this.sink(); }

  // Simulate `dmesg -w &` or a cron job: unrelated output that keeps the
  // console mirror growing while the transfer itself is wedged.
  startChatter(everyMs = 40) {
    this.chatter = setInterval(() => this.write('[  12.345678] chatter\r\n'), everyMs);
    return () => clearInterval(this.chatter);
  }

  // The mux sees every byte first. Ctrl-A c moves the keyboard to the other
  // side; Ctrl-A Ctrl-A sends one Ctrl-A on; Ctrl-A followed by anything else
  // is swallowed, along with that key. So a Ctrl-A inside a bracketed paste
  // (ESC[200~ ^A ESC[201~) loses the ESC after it, and the `c` that follows
  // goes to the guest as text: the switch never happens.
  feed(text) {
    let run = '';
    const flush = () => {
      if (!run) return;
      if (this.focus === 'monitor') this.monitorFeed(run); else this.serialFeed(run);
      run = '';
    };
    for (const ch of text) {
      if (this.escape) {
        this.escape = false;
        if (ch === 'c') { flush(); this.swap(); } else if (ch === '\x01') run += ch;
        continue;
      }
      if (ch === '\x01') { this.escape = true; continue; }
      run += ch;
    }
    flush();
  }

  swap() {
    this.focus = this.focus === 'serial' ? 'monitor' : 'serial';
    this.trace.push(['mux', this.focus]);
    // the monitor reprints its prompt when it gets the keyboard
    if (this.focus === 'monitor' && this.answers()) this.write('(qemu) ');
  }

  answers() { return !this.hung && this.opts.monitorHangs !== true; }

  monitorFeed(text) {
    this.monPending += text;
    for (let i; (i = this.monPending.indexOf('\r')) >= 0;) {
      const line = this.monPending.slice(0, i);
      this.monPending = this.monPending.slice(i + 1);
      this.hmp(line);
    }
  }

  // The replies measured in the browser engine (QEMU 8.2.0) and in native
  // QEMU 8.2.2 with the same machine. `monitorHangs` is a monitor that stops
  // answering at that command (or, given true, never answers at all).
  hmp(line) {
    this.monitor.push(line);
    this.trace.push(['monitor', line]);
    if (this.opts.monitorHangs === line) this.hung = true;
    if (!this.answers()) return;
    // HMP redraws the whole line on every keystroke
    for (let i = 1; i <= line.length; i++) {
      this.write(line.slice(0, i) + '\x1b[K' + (i < line.length ? '\x1b[D'.repeat(i) : ''));
    }
    this.write('\r\r\n');
    const say = (s) => this.write(s + '\r\r\n');
    const fail = (s) => say('Error: ' + s);
    switch (line) {
      case 'stop': this.running = false; break;
      case 'cont': this.running = true; break;
      case 'snapshot_blkdev root /tmp/bashtion-root.qcow2 qcow2':
        if (this.opts.layerFails) { fail(this.opts.layerFails); break; }
        this.layered = true;
        // a single CR before this LF, unlike every other line (measured)
        this.write("Formatting '/tmp/bashtion-root.qcow2', fmt=qcow2 cluster_size=65536 " +
                   'extended_l2=off compression_type=zlib size=1088421888 ' +
                   'backing_file=/pack-rootfs/rootfs.ext4 backing_fmt=raw lazy_refcounts=off ' +
                   'refcount_bits=16\r\n');
        break;
      case 'savevm bashtion':
        if (!this.layered) { fail("Device 'root' is writable but does not support snapshots"); break; }
        if (this.opts.savevmFails) {
          // savevm deletes the old snapshot of the tag before writing the new
          // one; whether a failure got that far depends on what failed
          if (this.opts.savevmDropsOld) this.slot = null;
          fail(this.opts.savevmFails);
          break;
        }
        this.slot = { machine: structuredClone(this.machine), reader: this.reader,
                      pending: this.pending, echo: this.echo };
        break;
      case 'loadvm bashtion':
        if (!this.slot) { fail("Snapshot 'bashtion' does not exist in one or more devices"); break; }
        if (this.opts.loadvmFails) { fail(this.opts.loadvmFails); break; }
        this.machine = structuredClone(this.slot.machine);
        this.reader = this.slot.reader;
        this.pending = this.slot.pending;
        this.echo = this.slot.echo;
        break;
      case 'info snapshots':
        if (!this.slot) { say('There is no snapshot available.'); break; }
        say('List of snapshots present on all disks:');
        say('ID        TAG               VM SIZE                DATE     VM CLOCK     ICOUNT');
        say('--        bashtion          299 MiB 2026-10-18 00:37:48 00:01:33.419           ');
        break;
      default: fail("unknown command: '" + line + "'");
    }
    this.write('(qemu) ');
    // input typed at the serial port while the VM was stopped waits for it
    if (line === 'cont') this.serialFeed('');
  }

  // A foreground program that reads the terminal and never gives it back -
  // `sleep 600` that a key does not end, or a hung command.
  hold() {
    this.reader = { need: Infinity, got: '', done() {} };
    return this.reader;
  }

  serialFeed(text) {
    this.pending += text;
    if (!this.running) return;
    for (;;) {
      // ISIG: Ctrl-C interrupts the foreground job wherever it lands. This is
      // the whole mechanism the failure-recovery path depends on - without it
      // a blocked `head -c N` eats the recovery as payload.
      const intr = this.pending.indexOf('\x03');
      if (intr >= 0) {
        this.pending = this.pending.slice(intr + 1);
        this.interrupts = (this.interrupts || 0) + 1;
        this.reader = null;
        this.write('^C\r\n');
        this.prompt();
        continue;
      }
      if (this.reader) {
        const want = this.reader.need - this.reader.got.length;
        if (!want) { this.finishRead(); continue; }
        const take = this.pending.slice(0, want);
        if (!take) return;
        this.pending = this.pending.slice(take.length);
        // icrnl: the tty turns the CRs xterm produced back into newlines
        this.reader.got += take.replace(/\r/g, '\n');
        // ECHO left on: the tty reflects everything the reader consumes. The
        // protocol's job is to make sure this never happens; the tests need to
        // be able to simulate it, or they cannot prove it does not.
        if (this.opts.echoPayload) this.write(take.replace(/\r/g, '\r\n'));
        if (this.reader.got.length >= this.reader.need) this.finishRead();
        continue;
      }
      const i = this.pending.indexOf('\r');
      if (i < 0) return;
      const line = this.pending.slice(0, i);
      this.pending = this.pending.slice(i + 1);
      this.exec(line);
    }
  }

  finishRead() {
    const r = this.reader;
    this.reader = null;
    r.done(r.got);
  }

  exec(line) {
    if (line.includes('\x15')) line = line.slice(line.lastIndexOf('\x15') + 1);
    this.commands.push(line);
    this.trace.push(['shell', line]);
    // readline redisplays every command line typed at the prompt, whatever
    // the tty ECHO flag says. This is the echo markers must not match.
    this.write(line + '\r\n');

    if (/^\s*$/.test(line)) return this.prompt();
    if (/(^|; )clear$/.test(line)) { this.write('\x1b[H\x1b[2J'); return this.prompt(); }

    // save
    if (line.includes('bashtion-pack')) {
      this.write('\r\nBWT-PACK\r\n');
      if (this.opts.packFails) {
        this.write('\r\nBWT-ERR ' + this.opts.packFails + '\r\n');
        return this.prompt();
      }
      const a = this.opts.archive || new Uint8Array(0);
      const b64 = Buffer.from(a).toString('base64');
      this.write('\r\nBWT-BEGIN ' + a.length + ' ' + posixCksum(a) + '\r\n');
      this.write((this.opts.mangleSave ? this.opts.mangleSave(b64) : b64));
      this.write('\r\nBWT-END\r\n');
      return this.prompt();
    }

    // restore: prepare
    if (line.includes('rm -f /tmp/bw-load.b64') && line.includes('R-READY')) {
      this.b64 = ''; this.tgz = null;
      this.write('\r\nBWR-READY\r\n');
      return this.prompt();
    }

    // restore: one block
    const head = line.match(/head -c (\d+) >> \/tmp\/bw-load\.b64/);
    if (head) {
      this.write('\r\nBWR-GO\r\n');
      this.reader = {
        need: Number(head[1]), got: '',
        done: (data) => {
          this.blocks++;
          this.b64 += this.opts.mangleBlock ? this.opts.mangleBlock(data, this.blocks) : data;
          // A guest that never acknowledges: the reader stays blocked, exactly
          // as it would if the block came up short.
          if (this.opts.stallAtBlock === this.blocks) { this.stalled = true; return; }
          this.write('\r\nBWR-BLK\r\n');
          this.prompt();
        },
      };
      return;
    }

    // restore: decode + checksum
    if (line.includes('base64 -d < /tmp/bw-load.b64')) {
      try {
        this.tgz = new Uint8Array(Buffer.from(this.b64.replace(/\s+/g, ''), 'base64'));
      } catch (e) { this.tgz = new Uint8Array(0); }
      this.write('\r\nBWR-SUM ' + this.tgz.length + ' ' + posixCksum(this.tgz) + '\r\n');
      return this.prompt();
    }

    // restore: apply
    if (line.includes('bashtion-unpack')) {
      if (this.opts.unpackFails) {
        this.write('\r\nBWR-FAIL ' + this.opts.unpackFails + '\r\n');
        return this.prompt();
      }
      this.restored = this.tgz;
      // What bashtion-unpack printed last. The page only hears it if the
      // success branch it typed forwards it, exactly as a shell would: a bare
      // `printf 'BWR-OK'` says nothing about how much was restored.
      const then = (line.match(/; then (.*?); else /) || [])[1] || '';
      const says = /R-OK %s/.test(then) && /tail -1 \/tmp\/bw-load\.err/.test(then)
        ? ' ' + (this.opts.unpackSays || 'bashtion-unpack: restored; 0 deletions applied')
        : '';
      const verdict = '\r\nBWR-OK' + says + '\r\n';
      // A uart delivers a line in pieces; the page must not act on half of it.
      if (this.opts.verdictInPieces) {
        const cut = verdict.indexOf(' only') > 0 ? verdict.indexOf(' only') : verdict.length - 2;
        this.write(verdict.slice(0, cut));
        setTimeout(() => { this.write(verdict.slice(cut)); this.prompt(); },
                   this.opts.verdictInPieces);
        return;
      }
      this.write(verdict);
      return this.prompt();
    }

    return this.prompt();
  }

  prompt() { this.write(PROMPT); }

  // everything written to the console that was not a command echo or a prompt
  payloadSeen() { return this.out.join(''); }
}

// POSIX cksum, for the mock to answer with. Verified against coreutils.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function posixCksum(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ TABLE[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  for (let n = bytes.length; n; n >>>= 8) c = ((c << 8) ^ TABLE[((c >>> 24) ^ (n & 0xff)) & 0xff]) >>> 0;
  return (~c) >>> 0;
}

// --------------------------------------------------------------- fake xterm
// Just what the checkpoint code touches (#65): paste() as xterm.js does it -
// newlines to CR, and the bracket wrap while the program in front has asked
// for one - write() with its parser's handling of DECSET/DECRST 2004 and the
// callback it fires once the data is processed, the grid, and focus. Routes
// window.__paste through itself, as boot.js does.
export function makeXterm(win, guest, { cols = 100, rows = 30 } = {}) {
  const term = {
    cols, rows,
    modes: { bracketedPasteMode: false },
    focused: true,
    events: [],                 // writes, pastes and focus changes, in order
    paste(s) {
      term.events.push(['paste', s]);
      const t = String(s).replace(/\r?\n/g, '\r');
      guest.feed(term.modes.bracketedPasteMode ? '\x1b[200~' + t + '\x1b[201~' : t);
    },
    write(data, cb) {
      term.events.push(['write', data]);
      setTimeout(() => {
        if (data.includes('\x1b[?2004l')) term.modes.bracketedPasteMode = false;
        if (data.includes('\x1b[?2004h')) term.modes.bracketedPasteMode = true;
        if (cb) cb();
      }, 5);
    },
    blur() { term.focused = false; term.events.push(['blur']); },
    focus() { term.focused = true; term.events.push(['focus']); },
  };
  win.__xterm = term;
  win.__paste = (s) => term.paste(s);
  return term;
}

// --------------------------------------------------------------- the whole
export function makePage(guestOpts = {}) {
  const guest = new FakeGuest(guestOpts);
  const storage = makeStorage();
  const win = {};
  guest.attach(win);
  const globals = {
    window: win,
    document: makeDocument(),
    navigator: { storage: storage.api },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Uint8Array,
    Uint32Array, Math, JSON, Number, String, TextDecoder, TextEncoder,
  };
  return { guest, storage, win, globals };
}
