# QEMU patches

Applied at build time to a copy of `third_party/qemu` (or in CI, to the checkout before
configure). The submodule itself stays pristine. Regenerate with `git diff` inside the
QEMU tree; verify with `git apply --check` against the pinned tag before committing.

## 0001-virtfs-enable-on-emscripten.patch

Upstream QEMU (v11.1.1) has first-class Emscripten/wasm64 support, but gates virtfs
(virtio-9p) to `linux`/`darwin`/`freebsd` hosts. 9p is how this project shares a
persistent directory between the browser and the guest, so the gate has to open.

Three one-line build changes plus one new file:

- `meson.build` — add `emscripten` to the virtfs host requirement
- `fsdev/meson.build` — add `emscripten` to the OS list
- `hw/9pfs/meson.build` — on emscripten, build `9p-util-stub.c` in place of the
  per-OS xattr implementations
- `fsdev/file-op-9p.h` — the `struct statfs` include (`<sys/vfs.h>`) is gated on
  `CONFIG_LINUX`; extended to `EMSCRIPTEN`, whose musl headers provide the same
  definition. Without it `9p-synth.c` fails with "incomplete definition of type
  'struct statfs'" (found by the first real CI compile).
- `hw/9pfs/9p-util-stub.c` (new) — Emscripten's libc ships musl's *headers* but not its
  xattr implementation, and `mknodat` is unavailable in the browser sandbox. The stub
  returns `ENOTSUP` for the xattr family and `qemu_mknodat`, which disables the 9p
  "mapped" security models; `security_model=passthrough` (what we use) does not need
  them. Derived from the equivalent stub in
  [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm) (GPL-2.0-or-later).

This is the same approach the ktock fork took (it comments the gate out wholesale);
kept here as a minimal additive patch against upstream instead of carrying the fork.
