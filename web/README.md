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
- `serialtap.js` — the page's plain-text mirror of the guest console
  (`window.__serial`), which the boot screen, save/load and tests all read. One
  streaming UTF-8 decoder for the session: xterm-pty emits fixed 4096-byte
  chunks, so decoding each chunk separately replaced every multi-byte sequence
  that straddled a boundary with U+FFFD.
- `termfit.js` — sizes the xterm grid to the window and produces the `stty rows R cols C`
  the guest has to be told, since a serial console carries no window-size signal.
- `serialfs.js` — Save/Load of the session. The engine's real filesystem lives in the wasm
  worker where page JavaScript cannot see it, so transfers ride the serial console. What is
  captured is decided guest-side by `/usr/local/sbin/bashtion-{pack,unpack}` (source in
  `image/seed/`); the page moves the bytes. Two rules shape the protocol: the payload never
  goes through readline (which echoes and redisplays every line typed at a prompt whatever
  `stty -echo` says), and no marker may appear literally in the command line that emits it,
  or it matches its own echo. Blocks are acknowledged one at a time, and both directions
  carry a byte count and a POSIX `cksum`. Behind a progress overlay.
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
sequences, not just CSI — `SERIALTAP.strip()` does. The pages expose `window.__serial`,
`window.__paste`, `window.__xterm` and `window.__fit` for tests.

Two things about `window.__serial` are easy to get wrong. It is decoded by a single streaming
UTF-8 decoder, because xterm-pty emits fixed 4096-byte chunks that cut multi-byte sequences in
half. And it contains the *echo* of every command line typed at the prompt, before that command
has run — readline redisplays what it is given regardless of the tty's ECHO flag — so anything
waiting for a marker must make sure the marker cannot appear in the command that produces it.

## Tests

`node --test web/test/*.test.mjs` loads the real page scripts (no bundler, no imports) into a
browser-shaped scope and drives them against a guest mock that reproduces those two behaviours.
CI runs it as the `web-tests` job.
