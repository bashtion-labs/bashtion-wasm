// A browser-shaped scope just large enough to run the page's classic scripts,
// plus a guest that speaks the save/load protocol back over a fake console.
//
// The guest is a mock, not an emulator: it recognises the exact command lines
// serialfs sends and answers the way a real shell would. What it does model
// faithfully is the two things the protocol has to survive - readline echoing
// every command line back before running it, and a command reading the tty
// directly with echo off - because those are what the bugs were about.

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
  }

  attach(win) {
    this.sink = () => { win.__serial = this.out.join(''); };
    // xterm.paste() normalises every newline to CR before it reaches the tty.
    win.__paste = (s) => this.feed(String(s).replace(/\r?\n/g, '\r'));
    win.__serial = '';
    return win;
  }

  write(s) { this.out.push(s); if (this.sink) this.sink(); }

  feed(text) {
    this.pending += text;
    for (;;) {
      if (this.reader) {
        const want = this.reader.need - this.reader.got.length;
        if (!want) { this.finishRead(); continue; }
        const take = this.pending.slice(0, want);
        if (!take) return;
        this.pending = this.pending.slice(take.length);
        // icrnl: the tty turns the CRs xterm produced back into newlines
        this.reader.got += take.replace(/\r/g, '\n');
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
    // readline redisplays every command line typed at the prompt, whatever
    // the tty ECHO flag says. This is the echo markers must not match.
    this.write(line + '\r\n');

    if (/^\s*$/.test(line)) return this.prompt();
    if (/^clear$/.test(line)) { this.write('\x1b[H\x1b[2J'); return this.prompt(); }

    // save
    if (line.includes('bashtion-pack')) {
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
      if (this.opts.unpackFails) this.write('\r\nBWR-FAIL ' + this.opts.unpackFails + '\r\n');
      else { this.restored = this.tgz; this.write('\r\nBWR-OK\r\n'); }
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
