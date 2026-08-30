# Browser front end

Everything the browser loads. The engine is the ktock/qemu-wasm fork (wasm32 + JIT); its
build links xterm-pty for terminal I/O, and `qemu-system-x86_64` comes out as an ES-module
JS bundle (`out.js`) plus a `.wasm` and a pthread worker.

## Files

- `index.html` — the page. Streams the guest assets (rom, kernel, rootfs, second disk, and
  the restore `vm.state`) straight into the emscripten filesystem, wires xterm.js to the
  guest serial console through xterm-pty, starts QEMU, and drives the restore-resume.
- `module.js` — QEMU arguments for a **fresh boot** (kernel, two virtio disks, virtio-rng,
  9p share, machine `pc-i440fx-8.2`, `-m 512M`).
- `module-restore.js` — the same arguments plus `-incoming file:...` and a `bashtionRestore`
  flag; used by the restore build. The wasm engine loads incoming state but leaves the VM
  paused, so the page sends `cont` through QEMU's monitor (the `-nographic` mux) and then
  switches back to the serial console.
- `bootscreen.js` — the startup overlay: an ASCII bastion banner shown over the terminal
  until a shell prompt appears, at which point it clears the guest screen and reveals a clean
  prompt. Hides all SeaBIOS/kernel/systemd output.
- `serialfs.js` — Save/Load of the user's home directory. The engine's real filesystem
  lives in the wasm worker where page JavaScript cannot see it, so transfers ride the serial
  console: the guest tars its home to base64 between `BWT-BEGIN`/`BWT-END` sentinels; the page
  decodes to a downloaded `.tgz` and a browser (OPFS) copy. Behind a progress overlay.
- `toolchain-extra.dockerfile` — layers xterm-pty into the engine's build image.
- `xterm-pty.conf` — the COOP/COEP response headers cross-origin isolation requires.

## Serving

Any static host works, but it **must** send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These enable `SharedArrayBuffer`, which the engine's threads depend on. On a host that cannot
set headers (e.g. plain GitHub Pages), ship `coi-serviceworker.js` instead. Cross-origin asset
fetches (e.g. disks from object storage) must also satisfy CORS under COEP.

## Notes for anyone scraping the serial output

The guest image ships Ubuntu 26.04, which enables shell integration by default: OSC 3008
sequences bracket every command's output. Any code reading the serial stream must strip OSC
sequences, not just CSI. The pages expose `window.__serial`, `window.__paste`, and
`window.__xterm` for tests.
