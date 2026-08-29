# bashtion-wasm

A full x86_64 Linux virtual machine that runs entirely in a browser tab, built on
**upstream QEMU's Emscripten/wasm64 support**.

The target is environments where installing software locally is not possible — managed or
locked-down machines — but where a *real* Linux system is still required, not a shell
emulator. Nothing is installed, no account is needed, and no per-user server runs.

## Design goal: a real kernel, not a syscall emulator

The requirement that drives every decision here is **full system-administration capability**:

- systemd as PID 1
- `cron` and `atd` running as real daemons
- LVM — `pvcreate` / `vgcreate` / `lvcreate` / `lvextend` over device-mapper
- ext4 with `mount`, `/etc/fstab`, `mount -a`, and `e2fsck`
- disk quotas — `quotacheck` / `quotaon` / `edquota` / `repquota`
- a second writable block device (`/dev/vdb`) for storage work
- netfilter, so `iptables` and `ufw` function
- 9p/virtio for a home directory shared with, and persisted by, the browser
- an unprivileged user with `sudo`, where privileged operations genuinely fail without it

Every one of these lives in the Linux kernel. That rules out the browser-Linux projects that
emulate syscalls in userspace rather than running a kernel.

## Why QEMU-in-wasm

**[WebVM](https://github.com/leaningtech/webvm) / CheerpX** was evaluated first. CheerpX is a
syscall emulator with no kernel, so there is no block layer, no device-mapper, no netfilter
and no quota subsystem. `mount(2)` returns `ENOSYS`
([webvm#133](https://github.com/leaningtech/webvm/issues/133)), there is no ICMP
([webvm#175](https://github.com/leaningtech/webvm/issues/175)), and `bash` runs as PID 1 so
there is no init system. Forking does not help: the published npm package is a ~26 kB loader
stub that fetches a proprietary runtime at load time, so the component that would need
changing is not distributed. Non-individual deployment also requires a commercial licence.

**[container2wasm](https://github.com/container2wasm/container2wasm)** was evaluated next. It
reaches x86_64 with a real kernel, but has no persistence
([#234](https://github.com/container2wasm/container2wasm/issues/234),
[#469](https://github.com/container2wasm/container2wasm/issues/469)) and wraps the payload in
`runc`, which constrains block-device access.

**QEMU compiled to WebAssembly** runs real QEMU with a TCG JIT, booting an unmodified Linux
kernel on x86_64 — every kernel-side requirement above simply works. Licensing is clean:
QEMU is GPL-2.0, and publishing this repository discharges the obligation that comes with
serving the resulting binary.

## Upstream

`third_party/qemu` is **upstream QEMU**, pinned to `v11.1.1`
(`c3d48b7d1e89604920e5b81b91140c2ad39a1943`) as a shallow submodule. QEMU gained
first-class Emscripten support in 2025: `emscripten` is a supported host OS, `wasm64` a
supported architecture with a `wasm` TCG backend, and the tree ships its own toolchain
Dockerfile (`tests/docker/dockerfiles/emsdk-wasm64-cross.docker`).

[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm) — the personal fork that pioneered
QEMU-in-the-browser — was evaluated and deliberately **not** used as the base: it is one
person's fork, stale since 2025-09, wasm32-only (a ~2 GB memory ceiling), pinned to emsdk
3.1.50 with already bit-rotted build URLs. Its examples (migration-based boot snapshots,
virtfs wiring, browser harness) remain a valuable reference for `web/`.

What upstream lacks relative to the fork is **virtfs on Emscripten** — upstream gates
virtio-9p to linux/darwin/freebsd hosts. Restored by
`patches/qemu/0001-virtfs-enable-on-emscripten.patch`: three one-line build-gate changes
plus a small xattr/mknod stub (see `patches/qemu/README.md`). Patches are applied to copies
at build time; the submodule is never modified in place.

## Known limits

- **No external network.** Browsers have no raw sockets, so `ping` and `traceroute` to the
  internet cannot work. Loopback is real: `ping 127.0.0.1` behaves normally.
- **`apt` is served from a local repository baked into the image**, so package installation
  works offline for the packages included at build time.
- **wasm64 needs Memory64 in the browser** (shipped in mainstream engines during 2025).
  Older pinned browsers on managed devices may lack it; this is the main compatibility risk
  and must be tested against the actual target fleet early. If it proves blocking, the
  wasm32 fork is the fallback base.
- **Persistent state lives in the browser (OPFS).** A managed machine that clears site data
  will take it with it, so an explicit export/import of the home directory to a file is a
  first-class feature, not a convenience.

## Layout

```
image/      Guest: rootfs, kernel, initramfs, seed files, local apt repository
snapshot/   Pre-boot on native QEMU -> vm.state, to skip the systemd boot wait
web/        Browser shell: QEMU arguments, OPFS persistence, home export/import
third_party/qemu        Upstream QEMU, pinned shallow submodule
patches/qemu/           Build-gate + stub patch enabling virtfs on Emscripten
patches/toolchain/      URL-rot fix for the in-tree toolchain Dockerfile
```

## Build

Everything runs in Docker via `make`. The toolchain Dockerfile comes from the QEMU tree
itself and pins `emscripten/emsdk:4.0.10`, which is published **amd64-only**; emsdk
**4.0.16+ is multi-arch** (amd64 + arm64), so on Apple Silicon build natively with:

```
make toolchain EMSDK_VERSION=4.0.16
```

Do not attempt the amd64 image under QEMU-binfmt emulation on an aarch64 Docker host: the
emsdk-bundled Node segfaults at the emscripten link step (verified). Build natively
multi-arch as above, or on an x86_64 host/CI.

```
make toolchain    # emscripten + zlib/glib/pixman/libffi (long, cached)
make qemu         # qemu-system-x86_64 -> wasm64, virtfs enabled via patches/
make image        # guest rootfs + kernel + initramfs
make snapshot     # optional: pre-booted vm.state
make serve        # local server with the required COOP/COEP headers
```

Cross-origin isolation is mandatory (`SharedArrayBuffer` backs threading), so the server
must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. On hosts that cannot set headers, ship
`coi-serviceworker.js`.

## Performance note: upstream wasm is TCI (interpreter), not JIT

Upstream requires `--enable-tcg-interpreter` on wasm hosts: the TB-to-wasm TCG **JIT**
backend exists only in the ktock fork (`tcg/wasm32`) and was never merged upstream, so
upstream wasm execution is TCI — QEMU's bytecode interpreter, several times slower than a
TCG JIT. Whether an interactive guest is usable under TCI-in-wasm is an open question the
first boot measurement must answer. If it is not, the options are (a) carrying the fork's
JIT backend as a patch series on upstream, or (b) building from the fork.

## Status

Early. The build pipeline is scaffolded against upstream v11.1.1; the wasm build and the
guest image are not yet validated. Capability coverage will be recorded here once measured
rather than assumed.

## Licence

QEMU and its derivatives are GPL-2.0. See `third_party/qemu` for upstream licensing. The
patches in `patches/` are GPL-2.0-or-later, matching the files they modify.
