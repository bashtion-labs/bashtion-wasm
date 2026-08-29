// QEMU invocation for the wasm build. IMPORTANT: machine/cpu/memory must stay
// in lockstep with snapshot/make-snapshot.sh, or a restored vm.state will not
// load.
//
// Memory arithmetic (the wasm heap is fixed at link time, -sTOTAL_MEMORY=2GB):
// guest RAM (-m) + TCI tb cache (tb-size) + MEMFS-preloaded assets + QEMU
// itself must all fit inside it. Keep -m plus tb-size comfortably under
// ~1.4 GB until measured.
globalThis.Module = {
    arguments: [
        '-nographic', '-M', 'pc', '-cpu', 'qemu64', '-smp', '1',
        '-m', '768M', '-accel', 'tcg,tb-size=256',
        '-L', '/pack-rom/',
        '-nic', 'none',
        '-kernel', '/pack-kernel/vmlinuz',
        '-append', 'console=ttyS0,115200n8 root=/dev/vda rw rootwait nokaslr loglevel=4',
        '-drive', 'id=root,file=/pack-rootfs/rootfs.ext4,format=raw,if=none',
        '-device', 'virtio-blk-pci,drive=root',
        // second, empty disk for storage-administration exercises
        '-drive', 'id=lab,file=/pack-lab/vdb.img,format=raw,if=none',
        '-device', 'virtio-blk-pci,drive=lab',
        // 9p share backing the persistent directory (mount tag share0;
        // fstab inside the guest mounts it at /home/user/persist)
        '-virtfs', 'local,path=/share,mount_tag=share0,security_model=passthrough,id=share0',
    ],
    preRun: [(mod) => { mod.FS.mkdir('/share'); }],
};
