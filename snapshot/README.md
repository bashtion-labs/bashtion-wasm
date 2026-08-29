# VM snapshots

QEMU supports migrating VM state to a file, and qemu-wasm can restore one in the browser.
Booting systemd under emulation is slow, so the guest is booted once on *native* QEMU, its
state captured with `migrate file:vm.state`, and that state shipped as a static asset. The
browser then restores an already-booted system instead of waiting through boot.

`vm.state` includes full guest RAM, so its size tracks the `-m` value — a real tradeoff
against total download size.
