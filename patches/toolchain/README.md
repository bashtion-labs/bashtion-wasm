# Toolchain patches

> This patch serves the **experimental** upstream/TCI lane (`third_party/qemu`). The shipped engine is the ktock fork — see `../fork/`.

Applied by `make toolchain` to a copy of
`third_party/qemu/tests/docker/dockerfiles/emsdk-wasm64-cross.docker`; the submodule stays
pristine.

## 0001-zlib-immutable-url.patch

The Dockerfile fetches zlib from `https://zlib.net/zlib-$VERSION.tar.xz`. zlib.net serves
only the *current* release at that path and moves older releases to `/fossils/`, so the URL
rots the day a newer zlib ships — and the failure mode is misleading: the 404 HTML page goes
into `tar xJ`, which reports `xz: (stdin): File format not recognized`, reading like a
corrupt download rather than a dead URL. (This exact rot already bit the ktock/qemu-wasm
fork's Dockerfile, which pinned 1.3.1 after 1.3.2 shipped.)

Repointed to the GitHub release asset, which is immutable. The archive there is `.tar.gz`,
so the tar flag changes `xJC` -> `xzC`.
