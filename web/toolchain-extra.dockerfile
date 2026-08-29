# Extends the QEMU-built toolchain image with xterm-pty, whose emscripten-pty.js
# must be linked into the QEMU binary (--js-library) to give the wasm build a
# terminal input path. Upstream's emscripten config exports TTY but wires no
# frontend; the ktock fork proved this exact integration (xterm-pty v0.10.x).
ARG BASE=bashtion-toolchain:ci
FROM ${BASE}
RUN cd /build && npm i xterm-pty@v0.10.1 @xterm/xterm@5.5.0
