// Boot / restore screen: cover the terminal with the bashtion banner while
// the VM starts, so the student never sees SeaBIOS/kernel/systemd noise, then
// clear the scrollback and reveal a clean prompt once the shell is ready.
'use strict';

const BOOTSCREEN = (() => {
  const TOWER = "        ___    ___    ___\n       |   |  |   |  |   |\n       |   |__|   |__|   |\n       |                 |\n       |   $_            |\n       |   ___________   |\n       |                 |\n       |_________________|\n      /                   \\\n     /_____________________\\\n    |_______________________|";
  const stripANSI = (x) => x
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

  let el, dots, revealed = false;
  function build() {
    el = document.createElement('div');
    el.id = 'bwBoot';
    el.style.cssText =
      'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;background:#111;color:#e6e6e6;' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
      'transition:opacity .5s ease';
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:#3aa0d0;font-size:15px;line-height:1.15;margin:0';
    pre.textContent = TOWER;
    el.appendChild(pre);
    const rest = document.createElement('div');
    rest.style.textAlign = 'center';
    rest.innerHTML =
      '<div style="margin-top:18px;font-size:22px;letter-spacing:6px">bashtion</div>' +
      '<div style="margin-top:6px;font-size:13px;color:#8a8a8a">a real Linux box, in your browser</div>' +
      '<div style="margin-top:26px;font-size:13px;color:#9a9a9a">starting your environment<span id="bwBootDots"></span></div>' +
      '<div style="margin-top:6px;font-size:12px;color:#666">first start can take a minute or two</div>';
    el.appendChild(rest);
    document.body.appendChild(el);
    dots = el.querySelector('#bwBootDots');
    let n = 0;
    setInterval(() => { if (dots) dots.textContent = '.'.repeat((n = (n + 1) % 4)); }, 450);
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    window.__booted = true;
    try { window.__paste && window.__paste('clear\n'); } catch (e) {}
    setTimeout(() => {
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(() => { el.style.display = 'none'; }, 550);
    }, 500);
  }

  function start() {
    build();
    const t0 = Date.now();
    let promptSince = 0;
    const iv = setInterval(() => {
      const s = stripANSI(window.__serial || '');
      const atPrompt = /(user@bashtion:[^\n]*[$#]|[$#]) ?$/m.test(s.slice(-400));
      if (atPrompt) {
        if (!promptSince) promptSince = Date.now();
        if (Date.now() - promptSince > 1200) { clearInterval(iv); reveal(); }
      } else { promptSince = 0; }
      if (Date.now() - t0 > 30 * 60 * 1000) { clearInterval(iv); reveal(); }
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  return { reveal };
})();
