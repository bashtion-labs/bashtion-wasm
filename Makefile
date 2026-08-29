# bashtion-wasm — built on upstream QEMU's Emscripten/wasm64 support (v11.1.1+)

QEMU_SRC      := third_party/qemu
TOOLCHAIN_TAG := bashtion/qemu-wasm-toolchain:v11.1.1
BUILDER       := bashtion-build
OUT           := out
HTDOCS        := $(OUT)/htdocs

# The toolchain Dockerfile ships in the QEMU tree itself. Its pinned
# emsdk 4.0.10 is amd64-only; EMSDK_VERSION 4.0.16+ is multi-arch (arm64+amd64).
# Override on Apple Silicon: make toolchain EMSDK_VERSION=4.0.16
TOOLCHAIN_DOCKERFILE := $(QEMU_SRC)/tests/docker/dockerfiles/emsdk-wasm64-cross.docker
EMSDK_VERSION ?=

.PHONY: all toolchain qemu image snapshot serve clean builder-up builder-down

all: qemu image

## Toolchain: emscripten + zlib/glib/pixman/libffi, from QEMU's own Dockerfile,
## with patches/toolchain/ applied to a copy (URL-rot fixes; submodule stays pristine).
toolchain:
	mkdir -p $(OUT)/toolchain/tests/docker/dockerfiles
	cp $(TOOLCHAIN_DOCKERFILE) $(OUT)/toolchain/tests/docker/dockerfiles/
	for p in patches/toolchain/*.patch; do \
	  echo "applying $$p"; patch -p1 -d $(OUT)/toolchain < "$$p" || exit 1; \
	done
	docker build $(if $(EMSDK_VERSION),--build-arg EMSDK_VERSION_QEMU=$(EMSDK_VERSION)) \
	  -t $(TOOLCHAIN_TAG) - < $(OUT)/toolchain/tests/docker/dockerfiles/emsdk-wasm64-cross.docker

## Long-lived build container with the QEMU source (patched copy) mounted.
## Patches are applied to a copy in $(OUT)/qemu-src so the submodule stays pristine.
$(OUT)/qemu-src/.patched: patches/qemu/*.patch
	rm -rf $(OUT)/qemu-src
	mkdir -p $(OUT)
	cp -R $(QEMU_SRC) $(OUT)/qemu-src
	cd $(OUT)/qemu-src && for p in ../../patches/qemu/*.patch; do \
	  echo "applying $$p"; git apply "$$p" || exit 1; \
	done
	touch $@

builder-up: $(OUT)/qemu-src/.patched
	@docker inspect $(BUILDER) >/dev/null 2>&1 || \
	  docker run --rm -d --name $(BUILDER) \
	    -v $(CURDIR)/$(OUT)/qemu-src:/qemu/ $(TOOLCHAIN_TAG) sleep infinity

builder-down:
	-docker rm -f $(BUILDER)

## Cross-compile qemu-system-x86_64 to wasm64, per QEMU's in-tree wasm build flow.
## --enable-virtfs works because of patches/qemu/0001 (upstream gates it off-host).
qemu: builder-up
	docker exec -w /build $(BUILDER) emconfigure /qemu/configure \
	  --static --cpu=wasm64 --target-list=x86_64-softmmu \
	  --cross-prefix= --without-default-features \
	  --enable-system --enable-tcg-interpreter --disable-tools --enable-virtfs
	docker exec -w /build $(BUILDER) emmake make -j$$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4) qemu-system-x86_64
	mkdir -p $(HTDOCS)
	docker cp $(BUILDER):/build/qemu-system-x86_64 $(HTDOCS)/out.js
	-docker cp $(BUILDER):/build/qemu-system-x86_64.wasm $(HTDOCS)/
	-docker cp $(BUILDER):/build/qemu-system-x86_64.worker.js $(HTDOCS)/

## Guest image: rootfs + kernel + initramfs (see image/).
image:
	mkdir -p $(OUT)/image
	docker build --platform linux/amd64 --progress=plain \
	  --output type=local,dest=$(OUT)/image ./image/

## Optional: pre-boot on native QEMU and capture vm.state to skip the boot wait.
snapshot:
	./snapshot/make-snapshot.sh

## Serve locally with the COOP/COEP headers cross-origin isolation requires.
serve:
	@echo "http://localhost:8088"
	docker run --rm -p 127.0.0.1:8088:80 \
	  -v "$(CURDIR)/$(HTDOCS):/usr/local/apache2/htdocs/:ro" \
	  -v "$(CURDIR)/web/xterm-pty.conf:/usr/local/apache2/conf/extra/xterm-pty.conf:ro" \
	  --entrypoint=/bin/sh httpd -c \
	  'echo "Include conf/extra/xterm-pty.conf" >> /usr/local/apache2/conf/httpd.conf && httpd-foreground'

clean: builder-down
	rm -rf $(OUT)
