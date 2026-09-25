// Real console output, captured byte for byte, for the serial tap tests (#69).
//
// Every stream here came out of the real program; none of it is written by
// hand. The point is to test the screen model against what the line editors
// actually emit rather than against what we believe they emit - which is how
// the mirror came to be misread in the first place.
//
// Guest streams (guest: true) are GNU bash 5.3.9 with its readline 8.3, from
// the ubuntu:26.04 image the guest is built from, run as user@bashtion in a
// pty at 80x24 with what the guest's serial console has: TERM=vt220 (what
// systemd 259 hands a serial getty when the kernel command line names no
// systemd.tty.term), LANG=C.UTF-8 (the names ending -C ran in the C locale,
// as the guest did before it had a locale), and `set enable-bracketed-paste
// off` in /etc/inputrc. Each step is everything the pty produced in response
// to the input its label names. A command line written in one go reaches
// readline as typeahead; the ones written a byte at a time went 30 ms apart,
// the way the guest's uart hands keystrokes over. The container has no disk
// to put volumes on, so for the lvm-* captures `sudo` was a stub that prints
// LVM's three success lines; everything readline drew is readline's own.
//
// Those passed through one tty, the guest's, so their lines end \r\n. In the
// page they then pass through xterm-pty's ONLCR as well; mirror() applies it,
// which is where the CR CR LF in window.__serial comes from.
//
// monitor is qemu-system-x86_64 10.2.1 -nographic -S in a pty at 80x24,
// driven the way the restore page drives it - Ctrl-A c, `cont` and CR in one
// write, Ctrl-A c - and then once more with `info status` written a byte at a
// time. QEMU ran on a pty, so its output already carries the second ONLCR.
// With -S there is no guest to resume, so `cont` starts a boot and SeaBIOS
// speaks; that output is kept as a step of its own.
export const CAPTURES = {
  // C locale; the command line written in one go, which readline takes as typeahead
  'lvm-batch-C': { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'sudo pvcreate /dev/vdb && sudo vgcreate vg00 /dev/vdb && sudo lv\rvcreate -y -L 100M -n lab ' +
      'vg00'],
    ['enter', '\r\n  Physical volume "/dev/vdb" successfully created.\r\n' +
      '  Volume group "vg00" successfully created\r\n' +
      '  Logical volume "lab" created.\r\n' +
      'user@bashtion:~$ '],
  ] },
  // the command line written a byte at a time, 30 ms apart
  'lvm-perchar': { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'sudo pvcreate /dev/vdb && sudo vgcreate vg00 /dev/vdb && sudo l \rvcreate -y -L 100M -n lab ' +
      'vg00'],
    ['enter', '\r\n  Physical volume "/dev/vdb" successfully created.\r\n' +
      '  Volume group "vg00" successfully created\r\n' +
      '  Logical volume "lab" created.\r\n' +
      'user@bashtion:~$ '],
  ] },
  // `ls -l` typed, then five DELs (Backspace)
  erase: { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'ls -l'],
    ['bs', '\x08\x1b[K\x08\x1b[K\x08\x1b[K\x08\x1b[K\x08\x1b[K'],
  ] },
  // a line typed, then Ctrl-U
  'kill-line': { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'echo hello world'],
    ['ctrl-u', '\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x1b[K'],
  ] },
  // a command run, then Up and Down back to an empty line
  history: { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['run', 'echo one\r\none\r\nuser@bashtion:~$ '],
    ['up', 'echo one'],
    ['down', '\x08\x08\x08\x08\x08\x08\x08\x08\x1b[K'],
  ] },
  // a line typed across the margin so its second row starts `x$ `, then Home and End
  'home-end': { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \rx$ '],
    ['home', '\x1b[A\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C'],
    ['end', '\r\n\r\x1b[C\x1b[C\x1b[C'],
  ] },
  // the same in the C locale, where readline moves right by reprinting
  'home-end-C': { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \rx$ '],
    ['home', '\x1b[Ar@bashtion:~$ '],
    ['end', '\r\n\rx$ '],
  ] },
  // a line typed across the margin, then Ctrl-U
  'wrapped-kill': { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \rx$ more'],
    ['ctrl-u', '\x1b[A\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[K\r\n' +
      '\r\x1b[K\x1b[A\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C' +
      '\x1b[C\x1b[C\x1b[C\x1b[C'],
  ] },
  // the same in the C locale
  'wrapped-kill-C': { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \rx$ more'],
    ['ctrl-u', '\x1b[Ashtion:~$ \x1b[K\r\n' +
      '\r\x1b[K\x1b[Auser@bashtion:~$ '],
  ] },
  // a line typed, then Ctrl-C
  'ctrl-c': { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['type', 'echo half typed'],
    ['ctrl-c', '^C\r\nuser@bashtion:~$ '],
  ] },
  // `clear`, which for vt220 is ESC[H ESC[J
  clear: { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['run', 'echo before\r\nbefore\r\n' +
      'user@bashtion:~$ '],
    ['clear', 'clear\r\n\x1b[H\x1b[Juser@bashtion:~$ '],
  ] },
  // `vim.tiny -N -u NONE`, `i`, then `# ` typed at the start of the first line
  vim: { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['vim', 'vim.tiny -N -u NONE /tmp/notes.sh\r\n' +
      '\x1b[1;24r\x1b[27m\x1b[24m\x1b[0m\x1b(B\x1b[H\x1b[J\x1b[?25l\x1b[24;1H"/tmp/notes.sh" [New]' +
      '\x1b[2;1H▽\x1b[6n\x1b[2;1H  \x1b[3;1H\x1bPzz\x1b\\\x1b[0%m\x1b[6n\x1b[3;1H           \x1b[1;' +
      '1H\x1b[2;2H\x1b[K\x1b[2;1H\x1b[1m~\x1b[0m\x1b(B\x1b[3;2H\x1b[K\x1b[3;1H\x1b[1m~\r\n' +
      '~\r\n~\r\n~\r\n~\r\n~\r\n' +
      '~\r\n~\r\n~\r\n~\r\n~\r\n' +
      '~\r\n~\r\n~\r\n~\r\n~\r\n' +
      '~\r\n~\r\n~\r\n~\r\n~\x1b[0m\x1b(B\x1b[24;63H0,0-1\x1b[9CAll\x1b[1;1H\x1b[?25h'],
    ['insert', '\x1b[?25l\x1b[24;53Hi\x1b[1;1H\x1b[24;53H \x1b[1;1H\x1b[24;1H\x1b[1m-- INSERT --\x1b[0m\x1b(' +
      'B\x1b[24;13H\x1b[K\x1b[24;63H0,1\x1b[11CAll\x1b[1;1H\x1b[?25h'],
    ['comment', '\x1b[?25l#\x1b[24;63H1,2\x1b[1;2H\x1b[?25h\x1b[?25l\x1b[24;65H3\x1b[1;3H\x1b[?25h'],
  ] },
  // `nano`, then `# ` typed at the start of the first line
  nano: { guest: true, steps: [
    ['boot', 'user@bashtion:~$ '],
    ['nano', 'nano /tmp/notes2.sh\r\n' +
      '\x1b[?2004h\x1b)0\x1b[1;24r\x1b[m\x1b(B\x1b[4l\x1b[?7h\x1b[?25l\x1b[H\x1b[J\x1b[22;35H\x1b[0' +
      ';7m\x1b(B[ New File ]\x1b[m\x1b(B\x1b[H\x1b[0;7m\x1b(B  GNU nano 8.7.1                    /t' +
      'mp/notes2.sh                              \x1b[1;79H\x1b[m\x1b(B\r\x1b[22B\x1b[0;7m\x1b(B^G' +
      '\x1b[m\x1b(B Help\x1b[6C\x1b[0;7m\x1b(B^O\x1b[m\x1b(B Write Out \x1b[0;7m\x1b(B^F\x1b[m\x1b(' +
      'B Where Is  \x1b[0;7m\x1b(B^K\x1b[m\x1b(B Cut\x1b[7C\x1b[0;7m\x1b(B^T\x1b[m\x1b(B Execute   ' +
      '\x1b[0;7m\x1b(B^C\x1b[m\x1b(B Location\r\x1b[1B\x1b[0;7m\x1b(B^X\x1b[m\x1b(B Exit\x1b[6C\x1b' +
      '[0;7m\x1b(B^R\x1b[m\x1b(B Read File \x1b[0;7m\x1b(B^\\\x1b[m\x1b(B Replace   \x1b[0;7m\x1b(B' +
      '^U\x1b[m\x1b(B Paste     \x1b[0;7m\x1b(B^J\x1b[m\x1b(B Justify   \x1b[0;7m\x1b(B^/\x1b[m\x1b' +
      '(B Go To Line\r\x1b[22A\x1b[?25h'],
    ['comment', '\x1b[?25l\x1b[1;52H\x1b[0;7m\x1b(B*\x1b[26C\x1b[m\x1b(B\x1b[?25h\r\x1b[1B#\x1b[m\x1b(B\x1b[?' +
      '25l\x1b[?25h \x1b[m\x1b(B'],
  ] },
  // as root, a full screen (`seq 30`), then `apt install -y tree`: the progress bar is a scroll region
  apt: { guest: true, steps: [
    ['boot', 'root@bashtion:~# '],
    ['fill', 'seq 30\r\n1\r\n2\r\n3\r\n' +
      '4\r\n5\r\n6\r\n7\r\n8\r\n' +
      '9\r\n10\r\n11\r\n12\r\n' +
      '13\r\n14\r\n15\r\n16\r\n' +
      '17\r\n18\r\n19\r\n20\r\n' +
      '21\r\n22\r\n23\r\n24\r\n' +
      '25\r\n26\r\n27\r\n28\r\n' +
      '29\r\n30\r\nroot@bashtion:~# '],
    ['apt', 'apt install -y tree\r\n' +
      '\rReading package lists... 0%\r\rReading package lists... 0%\r\rReading package lists... 0%' +
      '\r\rReading package lists... 7%\r\rReading package lists... 7%\r\rReading package lists... 8' +
      '1%\r\rReading package lists... 81%\r\rReading package lists... 82%\r\rReading package lists.' +
      '.. 82%\r\rReading package lists... 83%\r\rReading package lists... 83%\r\rReading package li' +
      'sts... 87%\r\rReading package lists... 87%\r\rReading package lists... 88%\r\rReading packag' +
      'e lists... 88%\r\rReading package lists... 92%\r\rReading package lists... 92%\r\rReading pa' +
      'ckage lists... 92%\r\rReading package lists... 92%\r\rReading package lists... 92%\r\rReadin' +
      'g package lists... 92%\r\rReading package lists... 95%\r\rReading package lists... 95%\r\rRe' +
      'ading package lists... 96%\r\rReading package lists... 96%\r\rReading package lists... 99%\r' +
      '\rReading package lists... 99%\r\rReading package lists... 99%\r\rReading package lists... 9' +
      '9%\r                             \r\rBuilding dependency tree... 0%\r\rBuilding dependency t' +
      'ree... 0%\r\rBuilding dependency tree... 50%\r\rBuilding dependency tree... 50%\r           ' +
      '                     \r\rReading state information... 0%\r\rReading state information... 6%' +
      '\r                                \r\rSolving dependencies... 0%\r\rSolving dependencies... ' +
      '10%\r                            \rInstalling:\r\n' +
      '\x1b[32m  tree\r\n\x1b[0m\r\n' +
      'Summary:\r\n  Upgrading: 0, Installing: 1, Removing: 0, Not Upgrading: 1\r\n' +
      '  Download size: 52.7 kB\r\n' +
      '  Space needed: 162 kB / 99.3 GB available\r\n' +
      '\r\n\x1b[33m\r0% [Working]\x1b[0m\r            \rGet:1 http://ports.ubuntu.com/ubuntu-ports ' +
      'resolute/universe arm64 tree arm64 2.3.1-1 [52.7 kB]\r\n' +
      '\x1b[33m\r4% [1 tree 2606 B/52.7 kB 5%]\x1b[0m\x1b[33m\r                             \r100% ' +
      '[Working]\x1b[0m\r              \rFetched 52.7 kB in 1s (96.0 kB/s)\r\n' +
      'debconf: unable to initialize frontend: Dialog\r\n' +
      'debconf: (No usable dialog-like program is installed, so the dialog based frontend cannot be' +
      ' used. at /usr/share/perl5/Debconf/FrontEnd/Dialog.pm line 79, <STDIN> line 1.)\r\n' +
      'debconf: falling back to frontend: Readline\r\n' +
      'debconf: unable to initialize frontend: Readline\r\n' +
      'debconf: (Can\'t locate Term/ReadLine.pm in @INC (you may need to install the Term::ReadLine' +
      ' module) (@INC entries checked: /etc/perl /usr/local/lib/aarch64-linux-gnu/perl/5.40.1 /usr/' +
      'local/share/perl/5.40.1 /usr/lib/aarch64-linux-gnu/perl5/5.40 /usr/share/perl5 /usr/lib/aarc' +
      'h64-linux-gnu/perl-base /usr/lib/aarch64-linux-gnu/perl/5.40 /usr/share/perl/5.40 /usr/local' +
      '/lib/site_perl) at /usr/share/perl5/Debconf/FrontEnd/Readline.pm line 8, <STDIN> line 1.)\r' +
      '\ndebconf: falling back to frontend: Teletype\r\n' +
      '\n\x1b7\x1b[0;23r\x1b8\x1b[1ASelecting previously unselected package tree.\r\n' +
      '(Reading database ... \r(Reading database ... 5%\r(Reading database ... 10%\r(Reading databa' +
      'se ... 15%\r(Reading database ... 20%\r(Reading database ... 25%\r(Reading database ... 30%' +
      '\r(Reading database ... 35%\r(Reading database ... 40%\r(Reading database ... 45%\r(Reading ' +
      'database ... 50%\r(Reading database ... 55%\r(Reading database ... 60%\r(Reading database ..' +
      '. 65%\r(Reading database ... 70%\r(Reading database ... 75%\r(Reading database ... 80%\r(Rea' +
      'ding database ... 85%\r(Reading database ... 90%\r(Reading database ... 95%\r(Reading databa' +
      'se ... 100%\r(Reading database ... 9126 files and directories currently installed.)\r\n' +
      'Preparing to unpack .../tree_2.3.1-1_arm64.deb ...\r\n' +
      '\x1b7\x1b[24;0f\x1b[42m\x1b[30mProgress: [  0%]\x1b[49m\x1b[39m [                           ' +
      '                               ] \x1b8\x1b7\x1b[24;0f\x1b[42m\x1b[30mProgress: [ 20%]\x1b[49' +
      'm\x1b[39m [███████████▌                                              ] \x1b8Unpacking tree (' +
      '2.3.1-1) ...\r\n\x1b7\x1b[24;0f\x1b[42m\x1b[30mProgress: [ 40%]\x1b[49m\x1b[39m [███████████' +
      '████████████▏                                  ] \x1b8Setting up tree (2.3.1-1) ...\r\n' +
      '\x1b7\x1b[24;0f\x1b[42m\x1b[30mProgress: [ 60%]\x1b[49m\x1b[39m [███████████████████████████' +
      '███████▊                       ] \x1b8\x1b7\x1b[24;0f\x1b[42m\x1b[30mProgress: [ 80%]\x1b[49' +
      'm\x1b[39m [██████████████████████████████████████████████▍           ] \x1b8\r\n' +
      '\x1b7\x1b[0;24r\x1b8\x1b[1A\x1b[Jroot@bashtion:~# '],
  ] },
  monitor: { guest: false, steps: [
    ['ctrl-a c', 'QEMU 10.2.1 monitor - type \'help\' for more information\r\r\n' +
      '(qemu) '],
    ['cont', 'c\x1b[K\x1b[Dco\x1b[K\x1b[D\x1b[Dcon\x1b[K\x1b[D\x1b[D\x1b[Dcont\x1b[K\r\r\n' +
      '(qemu) '],
    ['seabios', '\x1bc\x1b[?7l\x1b[2J\x1b[0mSeaBIOS (version 1.17.0-debian-1.17.0-1ubuntu1)\r\r\n' +
      'Booting from Hard Disk...\r\r\n' +
      'Boot failed: could not read the boot disk\r\r\n' +
      '\r\nBooting from Floppy...\r\r\n' +
      'Boot failed: could not read the boot disk\r\r\n' +
      '\r\nBooting from DVD/CD...\r\r\n' +
      'Boot failed: Could not read from CDROM (code 0003)\r\r\n' +
      'No bootable device.\r\r\n'],
    ['ctrl-a c back', '\r\r\n'],
    ['ctrl-a c again', '(qemu) '],
    ['info status', 'i\x1b[K\x1b[Din\x1b[K\x1b[D\x1b[Dinf\x1b[K\x1b[D\x1b[D\x1b[Dinfo\x1b[K\x1b[D\x1b[D\x1b[D\x1b' +
      '[Dinfo \x1b[K\x1b[D\x1b[D\x1b[D\x1b[D\x1b[Dinfo s\x1b[K\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[Di' +
      'nfo st\x1b[K\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[Dinfo sta\x1b[K\x1b[D\x1b[D\x1b[D\x1b[D' +
      '\x1b[D\x1b[D\x1b[D\x1b[Dinfo stat\x1b[K\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[' +
      'Dinfo statu\x1b[K\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D\x1b[Dinfo status\x1b' +
      '[K\r\r\nVM status: running\r\r\n' +
      '(qemu) '],
  ] },
};

// What window.__serial holds once the capture has run up to and including
// the step named `upTo` (all of it if omitted).
export function mirror(name, upTo) {
  const c = CAPTURES[name];
  let out = '';
  for (const [label, text] of c.steps) {
    out += c.guest ? text.replace(/\n/g, '\r\n') : text;
    if (label === upTo) return out;
  }
  if (upTo !== undefined) throw new Error(`${name} has no step ${upTo}`);
  return out;
}
