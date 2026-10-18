# Factory backlog

One feature per line. `/factory next` takes the first `- [ ]` item and marks it
`- [x] <item> → <job-id>`.

- [x] Add the utilities missing from the guest image: file, wget, nslookup (bind9-dnsutils), nft (nftables), cryptsetup and lpr/lpq/lprm (cups-bsd) (GitHub #63) → 001-guest-missing-utilities
- [x] Make the guest's offline state discoverable: apt must fail in seconds, not block for minutes and then exit 0 claiming success (GitHub #56) → 002-apt-offline-fail-fast
- [x] Lock the root account and decide whether sudo stays passwordless, saying so where users will see it (GitHub #62) → 003-root-lock-sudo
- [x] Add a checkpoint mechanism: save the running VM's system-level state and restore it later (GitHub #65) → 004-vm-checkpoint
- [x] Make the terminal fit the window, phone width included: with the cached engine's xterm, `TERMFIT.measure` returns null (`web/termfit.js` reads `css.cell`, but that xterm reports `actualCellWidth`, the xterm 4 shape), so the terminal stays 80x24 at every size and is cut off on the right on a phone; check whether the CI engine's xterm (`@xterm/xterm@5.5.0`, pinned in `web/toolchain-extra.dockerfile`) differs from the cached one → 005-terminal-fit-window
- [x] Make the control bar (`#controls` in `web/fork/index.html`) work on narrow screens: below about 830 px "Go back to checkpoint" wraps under the terminal and can't be clicked, and at phone width (390 px) four of the five buttons, both checkpoint buttons included, sit under the terminal (follow-up from 004-vm-checkpoint, #65) → 006-control-bar-narrow
- [x] Cap the prompt wait in Download my work and Load work: they call `ensureShell()` with no hard cap, so while a program keeps printing (`ping`, `top`) the overlay sits on "Preparing…" for up to 15 minutes; give them the 8 s cap Save checkpoint got, and test with a guest that keeps printing (follow-up from 004-vm-checkpoint, #65) → 007-prompt-wait-cap
- [x] Send one short `cont` after a checkpoint `stop` that never answered (unless `loadvm` was sent), so a stalled reply can't leave the VM stopped (`web/serialfs.js` `run()`/`leave()`; Codex finding dismissed as low in 004-vm-checkpoint round 3) → 008-cont-after-stop
- [x] Warn instead of a plain ✓ when the clock and terminal-size re-sync after a checkpoint save or go-back can't finish (for example "saved, but the clock could not be set") (`web/serialfs.js` `resync()`; Codex finding dismissed as low in 004-vm-checkpoint round 3) → 009-resync-warning
- [~] Deferred by the human (2026-10-18), not for `/factory next`: Durable persistence: let a user's environment survive across sessions, browsers and devices (GitHub #71)

