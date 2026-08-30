// Export/import of the persistent directory as a plain ustar archive.
// No libraries: managed devices can wipe OPFS, so a file the user can park in
// their own storage is the durable path. Import unpacks back into FS /share
// (persist.js then mirrors it to OPFS on the next save).
'use strict';

const BACKUP = (() => {
  const ROOT = '/share';
  const enc = new TextEncoder();

  function tarHeader(name, size, isDir) {
    const b = new Uint8Array(512);
    const put = (s, off, len) => b.set(enc.encode(s).slice(0, len), off);
    put(name + (isDir ? '/' : ''), 0, 100);
    put('0000644\0', 100, 8);
    put('0000000\0', 108, 8);
    put('0000000\0', 116, 8);
    put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
    put(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
    put('        ', 148, 8);                    // checksum placeholder = spaces
    put(isDir ? '5' : '0', 156, 1);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    let sum = 0;
    for (const x of b) sum += x;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return b;
  }

  function walk(fs, path, rel, chunks) {
    for (const name of fs.readdir(path)) {
      if (name === '.' || name === '..') continue;
      const p = path + '/' + name, r = rel ? rel + '/' + name : name;
      const st = fs.stat(p);
      if (fs.isDir(st.mode)) {
        chunks.push(tarHeader(r, 0, true));
        walk(fs, p, r, chunks);
      } else if (fs.isFile(st.mode)) {
        const data = fs.readFile(p);
        chunks.push(tarHeader(r, data.length, false), data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) chunks.push(new Uint8Array(pad));
      }
    }
  }

  return {
    export(fs) {
      const chunks = [];
      walk(fs, ROOT, '', chunks);
      chunks.push(new Uint8Array(1024));        // end-of-archive
      const blob = new Blob(chunks, { type: 'application/x-tar' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'bashtion-work-' + new Date().toISOString().slice(0, 10) + '.tar';
      a.click();
      URL.revokeObjectURL(a.href);
    },
    async import(fs, file) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const dec = new TextDecoder();
      let off = 0, count = 0;
      while (off + 512 <= buf.length) {
        const name = dec.decode(buf.slice(off, off + 100)).replace(/\0.*$/, '');
        if (!name) break;
        const size = parseInt(dec.decode(buf.slice(off + 124, off + 136)), 8) || 0;
        const type = String.fromCharCode(buf[off + 156]);
        const p = ROOT + '/' + name.replace(/\/$/, '');
        if (type === '5') {
          try { fs.mkdir(p); } catch (e) {}
        } else {
          const dir = p.slice(0, p.lastIndexOf('/'));
          dir.split('/').reduce((acc, part) => {
            if (!part) return acc;
            acc += '/' + part;
            try { fs.mkdir(acc); } catch (e) {}
            return acc;
          }, '');
          fs.writeFile(p, buf.slice(off + 512, off + 512 + size));
          count++;
        }
        off += 512 + Math.ceil(size / 512) * 512;
      }
      return count;
    },
  };
})();
