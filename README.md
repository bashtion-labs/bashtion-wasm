# bashtion-wasm

A full x86_64 Linux virtual machine — real kernel, real systemd — that runs entirely in a
browser tab. Built on **QEMU compiled to WebAssembly**.

The target is environments where installing software locally is not possible — managed or
locked-down machines — but where a *real* Linux system is still required, not a shell
emulator. Nothing is installed, no account is needed, and no per-user server runs. For a
plain-language walkthrough, see [USER-GUIDE.md](USER-GUIDE.md).

## Design goal: a real kernel, not a syscall emulator

The requirement that drives every decision here is **full system-administration capability**:

- systemd as PID 1
- `cron` and `atd` running as real daemons
- LVM — `pvcreate` / `vgcreate` / `lvcreate` / `lvextend` over device-mapper
- ext4 with `mount`, `/etc/fstab`, `mount -a`, and `e2fsck`
- disk quotas — `quotacheck` / `quotaon` / `edquota` / `repquota`
- a second writable block device (`/dev/vdb`) for storage work
- netfilter, so `iptables` and `ufw` function
- 9p/virtio for a home directory the browser can save and restore
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

**QEMU compiled to WebAssembly** runs real QEMU, booting an unmodified Linux kernel on
x86_64 — every kernel-side requirement above simply works. Licensing is clean: QEMU is
GPL-2.0, and publishing this repository discharges the obligation that comes with serving
the resulting binary.

## Two QEMU-in-wasm engines, and which one this uses

There are two ways to run QEMU in wasm, and they are not equal:

- **Upstream QEMU** (v11.1.1+) has first-class Emscripten support (`wasm64`, a `wasm` host
  OS, an in-tree toolchain Dockerfile), but executes guest code through **TCI** — QEMU's
  bytecode *interpreter*.
- **[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm)** is a fork (wasm32) that adds a
  real **TB-to-wasm JIT** backend, which was never merged upstream.

A controlled A/B — same guest image, same page, same machine — settled the choice decisively.
Upstream TCI **cannot boot this system**: unrelated guest services freeze after ~22 s of CPU
each, udev never announces devices, and login is unreachable across three 40-minute attempts
(this held even after ruling out entropy starvation and a runtime-dead glib `pipe2`). The
fork's JIT boots the identical image to a login prompt.

| Milestone | upstream wasm64 TCI | fork wasm32 JIT |
|---|---|---|
| crng ready | 72.8 s | 10.2 s |
| kernel done | 195.4 s | 27.7 s |
| journald finished | never (imprisoned 13-22 min) | 90.3 s |
| udev finished | never (34+ min) | 145.4 s |
| login prompt | never (3 x 40-min timeouts) | 378.4 s |

**So the shipped engine is the ktock fork (wasm32 + JIT).** The build clones it in CI (see
`.github/workflows/build.yml`, job `qemu-engine`). The upstream/TCI path is preserved as a
dispatch-only experimental lane (`.github/workflows/wasm64-experimental.yml` +
`third_party/qemu`, the pinned v11.1.1 submodule) so the A/B can be re-run if upstream ever
merges a JIT backend.

## How a session works

You load a page. Rather than boot a fresh system every time (a full systemd boot
runs several minutes of wall clock under emulation), the page **restores a pre-booted
snapshot**: the guest is booted once on native QEMU in CI, its RAM + device state captured
with QMP `migrate`, and shipped as a static asset alongside the disks. The browser restores
it with `-incoming`; because the wasm engine leaves a restored VM paused, the page resumes it
by sending `cont` through QEMU's monitor. **Page load to a logged-in prompt is ~13-15 s.**

While the VM comes up, a full-screen **bashtion banner** (an ASCII bastion tower with a `$_`
prompt) covers the terminal so no SeaBIOS/kernel/systemd text is ever shown; the moment the
shell is ready the scrollback is cleared and a clean `user@bashtion:~$` is revealed
(`web/bootscreen.js`).

## Saving work

The engine's authoritative filesystem lives in the wasm worker, where the page's JavaScript
cannot see guest writes (measured). So save/restore travels over the **serial console**: the
guest tars its home directory to base64 between sentinels, the page decodes it. Two buttons:

- **Download my work** — hands you a `.tgz` file you keep (and also remembers a copy
  in the browser). A file survives a wiped browser profile or a different machine, which is
  the real safety net on managed devices.
- **Load work** — restores from a chosen file, or from the browser-remembered copy.

Both hide the raw transfer behind a progress overlay and clear the scrollback afterward, so a
you see only "Saving your work..." and a completion tick, never a wall of base64.

## Known limits

- **No external network.** Browsers have no raw sockets, so `ping` and `traceroute` to the
  internet cannot work. Loopback is real: `ping 127.0.0.1` behaves normally, and `apt install`
  is served from a small repository baked into the image (offline) for the included packages.
- **Boot is slow, restore is fast.** A cold systemd boot under emulation takes minutes; the
  snapshot-restore path is why a real session starts in seconds. Development boots (building a
  fresh snapshot) still pay the full cost.
- **Persistent state in the browser (OPFS) is not durable on managed devices** that clear
  site data. The downloaded file is the reliable copy, which is why it is a first-class button.

## Layout

```
image/                  Guest image build: Ubuntu 26.04 rootfs, kernel, packages, module
                        pruning, offline apt repo, seed files
snapshot/               Pre-boot on native fork-tree QEMU -> vm.state (the fast-start asset)
web/                    Browser front end: page, QEMU args, boot banner, save/load
third_party/qemu        Upstream QEMU v11.1.1, pinned submodule (experimental TCI lane only)
patches/fork/           Runtime fix applied to the fork engine build (pty read wake)
patches/qemu/           virtfs-on-Emscripten patch for the upstream/experimental lane
patches/toolchain/      URL-rot fix for the upstream toolchain Dockerfile
.github/workflows/      build.yml (primary: fork engine + guest image), snapshot.yml,
                        wasm64-experimental.yml (dispatch-only TCI A/B)
```

## Building

Everything runs in Docker and in CI. `.github/workflows/build.yml` produces the two shipped
artifacts on x86_64 runners - `qemu-engine` (the fork built to wasm) and `guest-image` - and
`snapshot.yml` captures the pre-booted `vm.state`. The emscripten toolchain images are
amd64-only, so CI on an x86_64 runner is the supported build path; building the amd64 image
under QEMU-binfmt emulation on an aarch64 host fails (the emsdk-bundled Node segfaults at the
link step).

Cross-origin isolation is mandatory (`SharedArrayBuffer` backs the engine's threads), so any
host serving the page must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (see `web/xterm-pty.conf`); on hosts that cannot
set headers, ship `coi-serviceworker.js`.

## Status

**Working end to end on Ubuntu 26.04 LTS (resolute) / Linux 7.0**, measured on the shipped
stack (fork JIT engine, CI artifacts, page served locally):

- **Restore to a logged-in prompt: ~13 s** from page load; interactive round-trip ~15 s.
- `sudo` LVM on the second disk (`pvcreate` -> `vgcreate` -> `lvcreate` -> `mkfs` -> mount ->
  write -> remount -> read-back) proven in the restored session - passwordless, in a browser tab.
- Terminal input verified (a backported pty read fix delivers pasted bytes into readline;
  pasted commands execute).
- Download / Load work proven: a file written in the guest, downloaded, deleted, then
  restored by Load - with no base64 shown to the user.
- Boot banner verified to hide all boot output and reveal a clean prompt.

## Licence

QEMU and its derivatives are GPL-2.0. The patches in `patches/` are GPL-2.0-or-later,
matching the files they modify. The fork engine is
[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm); `third_party/qemu` is upstream QEMU.
