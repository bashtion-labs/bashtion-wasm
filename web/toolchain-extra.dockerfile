# Extends the QEMU-built toolchain image with xterm-pty, whose emscripten-pty.js
# must be linked into the QEMU binary (--js-library) to give the wasm build a
# terminal input path. Upstream's emscripten config exports TTY but wires no
# frontend. Version matters: 0.10.x (the ktock-era pin) targets emsdk 3.1.50
# and its poll/read hooks silently fail to intercept on emsdk 4.x - output
# flows, input is dead. 0.12.0 fixed the async wrapping for modern emscripten.
# The linked emscripten-pty.js and the browser-side vendor lib must be the
# SAME version - the protocol between them is internal.
ARG BASE=bashtion-toolchain:ci
FROM ${BASE}
RUN cd /build && npm i xterm-pty@0.12.0 @xterm/xterm@5.5.0
