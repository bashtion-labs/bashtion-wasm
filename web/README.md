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
- `serialtap.js` — the page's raw record of everything the guest writes to the console
  (`window.__serial`), and a model of the terminal that reads it back the way the screen
  shows it (`SERIALTAP.screen()`, `lastLine()`, `atPrompt()`). The boot screen, save/load,
  the resize sync and the tests all read one or the other; see below for which, and why.
  One streaming UTF-8 decoder for the session: xterm-pty emits fixed 4096-byte chunks, so
  decoding each chunk separately replaced every multi-byte sequence that straddled a
  boundary with U+FFFD.
- `termfit.js` — sizes the xterm grid to the window and produces the `stty rows R cols C`
  the guest has to be told, since a serial console carries no window-size signal.
- `serialfs.js` — Save/Load of the session. The engine's real filesystem lives in the wasm
  worker where page JavaScript cannot see it, so transfers ride the serial console. What is
  captured is decided guest-side by `/usr/local/sbin/bashtion-{pack,unpack}` (source in
  `image/seed/`); the page moves the bytes. Two rules shape the protocol: the payload never
  goes through readline (which echoes and redisplays every line typed at a prompt whatever
  `stty -echo` says), and no marker may appear literally in the command line that emits it,
  or it matches its own echo. Blocks are acknowledged one at a time, and both directions
  carry a byte count and a POSIX `cksum`. Behind a progress overlay. The last line
  `bashtion-unpack` prints comes back either way: on failure it is the reason, and on
  success it says whether the whole session was restored or - for an archive from a
  different image build - the home directory only, which the page reports as such.
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

`window.__serial` is every character the guest has written, decoded by a single streaming
UTF-8 decoder (xterm-pty emits fixed 4096-byte chunks that cut multi-byte sequences in half)
and appended in order. Nothing is removed from it and nothing in it is carried out. So:

- **It is not what the guest received.** It contains the *echo* of every command line typed
  at the prompt, before that command has run — readline redisplays what it is given regardless
  of the tty's ECHO flag — so anything waiting for a marker must make sure the marker cannot
  appear in the command that produces it.
- **It is not what the screen shows.** Line editors redraw, and the redraws are in the record
  as characters rather than applied. QEMU's monitor reprints its whole buffer after N
  cursor-lefts on every keystroke, so the restore page's `cont` reads back, escapes stripped,
  as `ccoconcont`. Readline crossing the right margin writes the new row's first character,
  then CR, then writes it again (`lv\rvcreate`); delete the CR and `lvcreate` reads
  `lvvcreate`. Neither is input the guest received — that is what #61's "duplicated
  characters" were (#69).
- **Every line ends CR CR LF**: the guest's tty adds a CR before each LF, and xterm-pty adds
  another on the way out.

Which to use: a question about **what arrived after a point** — has the guest printed
`BWR-OK` since the command was sent, has `clear` run since the handover — searches
`window.__serial` from an offset (`serialfs.js`, `bootscreen.js`'s reveal). Nothing written
later can take such a match away; on a screen, a `clear` would. A question about **what is
on the screen now** — is the console idle at a prompt, what is on the line being typed —
asks `SERIALTAP.atPrompt()` / `screen()` / `lastLine()`, which replay the record through a
minimal model of the terminal: cursor motion, erasure, the deferred wrap at the right margin,
scroll regions, the alternate screen. It is enough for those questions and is not an
emulation of xterm.js; rarer sequences are only approximated.

The page asks `atPrompt()` before it types anything the user did not (the resize sync, the
boot handover). A wrong "idle" would type `stty rows …` and Enter into whatever owns the
keyboard, where a wrong "busy" only delays the page, so it errs toward "busy". It requires
the cursor's line, joined across its soft wraps, to be prompt-shaped up to the cursor (no
whitespace before the trailing `$ ` or `# `, or Ubuntu's `user@host:dir$ ` with that the only
`$`/`#`), empty after it, and the last thing on the screen. And it says no outright on the
alternate screen, for a line whose start has left the model's scrollback, and after a saved
cursor is restored across a scroll or resize (xterm.js moves it with the text; the model does
not follow that), until the next fresh line, clear or reset.

A shape cannot tell the shell from anything else reading the keyboard: `# ` typed at the start
of a line into `cat > notes`, vim's `/# ` search on the bottom row (under TERM=vt220 vim draws
on the main screen), or `read -p 'user@bashtion:~$ '` is just as prompt-shaped. So
`atPrompt()` also takes the shell's word for it. The guest's login shell runs systemd's shell
integration, which sends OSC 3008 with `type=command` as each command starts and `type=shell`
before each prompt; while the last word says a command has the terminal, nothing is a prompt,
whatever its shape. That includes a nested `bash`/`sudo -s`/`sudo su`, which reads no
profile.d and says nothing, so a resize waits for the login shell's prompt — where it belongs
anyway: Ubuntu's sudo (`Defaults use_pty`) runs its shell on a pty of its own, and `stty` typed
there resizes that pty alone, leaving the login shell's tty at its old size. (A login shell
under sudo — `sudo -i`, `sudo su -` — reads profile.d and does say it has the terminal, so a
resize made there still lands on sudo's pty alone.) Where the shell has said nothing, the shape
alone decides.

## Tests

`node --test web/test/*.test.mjs` loads the real page scripts (no bundler, no imports) into a
browser-shaped scope and drives them against a guest mock that reproduces readline's echo and
a command reading the tty directly. The screen model is tested against real console output —
bash/readline, vim, nano and apt under the guest's TERM, a login shell with systemd's shell
integration and 26.04's sudo, and QEMU's monitor — captured byte for byte into
`test/console-captures.mjs`, and against short hand-written streams for what `atPrompt()` must
refuse, each answer taken from the terminal behaviour it exercises rather than from the model.
CI runs it as the `web-tests` job.
