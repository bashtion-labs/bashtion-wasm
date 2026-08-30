# VM snapshot (the fast-start asset)

A cold systemd boot under emulation takes minutes, so a real session never boots from
scratch. Instead the guest is booted **once** on native QEMU, its RAM and device state
captured, and that state shipped as a static asset. The browser restores it and resumes in
seconds.

## How it is captured (`make-snapshot.sh`, run by `.github/workflows/snapshot.yml`)

1. Build the guest image, then boot it on **native QEMU built from the fork's own source
   tree**. This matters: a stream from a distro QEMU (even the same `pc-i440fx-8.2` machine
   series) is *not* accepted by the fork's wasm engine at restore — it hangs silently. Pass
   the native fork build via `QEMU_BIN`.
2. Wait for the real autologin shell prompt on the serial console (matched with ANSI stripped,
   so a status line can't trigger it early).
3. Over QMP: `stop`, then `migrate` the state to a file, then `quit`.

Machine, CPU, memory, and devices in `make-snapshot.sh` mirror `web/module-restore.js`
exactly — a migration stream only restores onto an identical machine.

## The matched set

Migration saves RAM and device state, **not** disk contents, so the outputs are one matched
set and must be served together:

```
rootfs-booted.ext4   the root disk as it was at capture
vdb.qcow2            the (empty) second disk for storage labs
vm.state             the migration stream (RAM + device state; size tracks -m)
vmlinuz             the kernel
```

## Restoring in the browser

The page loads `vm.state` with `-incoming`. The wasm engine restores the state but leaves the
VM **paused**; `web/bootscreen.js` / the restore wiring issue a monitor `cont` to resume it,
then reveal the prompt. See `web/README.md`.
