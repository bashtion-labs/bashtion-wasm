# Fork engine patches

Applied at build time to the ktock/qemu-wasm fork (the **primary** engine), which is cloned
fresh in `.github/workflows/build.yml`. The patches in `../qemu` and `../toolchain` apply to
`third_party/qemu` (upstream), which is only the dispatch-only experimental TCI lane.

## ptyfix.py

Backports one fix from xterm-pty 0.12.0 onto the 0.10.1 the fork links (0.12.0's library
targets emsdk 4/5 internals and corrupts the fork's emsdk-3.1.50 heap). In xterm-pty's
readable-wake callback, when the inner read still returns the internal EAGAIN sentinel — a
wake/echo race, or EOF — 0.10.1 hands that sentinel back as the `read()` result, wedging the
guest's blocking-read state machine. Measured as the one-good-read-then-wedge signature:
`login(1)` password timeouts and bash swallowing pasted newlines. The fix reports 0 bytes
(EOF) instead. Only emsdk-3.1.50-era constructs are used; the browser-side library is
untouched. GPL-2.0-or-later territory does not apply (this edits a MIT-licensed dependency
inside the build image, not QEMU).
