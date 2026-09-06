// Serial tap: a plain-text mirror of everything the guest has written to the
// console. The boot screen watches it for a prompt, the save/load transfer
// reads the guest's replies out of it, and tests drive it directly.
//
// xterm-pty hands its consumers arbitrary 4096-byte chunks, so a multi-byte
// UTF-8 sequence routinely straddles a chunk boundary. Decoding each chunk
// with a fresh TextDecoder turns every straddling sequence into U+FFFD, which
// is what non-ASCII output looked like when read back through this mirror.
// One streaming decoder, reused for the life of the session, keeps it exact.
// (xterm.js itself is handed the raw bytes and decodes them statefully, so the
// visible terminal was never the problem.)
'use strict';

const SERIALTAP = (() => {
  function install(master, win) {
    const w = win || window;
    const dec = new TextDecoder('utf-8');
    w.__serial = '';
    master.onWrite(([buf]) => { w.__serial += dec.decode(buf, { stream: true }); });
    return w;
  }
  return { install };
})();
