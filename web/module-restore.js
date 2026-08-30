// RESTORE variant: resume the captured, already-logged-in VM.
// Machine/devices mirror the capture invocation exactly.
globalThis.Module = {
    bashtionRestore: true,
    arguments: [
        '-nographic', '-M', 'pc-i440fx-8.2', '-cpu', 'qemu64,+rdrand', '-smp', '1',
        '-m', '512M', '-accel', 'tcg,tb-size=128',
        '-L', '/pack-rom/',
        '-nic', 'none',
        '-kernel', '/pack-kernel/vmlinuz',
        '-append', 'console=ttyS0,115200n8 root=/dev/vda rw rootwait nokaslr nosoftlockup nowatchdog random.trust_cpu=on modules_load=virtio_rng systemd.show_status=1',
        '-drive', 'id=root,file=/pack-rootfs/rootfs.ext4,format=raw,if=none',
        '-device', 'virtio-blk-pci,drive=root',
        '-drive', 'id=lab,file=/pack-lab/vdb.qcow2,format=qcow2,if=none',
        '-device', 'virtio-blk-pci,drive=lab',
        '-device', 'virtio-rng-pci',
        '-virtfs', 'local,path=/share,mount_tag=share0,security_model=passthrough,id=share0',
        '-incoming', 'file:/pack-state/vm.state',
    ],
    preRun: [(mod) => { try { mod.FS.mkdir('/share'); } catch (e) {} }],
};
