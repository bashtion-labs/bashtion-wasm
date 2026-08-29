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
	  -t $(TOOLCHAIN_TAG)-base - < $(OUT)/toolchain/tests/docker/dockerfiles/emsdk-wasm64-cross.docker
	docker build --build-arg BASE=$(TOOLCHAIN_TAG)-base -t $(TOOLCHAIN_TAG) \
	  -f web/toolchain-extra.dockerfile web/

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
	  --enable-system --enable-tcg-interpreter --disable-tools --enable-virtfs \
	  --extra-ldflags="--js-library=/build/node_modules/xterm-pty/emscripten-pty.js"
	docker exec -w /build $(BUILDER) emmake make -j$$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
	docker exec $(BUILDER) sh -c 'ls -la /build/qemu-system-x86_64*'
	mkdir -p $(HTDOCS)
	docker exec $(BUILDER) sh -c 'cd /build && tar cf - qemu-system-x86_64*' | tar xf - -C $(HTDOCS)
	mv $(HTDOCS)/qemu-system-x86_64 $(HTDOCS)/out.js 2>/dev/null || true

## Guest image: rootfs + kernel + initramfs (see image/).
image:
	mkdir -p $(OUT)/image
	docker build --platform linux/amd64 --progress=plain \
	  --output type=local,dest=$(OUT)/image ./image/

## Optional: pre-boot on native QEMU and capture vm.state to skip the boot wait.
snapshot:
	./snapshot/make-snapshot.sh

## Package guest assets + page into $(HTDOCS). Requires: make qemu, make image.
pack: 
	mkdir -p $(HTDOCS)/vendor
	# vendored terminal libs from the toolchain image (no CDN at runtime)
	docker cp $(BUILDER):/build/node_modules/@xterm/xterm/lib/xterm.js $(HTDOCS)/vendor/
	docker cp $(BUILDER):/build/node_modules/@xterm/xterm/css/xterm.css $(HTDOCS)/vendor/
	docker cp $(BUILDER):/build/node_modules/xterm-pty/index.js $(HTDOCS)/vendor/xterm-pty.js
	# per-asset bundles so the browser caches kernel/rom independently of rootfs
	mkdir -p $(OUT)/pack-rom $(OUT)/pack-kernel $(OUT)/pack-rootfs $(OUT)/pack-lab
	cp third_party/qemu/pc-bios/bios-256k.bin third_party/qemu/pc-bios/vgabios-stdvga.bin \
	   third_party/qemu/pc-bios/kvmvapic.bin third_party/qemu/pc-bios/linuxboot_dma.bin \
	   $(OUT)/pack-rom/
	cp $(OUT)/image/vmlinuz $(OUT)/pack-kernel/
	cp $(OUT)/image/rootfs.ext4 $(OUT)/pack-rootfs/
	cp $(OUT)/image/vdb.img $(OUT)/pack-lab/
	for n in rom kernel rootfs lab; do \
	  docker cp $(OUT)/pack-$$n $(BUILDER):/ && \
	  docker exec -w /build $(BUILDER) sh -c \
	    "python3 /emsdk/upstream/emscripten/tools/file_packager.py load-$$n.data --preload /pack-$$n > load-$$n.js" && \
	  docker cp $(BUILDER):/build/load-$$n.js $(HTDOCS)/ && \
	  docker cp $(BUILDER):/build/load-$$n.data $(HTDOCS)/ || exit 1; \
	done
	cp web/index.html web/module.js $(HTDOCS)/

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
