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
- LUKS encryption — `cryptsetup luksFormat` / `open` / `close` over dm-crypt
- ext4 with `mount`, `/etc/fstab`, `mount -a`, and `e2fsck`
- disk quotas — `quotacheck` / `quotaon` / `edquota` / `repquota`
- a second writable block device (`/dev/vdb`) for storage work
- netfilter, so `iptables`, `nft` and `ufw` function
- 9p/virtio, for a host share the guest can mount (`~/share`; unused in the browser,
  where save/restore rides the serial console instead)
- an unprivileged user with `sudo`, where privileged operations genuinely fail without it;
  `sudo` asks for no password, by choice, and `root` is locked, as on stock Ubuntu (#62)

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
cannot see guest writes (measured). So save/restore travels over the **serial console**, which
constrains both what can be sent and how.

**What is captured** is decided in the guest, by `/usr/local/sbin/bashtion-pack` (source in
`image/seed/`), so it can be read and tested there rather than buried in a page string:

- all of `/home/user`;
- everything under `/etc`, `/opt`, `/srv`, `/usr/local`, `/root` and `/var/spool/cron` that
  **differs** from the image it shipped as, against a baseline recorded at build time - so the
  user/group/shadow databases, `sudoers`, `fstab` and cron jobs come back, without sending
  ~2000 untouched files down a serial line;
- deletions, so removing a file is a change like any other;
- ACLs and capability xattrs.

Installed packages (`/var/lib/dpkg` plus their unpacked files), `/var` generally, and anything
on the spare disk `/dev/vdb` are **not** captured - they are far too large for this channel.
`apt install` from the offline repo has to be repeated after a restore. The UI says so at save
time.

**An archive is tied to the build that saved it.** Its system half is a diff from that image's
baseline, and its deletion list is that image's file list, so it only means something on the
same image. Each image carries a build id - the first line of
`/usr/local/lib/bashtion/baseline.tsv`, a sha256 over every path the baseline covers with its
contents, owner, extended attributes and hard links - and every archive records it in
`session.json` (format 2). `bashtion-unpack` reads `session.json` out of the archive before
extracting anything, then:

- **same build** - restores everything, as above;
- **a different build, or no build recorded** (every format-1 archive) - restores
  `/home/user` only, `~/share` included, and skips the system files and the deletions, which
  would otherwise silently revert whatever the newer image changed in the same files. It
  prints a warning naming both builds, and the page reports "Only your home folder was
  restored" rather than a plain success;
- **a format newer than it understands, or a `session.json` it cannot read** (not valid JSON,
  not a regular file, present twice, or missing from an archive that carries the format-2
  marker below) - refuses, having written nothing.

Archives from before format 1 - the original home-only download, `tar -C /home/user .`, whose
members are relative to the home directory - are refused by the name check, as they have been
since format 1 rooted the archive at `/`.

So after the guest image is rebuilt and redeployed, work saved before the update comes back
home-only, and system changes have to be made again.

The other direction needs the archive's own shape, because a helper from before format 2
never reads `format` or `build`. Every format-2 archive also carries
`usr/lib/bashtion/archive-format-2`, a member outside every tree any `bashtion-unpack` has
been allowed to write, so an older build - a tab left open across a deploy, or a rollback -
refuses the whole archive before extracting anything, rather than applying a newer build's
system files. `bashtion-pack` stages it in `/tmp` with `session.json` and renames both into
place inside the archive, so nothing on the root filesystem - a deleted file, a full disk - can
leave it out, and a save writes nothing to `/`. `bashtion-unpack` skips that member and never
extracts it.

**How it travels.** The payload is fed to a command reading the tty directly (`head -c N`),
never to a heredoc: readline echoes and redisplays every line typed at an interactive prompt
whatever `stty -echo` says, which sent the archive down the wire twice and redrew each 4 KB
line character by character. Blocks are acknowledged one at a time - the tty discards input
once its 4 KB line-discipline buffer fills and a uart has no XON/XOFF, so an ack is the only
flow control there is. Both directions carry a byte count and a POSIX `cksum`, so a lost or
duplicated byte is reported before anything is unpacked, rather than surfacing as a confusing
tar error.

Three buttons:

- **Download my work** - hands you a `.tgz` file you keep (and also remembers a copy
  in the browser). A file survives a wiped browser profile or a different machine, which is
  the real safety net on managed devices.
- **Load work** - restores the copy this browser remembers; **Load from a file...** takes one
  you downloaded.

Both hide the raw transfer behind a progress overlay and clear the scrollback afterward, so
you see only "Saving your work..." and a completion tick, never a wall of base64.

**Save checkpoint** and **Go back to checkpoint**, next to them, keep the whole running machine
instead of your files, and only inside the tab: see [Checkpoints](#checkpoints).

## Checkpoints

**Save checkpoint** keeps the whole running machine, and **Go back to checkpoint** puts it back
exactly as it was, after the browser's own `confirm()` asks first (#65). It is for trying
something destructive and getting back. Everything returns: files, installed packages, users,
settings, whatever is on `/dev/vdb` (partitions, LVM, filesystems), running programs, even the
terminal size. There is one checkpoint at a time: saving again replaces it, and you can go back
to it as often as you like. Saving needs the `$` prompt, so that going back lands at one where
the page can type; going back needs no prompt, because it is for when a program has the
terminal or the guest is stuck.

It is the snapshot machinery the page already restores from, driven through QEMU's monitor:
the HMP monitor shares the `-nographic` mux with the serial console, the page already switches
to it to `cont` the restored VM, and anyone can reach it by typing Ctrl-A c. `web/serialfs.js`
sends only constant commands, behind the same overlay and busy latch as save/load:

| Step | Why |
|---|---|
| blur the terminal, then Ctrl-A c | Switches the mux to the monitor. With the keyboard on the terminal, a key pressed now would reach the monitor, and HMP's `q` quits the engine. If a program has turned bracketed paste on, the page turns it off first: inside `ESC[200~`...`ESC[201~` the mux sees ESC after Ctrl-A and never switches. |
| `stop` | Nothing the guest prints can mix into the replies, and the disk layer and the snapshot are taken at one instant. |
| `snapshot_blkdev root /tmp/bashtion-root.qcow2 qcow2`, at the first checkpoint only | `savevm` refuses the raw root disk ("Device 'root' is writable but does not support snapshots"). This puts a qcow2 layer over it, backed by the raw image. The file is in the engine's Emscripten `/tmp`, not the guest's. Made at the first checkpoint, not at start, so a session that never takes one is unchanged. |
| `savevm bashtion` | One fixed tag. `savevm` replaces a snapshot with the same tag, one slot bounds the memory, and the replaced snapshot's space is reused. |
| `cont`, always once `stop` worked | A failed `savevm` leaves the machine as it was, so it carries on. Before that, `info snapshots` decides whether the earlier checkpoint survived: `savevm` deletes the old snapshot of the tag before writing the new one. |
| Ctrl-A c, then one line at the prompt | Back to the console. `sudo date -u -s @<now>; sudo hwclock --systohc; stty rows R cols C; clear` puts right what the guest has wrong: its clock stood still while the VM was stopped (and `loadvm` turns it back to the checkpoint), `loadvm` turns the tty size back too, and `clear` removes the monitor's text. |

Going back is blur, Ctrl-A c, `stop`, `loadvm bashtion`, `cont`, Ctrl-A c, then the same line
at the prompt. If `loadvm` fails or never answers, the page does **not** `cont`: after a partial
load the disks and memory may not match, and a machine running on that can corrupt the work
you would then download. It switches back, leaves the VM stopped, and says to reload. Whatever
happens, the page leaves the mux on the serial side and gives the keyboard back.

**It lives only in the tab.** The snapshot is inside that qcow2 layer, in the engine's
in-memory filesystem next to the disks. A reload or a closed tab loses it. Keeping state across
sessions, browsers and devices is a separate design question (#71); until then, **Download my
work** is the copy that lasts.

**What it costs**, measured on the served page: `info snapshots` gave a VM SIZE of 299 MiB for
the first checkpoint after a restore and 321 MiB later in a session, about the guest's RAM in
use. On top of that comes every root-disk cluster written after the first checkpoint, and a
brief second copy of the layer while MEMFS grows it. One slot keeps that bounded.

**How long it takes**, measured on the served page: in the monitor, `snapshot_blkdev` took
~20 ms, `savevm` 0.4-0.7 s and `loadvm` ~0.5 s. A whole save, click to tick, takes ~25 s (25.2
and 25.8 s for a first checkpoint, 24.5 and 24.7 s for later ones), and going back takes ~25-28
s. Almost all of that is the guest running the re-sync line, whose two `sudo`s print nothing for
15-17 s straight after a checkpoint, and waiting for its prompt.

**`~/share`.** While the 9p share is mounted in the guest, `savevm` refuses: "Migration is
disabled when VirtFS export path '/share' is mounted in the guest using mount_tag 'share0'".
The page shows that reason, the machine carries on, and an earlier checkpoint is kept. Nothing
in the browser mounts the share: it is `noauto` in the image's `/etc/fstab`.

## Known limits

- **No external network.** Browsers have no raw sockets, so `ping` and `traceroute` to the
  internet cannot work. Loopback is real: `ping 127.0.0.1` behaves normally, and `apt install`
  is served from a small repository baked into the image (offline) for the included packages.
  The guest is configured to be *coherently* offline rather than half-configured:
  `systemd-resolved` is masked, `/etc/resolv.conf` and `/etc/netplan/` say why they are empty,
  and `/etc/motd` states it at the start of every session. That repository is apt's only
  source, and `/etc/apt/sources.list` says why it lists no mirror. apt does not retry, and
  `apt update` fails rather than report a fetch it could not make as success, so a package
  that is not in the repository fails in seconds.
- **A save keeps your files, not the whole machine.** It brings back `/home/user` and what
  changed under `/etc`, `/opt`, `/srv`, `/usr/local`, `/root` and `/var/spool/cron` - those
  only onto the same build of the image; onto a different build, the home directory alone.
  Installed packages, the rest of `/var` and everything on `/dev/vdb` do not survive a save.
  See "Saving work" for what travels and why the rest cannot. A checkpoint keeps the whole
  machine, but only inside the tab.
- **A checkpoint lasts only as long as the tab, and costs memory.** It is held in the page's
  memory: a reload or a closed tab loses it, and it takes about as much as the guest's RAM in
  use (~300 MiB), plus every root-disk cluster written since the first checkpoint. See
  "Checkpoints".
- **`/dev/vdb` is practice space, not storage.** It is 4 GiB on paper, but it is a qcow2 image
  held in the page's memory, and it grows there as the guest writes to it: writing gigabytes to
  it can run the tab out of memory, taking any unsaved work with it.
- **Boot is slow, restore is fast.** A cold systemd boot under emulation takes minutes; the
  snapshot-restore path is why a real session starts in seconds. Development boots (building a
  fresh snapshot) still pay the full cost.
- **Persistent state in the browser (OPFS) is not durable on managed devices** that clear
  site data. The downloaded file is the reliable copy, which is why it is a first-class button.

## Layout

```
image/                  Guest image build: Ubuntu 26.04 rootfs, kernel, packages, module
                        pruning, offline apt repo
image/seed/             Files the guest ships with: /usr/local/{sbin,lib}/bashtion, the
                        save/restore helpers the page drives
image/test/             guest-check.py (boots the built image and asserts its behaviour)
                        and state-roundtrip.sh (a save/restore round trip in a container)
snapshot/               Pre-boot on native fork-tree QEMU -> vm.state (the fast-start asset)
web/                    Browser front end: page, QEMU args, boot banner, serial tap,
                        terminal fit, save/load
web/test/               node --test suite over the real page scripts
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
`Cross-Origin-Embedder-Policy: require-corp` (see `web/xterm-pty.conf` for local serving and
`deploy/_headers` for the Cloudflare deploy); on hosts that cannot set headers, ship
`coi-serviceworker.js`.

## Deploy (Cloudflare, free tier, hardened)

`deploy/` ships the site on Cloudflare's free plan. The small files (page, JS, kernel, ROM,
lab disk) are served as static assets; the three large files (the engine,
`qemu-system-x86_64.d8537ec6ccf0354a.wasm`, named by its hash, and `load-rootfsB.v4.data` and
`load-state.v4.data` - each over the 25 MiB static-asset cap; `v4` is the snapshot set's
release tag; `deploy/worker.js` names all three) live in a **private R2 bucket**
and are streamed by a small Worker (`deploy/worker.js`) from the same origin. R2's zero egress
fees cover the ~1.2 GB per cold load.

The deploy is security-hardened: private bucket (no public / `r2.dev` URL), an allowlist Worker
(GET/HEAD only, no path-derived keys, generic errors), a strict `Content-Security-Policy` with
no `'unsafe-inline'` scripts (the page bootstrap is externalized in `web/fork/boot.js` for
exactly this reason), plus `nosniff`, `Referrer-Policy`, `X-Frame-Options`, a locked-down
`Permissions-Policy`, and HSTS. The full header set was verified to boot the VM to a shell with
zero CSP violations.

`make deploy-prep` assembles the static half; **[deploy/README.md](deploy/README.md)** is the
step-by-step walkthrough.

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
- Checkpoints proven (#65): **Save checkpoint ~25 s, Go back to checkpoint ~25-28 s**, about
  1-1.6 s of it in the monitor. Going back undid a deleted file, a new user, an installed
  package, an LVM PV on `/dev/vdb` and a changed terminal size, twice, including from a
  terminal held by `sleep 600` with bracketed paste on.
- Boot banner verified to hide all boot output and reveal a clean prompt.

## Licence

QEMU and its derivatives are GPL-2.0. The patches in `patches/` are GPL-2.0-or-later,
matching the files they modify. The fork engine is
[ktock/qemu-wasm](https://github.com/ktock/qemu-wasm); `third_party/qemu` is upstream QEMU.
