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
  // Ubuntu 26.04 turns on shell integration, so OSC 3008 brackets every
  // command's output. Anything reading this mirror has to strip OSC as well
  // as CSI, or it matches escape sequences instead of text.
  const strip = (x) => String(x || '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

  function install(master, win) {
    const w = win || window;
    const dec = new TextDecoder('utf-8');
    w.__serial = '';
    master.onWrite(([buf]) => { w.__serial += dec.decode(buf, { stream: true }); });
    return w;
  }

  // Is the console sitting at an idle shell prompt? Used before injecting
  // anything the user did not type, so it cannot land mid-command.
  function atPrompt(win) {
    const w = win || window;
    return /(user@bashtion:[^\n]*[$#]|[$#]) ?$/m.test(strip(w.__serial).slice(-200));
  }

  return { install, strip, atPrompt };
})();
