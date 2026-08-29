# Browser shell

Not yet implemented; this documents the embedding contract verified from the QEMU tree.

## What the wasm build produces

QEMU's configure auto-includes `configs/meson/emscripten.txt` when the host OS is
emscripten (`configure` line ~1928), which fixes the link contract:

- `-sEXPORT_ES6=1` — `qemu-system-x86_64` (our `out.js`) is an **ES module** exporting a
  Module factory; load with `import initQemu from './out.js'`.
- `-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS` — the emscripten `FS`
  object (for staging `/pack` assets and the 9p share) and `TTY` (for terminal wiring) are
  reachable from the page.
- `-sPROXY_TO_PTHREAD=1 -pthread` — QEMU runs in a worker; requires cross-origin isolation
  (`SharedArrayBuffer`), hence the COOP/COEP headers in `xterm-pty.conf`.
- `-sASYNCIFY=1`, `-sTOTAL_MEMORY=2GB` — initial memory 2 GB; wasm64 (Memory64) leaves
  room to raise this at build time if the guest needs more.

## Terminal

The plan is xterm.js + xterm-pty against the exported `TTY`, the same wiring the
ktock/qemu-wasm examples use — their flag set matches this one almost exactly, so those
examples (`examples/x86_64-alpine/src/htdocs/`) are the working reference.

## Planned files

- `module.js` — QEMU arguments: drives, virtfs, memory, machine
- `persist.js` — emscripten FS ↔ OPFS sync for the 9p-shared home directory
- `backup.js` — export/import of the home directory as a downloadable archive
