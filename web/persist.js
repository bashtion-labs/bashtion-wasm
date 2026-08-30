// OPFS persistence for the 9p-shared directory (/share in emscripten's FS,
// mounted at /home/user/persist inside the guest).
//
// Restore: before QEMU starts, copy OPFS -> FS. Save: walk FS /share and
// write changed files OPFS-ward, on an interval and on explicit request.
// OPFS is per-browser-profile and can be wiped by managed devices - the
// export/import in backup.js is the real safety net; this is the convenience
// layer that makes ordinary tab reloads lossless.
'use strict';

const PERSIST = (() => {
  const ROOT = '/share';
  let fs = null;           // emscripten FS, set at preRun
  let opfsRoot = null;
  let dirty = false;
  let timer = null;
  const log = (m) => (window.__persistLog || console.log)('[persist] ' + m);

  async function opfs() {
    if (!opfsRoot) {
      const root = await navigator.storage.getDirectory();
      opfsRoot = await root.getDirectoryHandle('bashtion-share', { create: true });
    }
    return opfsRoot;
  }

  async function copyOpfsDirToFs(dh, fsPath) {
    try { fs.mkdir(fsPath); } catch (e) {}
    for await (const [name, handle] of dh.entries()) {
      const p = fsPath + '/' + name;
      if (handle.kind === 'directory') {
        await copyOpfsDirToFs(handle, p);
      } else {
        const buf = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        fs.writeFile(p, buf);
      }
    }
  }

  async function copyFsDirToOpfs(fsPath, dh) {
    for (const name of fs.readdir(fsPath)) {
      if (name === '.' || name === '..') continue;
      const p = fsPath + '/' + name;
      const st = fs.stat(p);
      if (fs.isDir(st.mode)) {
        await copyFsDirToOpfs(p, await dh.getDirectoryHandle(name, { create: true }));
      } else if (fs.isFile(st.mode)) {
        const data = fs.readFile(p);
        const fh = await dh.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
      }
    }
  }

  return {
    // call from Module.preRun (FS ready, guest not started)
    async restore(emscriptenFS) {
      fs = emscriptenFS;
      try {
        await copyOpfsDirToFs(await opfs(), ROOT);
        log('restored from OPFS');
      } catch (e) {
        log('restore skipped: ' + e.message);
      }
    },
    async save() {
      if (!fs) return;
      try {
        await copyFsDirToOpfs(ROOT, await opfs());
        dirty = false;
        log('saved to OPFS');
      } catch (e) {
        log('save failed: ' + e.message);
      }
    },
    start(intervalMs = 30000) {
      if (timer) clearInterval(timer);
      timer = setInterval(() => PERSIST.save(), intervalMs);
      window.addEventListener('beforeunload', () => { PERSIST.save(); });
      log('autosave every ' + intervalMs / 1000 + 's');
    },
  };
})();
