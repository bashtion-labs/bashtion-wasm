# Backport of xterm-pty 0.12.0's fd_read fix onto 0.10.1 (runs inside the
# fork toolchain image, against /build/node_modules/xterm-pty).
#
# Bug (measured as the one-good-read-then-wedge signature: login password
# timeouts, bash paste swallowing): in the readable-wake callback, when the
# inner read still returns the internal EAGAIN sentinel (wake/echo race, or
# EOF), 0.10.1 hands the sentinel back as the read() result. Upstream's fix
# reports 0 bytes (EOF) instead. Only 3.1.50-era constructs are used; the
# browser-side 0.10.1 protocol is untouched.
p = '/build/node_modules/xterm-pty/emscripten-pty.js'
s = open(p).read()
old = "wakeUp(xterm_pty_old_fd_read(fd, iov, iovcnt, pnum));"
new = (
    "const inner = xterm_pty_old_fd_read(fd, iov, iovcnt, pnum);\n"
    "\t\t\tif (inner == {{{ 1000 + cDefs.EAGAIN }}}) {\n"
    "\t\t\t\tHEAP32[(pnum)>>2] = 0;\n"
    "\t\t\t\twakeUp(0);\n"
    "\t\t\t} else {\n"
    "\t\t\t\twakeUp(inner);\n"
    "\t\t\t}"
)
assert old in s, 'anchor not found in emscripten-pty.js'
open(p, 'w').write(s.replace(old, new))
print('pty read fix applied')
