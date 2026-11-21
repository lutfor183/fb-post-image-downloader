// ==UserScript==
// @name         Facebook Post Photos to PDF
// @namespace    https://github.com/lutfor183/fb-post-image-downloader
// @version      2.2.0
// @description  Save every photo of the open Facebook post as one high-resolution PDF (Firefox Android friendly)
// @match        *://*.facebook.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      facebook.com
// @connect      *.facebook.com
// @connect      fbcdn.net
// @connect      *.fbcdn.net
// @connect      fbsbx.com
// @connect      *.fbsbx.com
// @updateURL    https://raw.githubusercontent.com/lutfor183/fb-post-image-downloader/main/fb-post-photos-pdf.user.js
// @downloadURL  https://raw.githubusercontent.com/lutfor183/fb-post-image-downloader/main/fb-post-photos-pdf.user.js
// ==/UserScript==
(function () { 'use strict';
/* pdf.js - tiny PDF writer. One page per JPEG, JPEG embedded untouched (DCTDecode). */
function jpegInfo(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], c: b[i + 9] };
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}
async function toJpeg(bytes) { // failsafe for webp/png responses
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}
async function prepareImage(bytes) {
  if (bytes.length < 1500) throw new Error('response too small');
  let info = jpegInfo(bytes);
  if (info) return { bytes, ...info };
  const j = await toJpeg(bytes);
  info = jpegInfo(j);
  if (!info) throw new Error('not an image');
  return { bytes: j, ...info };
}
async function retry(fn, n = 3) {
  let err;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { err = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw err;
}
function limiter(max) {
  let active = 0; const q = [];
  const next = () => {
    if (active >= max || !q.length) return;
    active++;
    const { f, res, rej } = q.shift();
    f().then(res, rej).finally(() => { active--; next(); });
  };
  return f => new Promise((res, rej) => { q.push({ f, res, rej }); next(); });
}

/* ---- HD upgrade: mobile viewers show reduced copies; look for the full-size file of the same photo ---- */
const fname = u => { try { return new URL(u).pathname.split('/').pop(); } catch (e) { return ''; } };
const sameFile = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = a.split('_'), y = b.split('_');
  return x.length >= 3 && y.length >= 3 && x[1] === y[1];
};
function htmlCandidates(html, name) {
  const t = html.replace(/\\\//g, '/').replace(/\\u0025/g, '%').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  const re = /https:\/\/[^"'\\\s<>]*?(?:fbcdn\.net|fbsbx\.com)[^"'\\\s<>]*/g;
  const seen = new Map(); let m;
  while ((m = re.exec(t))) {
    const u = m[0];
    if (seen.has(u) || !sameFile(fname(u), name)) continue;
    const ctx = t.slice(Math.max(0, m.index - 200), m.index + u.length + 200);
    const w = +((ctx.match(/"width":(\d+)/) || [])[1] || 0), h = +((ctx.match(/"height":(\d+)/) || [])[1] || 0);
    seen.set(u, { u, px: w * h, orig: !/[?&]stp=/.test(u) });
  }
  return [...seen.values()].sort((a, b) => (b.orig - a.orig) || (b.px - a.px)).slice(0, 3).map(x => x.u);
}
/* get(url) -> Uint8Array (with .finalUrl when known). item: {src, fbid, origin}. Always returns the sharpest version found. */
async function bestImage(get, item) {
  let best = await prepareImage(await get(item.src));
  const done = () => { best.lq = Math.max(best.w, best.h) < 1600; return best; };
  const maxed = () => Math.max(best.w, best.h) >= 2040;
  const take = async bytes => {
    try { const im = await prepareImage(bytes); if (im.w * im.h > best.w * best.h * 1.1) { best = im; return true; } } catch (e) {}
    return false;
  };
  const name = fname(item.src), tok = name.split('_')[1];
  const ids = [...new Set([item.fbid, /^\d{8,}$/.test(tok || '') ? tok : null].filter(Boolean))]; // viewer URL can lag; the file name carries the photo id too
  if (maxed() || !ids.length) return done();
  const origins = [...new Set([item.origin, 'https://www.facebook.com'].filter(Boolean))];
  for (const id of ids) for (const o of origins) {
    if (maxed()) break;
    try { // the same "full size" link Facebook's own Download uses
      const b = await get(o + '/photo/view_full_size/?fbid=' + id);
      if (sameFile(fname(b.finalUrl || ''), name)) await take(b);
    } catch (e) {}
    if (maxed()) break;
    try { // otherwise dig the original URL out of the photo page data
      const html = new TextDecoder().decode(await get(o + '/photo/?fbid=' + id));
      for (const u of htmlCandidates(html, name)) { if (await take(await get(u))) break; }
    } catch (e) {}
  }
  return done();
}

/* imgs: [{bytes:Uint8Array, w, h, c}] -> Blob. Page width = A4 width, height follows the photo's aspect. */
function buildPdf(imgs) {
  const enc = new TextEncoder(), parts = [], off = [];
  let pos = 0;
  const push = d => { if (typeof d === 'string') d = enc.encode(d); parts.push(d); pos += d.length; };
  const f2 = x => x.toFixed(2);
  const n = imgs.length, total = 3 + 3 * n;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  off[1] = pos; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  off[2] = pos;
  push('2 0 obj\n<< /Type /Pages /Count ' + n + ' /Kids [' + imgs.map((_, i) => (3 + 3 * i) + ' 0 R').join(' ') + '] >>\nendobj\n');
  imgs.forEach((im, i) => {
    let W = 595.28, H = W * im.h / im.w;
    if (H > 14000) { H = 14000; W = H * im.w / im.h; }
    const p = 3 + 3 * i, c = p + 1, x = p + 2;
    const content = 'q ' + f2(W) + ' 0 0 ' + f2(H) + ' 0 0 cm /Im Do Q';
    off[p] = pos;
    push(p + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f2(W) + ' ' + f2(H) + '] /Resources << /XObject << /Im ' + x + ' 0 R >> >> /Contents ' + c + ' 0 R >>\nendobj\n');
    off[c] = pos;
    push(c + ' 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
    const cs = im.c === 1 ? '/DeviceGray' : im.c === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const dec = im.c === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    off[x] = pos;
    push(x + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace ' + cs + dec + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n');
    push(im.bytes);
    push('\nendstream\nendobj\n');
  });
  const xref = pos;
  let t = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
  for (let i = 1; i < total; i++) t += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  push(t + 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  return new Blob(parts, { type: 'application/pdf' });
}
if (typeof module !== 'undefined') module.exports = { buildPdf, jpegInfo, prepareImage, bestImage, htmlCandidates };
/* walker.js - finds the photos of the open Facebook post. Shared by the extension and the userscript. */
var FBW = (() => {
  const MAX = 80;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isCdn = u => /fbcdn\.net|fbsbx\.com/.test(u || '');
  const keyOf = u => { try { return new URL(u).pathname; } catch (e) { return u; } };
  const rect = el => el.getBoundingClientRect();
  const visible = el => { const r = rect(el); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
  const PHOTO_URL = /\/photo(\.php|s?\/|\?)|[?&]fbid=/;
  const inViewerUrl = () => PHOTO_URL.test(location.pathname + location.search);
  const srcOf = im => im && (im.currentSrc || im.src);

  function bigImg(root) {
    let best = null, area = 0;
    for (const im of root.querySelectorAll('img')) {
      if (!isCdn(srcOf(im))) continue;
      const r = rect(im);
      const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (r.width < 200 || r.height < 200 || a <= area) continue;
      try { if (getComputedStyle(im).filter.includes('blur')) continue; } catch (e) {}
      area = a; best = im;
    }
    return best;
  }
  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  function viewerRoot() {
    for (const d of dialogs().reverse()) if (bigImg(d)) return d;
    return document.body;
  }
  const viewerOpen = () => inViewerUrl() && !!bigImg(viewerRoot());
  const current = () => srcOf(bigImg(viewerRoot()));

  async function waitFor(fn, ms, step = 40) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
    return !!fn();
  }
  function fbidNow() {
    const q = new URLSearchParams(location.search).get('fbid');
    if (q && /^\d{6,}$/.test(q)) return q;
    const m = location.pathname.match(/\d{8,}/g);
    return m ? m[m.length - 1] : null;
  }
  async function settle() { // wait until the hi-res image is loaded and stable
    let last = null, same = 0; const t0 = Date.now();
    while (Date.now() - t0 < 1800) {
      const im = bigImg(viewerRoot()), s = srcOf(im);
      if (im && im.complete && im.naturalWidth > 0 && s === last) { if (++same >= 3) return { shown: s, src: bestFromSrcset(im) || s, fbid: fbidNow(), origin: location.origin }; }
      else same = 0;
      last = s; await sleep(60);
    }
    return last ? { shown: last, src: last, fbid: fbidNow(), origin: location.origin } : null;
  }

  /* ---- navigation: label button -> keyboard -> edge button -> swipe ---- */
  const LABELS = {
    next: ['Next photo', 'Next Photo', 'Next', 'Next media'],
    prev: ['Previous photo', 'Previous Photo', 'Previous', 'Previous media']
  };
  function clickNav(dir) {
    const root = viewerRoot();
    for (const l of LABELS[dir]) {
      const el = [...root.querySelectorAll('[aria-label="' + l + '"]')].find(visible) ||
                 [...document.querySelectorAll('[aria-label="' + l + '"]')].find(visible);
      if (el) { el.click(); return true; }
    }
    return false;
  }
  function pressKey(dir) {
    const key = dir === 'next' ? 'ArrowRight' : 'ArrowLeft', code = dir === 'next' ? 39 : 37;
    const tgt = document.activeElement || document.body;
    for (const type of ['keydown', 'keyup'])
      tgt.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true }));
    return true;
  }
  function edgeBtn(dir) { // language-independent: round button at the left/right edge, mid-height
    const root = viewerRoot();
    const el = [...root.querySelectorAll('[role="button"],button')].find(b => {
      if (!visible(b)) return false;
      const r = rect(b), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (r.width > 120 || r.height > 120) return false;
      const edge = dir === 'next' ? cx > innerWidth * 0.85 : cx < innerWidth * 0.15;
      return edge && cy > innerHeight * 0.25 && cy < innerHeight * 0.75;
    });
    if (!el) return false;
    el.click(); return true;
  }
  function scrollNav(dir) { // mobile galleries: next photo is a scroll away
    const root = viewerRoot(), cur = bigImg(root);
    if (!cur) return false;
    const sgn = dir === 'next' ? 1 : -1;
    const imgs = [...root.querySelectorAll('img')].filter(i => isCdn(srcOf(i)) && rect(i).width >= 200 && rect(i).height >= 200);
    const tgt = imgs[imgs.indexOf(cur) + sgn];
    if (tgt && keyOf(srcOf(tgt)) !== keyOf(srcOf(cur))) { tgt.scrollIntoView({ block: 'center', inline: 'center' }); return true; }
    for (let el = cur.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 20) { el.scrollBy({ left: sgn * el.clientWidth }); return true; }
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) { el.scrollBy({ top: sgn * el.clientHeight * 0.9 }); return true; }
    }
    window.scrollBy({ top: sgn * innerHeight * 0.8 }); return true;
  }
  function swipe(dir) {
    const t = bigImg(viewerRoot()) || document.body, r = rect(t), y = r.top + r.height / 2;
    const x0 = dir === 'next' ? r.right - r.width * 0.1 : r.left + r.width * 0.1;
    const x1 = dir === 'next' ? r.left + r.width * 0.1 : r.right - r.width * 0.1;
    const tc = x => new Touch({ identifier: 7, target: t, clientX: x, clientY: y });
    const fire = (type, x, end) => t.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, touches: end ? [] : [tc(x)], targetTouches: end ? [] : [tc(x)], changedTouches: [tc(x)]
    }));
    const pe = (type, x) => { try { t.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === 'pointerup' ? 0 : 1 })); } catch (e) {} };
    pe('pointerdown', x0); fire('touchstart', x0);
    for (let i = 1; i <= 5; i++) { const x = x0 + (x1 - x0) * i / 5; pe('pointermove', x); fire('touchmove', x); }
    pe('pointerup', x1); fire('touchend', x1, true);
    return true;
  }
  const MOBILE = /Android|Mobi/i.test(navigator.userAgent) || /^m\./.test(location.host);
  const METHODS = MOBILE ? [clickNav, scrollNav, swipe, edgeBtn, pressKey] : [clickNav, pressKey, edgeBtn, scrollNav, swipe];
  let pref = null;

  async function waitChange(prev, ms) {
    return waitFor(() => { const im = bigImg(viewerRoot()), s = srcOf(im); return s && s !== prev && im.naturalWidth > 0; }, ms);
  }
  async function step(dir, prev) {
    const order = pref === null ? METHODS.map((_, i) => i) : [pref];
    for (const i of order) {
      try { if (!METHODS[i](dir)) continue; } catch (e) { continue; }
      if (await waitChange(prev, pref === null ? 1500 : 2500)) { pref = i; return true; }
    }
    if (pref !== null) pref = null; // preferred method failed: probably end of set
    return false;
  }

  async function walk(dir, seen, out, emit, say) {
    let prev = current();
    while (out.length < MAX) {
      if (!(await step(dir, prev))) return 'end';
      const cur = await settle();
      if (!cur) return 'end';
      const k = keyOf(cur.shown);
      if (seen.has(k)) return 'wrap';
      seen.add(k); out.push(cur); emit(cur); prev = cur.shown;
      say('Reading photo ' + (seen.size) + '…');
    }
    return 'cap';
  }

  /* ---- locating the post ---- */
  const topArticle = el => { const a = el.closest('[role="article"]'); return !a || !a.parentElement.closest('[role="article"]'); };
  function findScope() {
    const d = dialogs().pop(); if (d) return d;
    const arts = [...document.querySelectorAll('[role="article"]')].filter(a => !a.parentElement.closest('[role="article"]'));
    let best = null, bestV = 0;
    for (const a of arts) {
      const r = rect(a), v = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (v > bestV) { bestV = v; best = a; }
    }
    return best || document.querySelector('[role="main"]') || document.body;
  }
  function photoAnchors(scope) {
    return [...scope.querySelectorAll('a[href*="/photo"], a[href*="fbid="]')]
      .filter(a => a.querySelector('img') && rect(a).width >= 100 && topArticle(a));
  }
  function bestFromSrcset(im) {
    let best = srcOf(im), w = 0;
    for (const part of (im.getAttribute('srcset') || '').split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      const n = parseInt(d, 10) || 0;
      if (u && n > w) { w = n; best = u; }
    }
    return best;
  }
  function domImages(scope, emit) { // last-resort: images already on the page
    const seen = new Set(), out = [];
    for (const im of scope.querySelectorAll('img')) {
      const s = bestFromSrcset(im);
      if (!isCdn(s) || !topArticle(im)) continue;
      if (rect(im).width < 150 && im.naturalWidth < 400) continue;
      const k = keyOf(s); if (seen.has(k)) continue;
      seen.add(k); const it = { src: s, shown: s, fbid: null, origin: location.origin }; out.push(it); emit(it);
    }
    return out;
  }
  async function closeViewer(startHref) {
    for (let i = 0; i < 3 && viewerOpen(); i++) {
      const tgt = document.activeElement || document.body;
      tgt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      await sleep(350);
      if (!viewerOpen() || location.href === startHref) break;
      history.back(); await sleep(450);
    }
  }

  /* ---- main entry: returns ordered list of hi-res URLs; emit(url) fires as each is found ---- */
  async function collect(emit, say) {
    const startHref = location.href, startY = window.scrollY, seen = new Set();
    let ours = false, urls = [];
    const scope = findScope();
    pref = null;
    try {
      if (!viewerOpen()) {
        const anchors = photoAnchors(scope);
        if (!anchors.length) { say('No photo links found, using images on the page…'); return domImages(scope, emit); }
        say('Opening photo viewer (' + anchors.length + (anchors.length >= 5 ? '+' : '') + ' photos)…');
        anchors[0].click(); ours = true;
        if (!(await waitFor(viewerOpen, 6000))) { say('Viewer did not open, using images on the page…'); return domImages(scope, emit); }
      }
      const first = await settle();
      if (!first) throw new Error('no image in viewer');
      seen.add(keyOf(first.shown)); emit(first);
      if (!ours) { // started inside the viewer: rewind to the first photo, then go forward
        const back = [];
        const why = await walk('prev', seen, back, emit, say);
        urls = back.reverse().concat([first]);
        if (why === 'wrap') return urls; // full circle; order may be rotated
        const fwd = [];
        // walk forward back to the photo we started on, then continue past it
        const cur0 = first.shown; let guard = 0;
        while (guard++ < MAX && keyOf(current() || '') !== keyOf(cur0)) { if (!(await step('next', current()))) break; await settle(); }
        await walk('next', seen, fwd, emit, say);
        return urls.concat(fwd);
      }
      urls = [first];
      await walk('next', seen, urls, emit, say);
      return urls;
    } finally {
      if (ours) await closeViewer(startHref);
      try { window.scrollTo(0, startY); } catch (e) {}
    }
  }

  /* ---- floating button + status bubble (top layer, draggable) ---- */
  function makeUI(onClick) {
    const host = document.createElement('div');
    const base = 'position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;width:auto;height:auto;max-width:92vw;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-start;gap:10px;font:17px/1.4 system-ui,sans-serif;touch-action:none;';
    let pos = { l: 12, b: 96 };
    try { pos = JSON.parse(localStorage.getItem('fbpdf_pos')) || pos; } catch (e) {}
    const place = () => {
      pos.l = Math.max(0, Math.min(pos.l, innerWidth - 140));
      pos.b = Math.max(0, Math.min(pos.b, innerHeight - 80));
      host.style.cssText = base + 'left:' + pos.l + 'px;bottom:' + pos.b + 'px;';
    };
    const ID = Math.random().toString(36).slice(2);
    host.setAttribute('popover', 'manual');
    host.setAttribute('data-fbpdf-host', ID);
    const msg = document.createElement('div');
    msg.style.cssText = 'display:none;max-width:88vw;padding:12px 16px;border-radius:16px;background:rgba(15,15,15,.95);color:#fff;font-size:17px;word-break:break-word';
    const btn = document.createElement('button');
    btn.textContent = '\u2913  Save PDF';
    btn.style.cssText = 'min-width:150px;min-height:64px;padding:16px 28px;border:0;border-radius:36px;background:#1877f2;color:#fff;font:700 22px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.5);opacity:.96;touch-action:none';
    // tap = run, drag = move the button out of the way
    let sx, sy, sl, sb, moved = false;
    btn.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; sl = pos.l; sb = pos.b; moved = false; try { btn.setPointerCapture(e.pointerId); } catch (_) {} });
    btn.addEventListener('pointermove', e => {
      if (sx === undefined) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 12) return;
      moved = true; pos.l = sl + dx; pos.b = sb - dy; place();
    });
    btn.addEventListener('pointerup', e => {
      if (sx === undefined) return; sx = undefined;
      if (moved) { try { localStorage.setItem('fbpdf_pos', JSON.stringify(pos)); } catch (_) {} return; }
      e.preventDefault(); onClick();
    });
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
    host.append(msg, btn);
    const raise = () => { // top layer sits above every Facebook dialog/popup
      try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch (e) {}
    };
    // only one live button per page, even if the add-on and the userscript are both installed
    const others = () => [...document.querySelectorAll('[data-fbpdf-host]')].filter(h => h !== host && Date.now() - (+h.dataset.beat || 0) < 5000);
    const attach = () => {
      if (host.isConnected) host.dataset.beat = Date.now();
      if (others().some(h => h.getAttribute('data-fbpdf-host') < ID)) { host.remove(); return; }
      if (!host.isConnected) {
        if (others().length) return;
        host.dataset.beat = Date.now();
        (document.body || document.documentElement).appendChild(host); place(); raise(); return;
      }
      let other = false;
      try { other = [...document.querySelectorAll(':popover-open, dialog[open]')].some(e => e !== host); } catch (e) {}
      if (other) raise();
    };
    attach(); setInterval(attach, 1200);
    addEventListener('resize', place);
    return {
      status(text, link) {
        msg.style.display = text ? 'block' : 'none';
        msg.textContent = text || '';
        if (link) {
          const a = document.createElement('a');
          a.href = link.href; a.target = '_blank'; a.rel = 'noopener'; a.download = link.name || '';
          a.textContent = ' ' + link.label; a.style.cssText = 'color:#8ab4ff;font-weight:700;text-decoration:underline;font-size:19px';
          msg.appendChild(a);
        }
        raise();
      },
      busy(b) { btn.disabled = b; btn.style.opacity = b ? '.5' : '.96'; btn.textContent = b ? '\u2026 Working' : '\u2913  Save PDF'; }
    };
  }
  const stamp = () => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return 'Facebook_Post_HD_' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
  };
  return { collect, makeUI, keyOf, stamp };
})();
/* ---- userscript glue ---- */
(() => {
  const XHR = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM) : null;

  const gmGet = url => new Promise((res, rej) => XHR({
    method: 'GET', url, responseType: 'arraybuffer', timeout: 45000,
    onload: r => {
      if (!(r.status >= 200 && r.status < 300 && r.response)) return rej(new Error('HTTP ' + r.status));
      const b = new Uint8Array(r.response); b.finalUrl = r.finalUrl; res(b);
    },
    onerror: () => rej(new Error('network')), ontimeout: () => rej(new Error('timeout'))
  }));
  const plainGet = async url => {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = new Uint8Array(await r.arrayBuffer()); b.finalUrl = r.url; return b;
  };
  async function get(url) { // GM request first (no CORS), plain fetch as failsafe
    try { if (!XHR) throw 0; return await gmGet(url); } catch (e) { return plainGet(url); }
  }
  const grab = item => retry(() => bestImage(get, item), 3);

  const ui = FBW.makeUI(run);
  const lim = limiter(4), cache = new Map();
  let busy = false, done = 0;
  const prefetch = item => {
    const k = item.fbid || FBW.keyOf(item.src);
    if (!cache.has(k)) cache.set(k, lim(() => grab(item)).then(
      v => { ui.status('Downloaded ' + (++done) + ' photo' + (done > 1 ? 's' : '') + '…'); return v; },
      e => ({ err: String(e) })));
    return cache.get(k);
  };
  function save(blob, name, label) {
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) {}
    setTimeout(() => URL.revokeObjectURL(url), 900000);
    return { href: url, name, label };
  }

  async function run() {
    if (busy) return;
    busy = true; done = 0; cache.clear(); ui.busy(true); ui.status('Starting…');
    try {
      const items = await FBW.collect(prefetch, t => ui.status(t));
      if (!items.length) return ui.status('No photos found in this post.');
      ui.status('Finishing downloads…');
      const res = await Promise.all(items.map(prefetch));
      const good = res.filter(r => r && r.bytes), bad = res.length - good.length;
      if (!good.length) return ui.status('Could not download any photo. Allow the fbcdn permission in Tampermonkey and retry.');
      const name = FBW.stamp();
      try {
        const link = save(buildPdf(good), name + '.pdf', 'Open PDF');
        const lq = good.filter(g => g.lq);
        ui.status('PDF ready: ' + good.length + ' page' + (good.length > 1 ? 's' : '') + (bad ? ' (' + bad + ' failed)' : '') + (lq.length ? ' \u2014 ' + lq.length + ' low-res (' + lq.map(g => g.w + 'x' + g.h).join(', ') + ')' : ' \u2014 all HD') + '. If it did not save, tap', link);
      } catch (e) { // failsafe: individual JPEGs
        good.forEach((g, i) => save(new Blob([g.bytes], { type: 'image/jpeg' }), name + '_' + (i + 1) + '.jpg'));
        ui.status('PDF failed (' + e.message + '); saved ' + good.length + ' JPEG files instead.');
      }
    } catch (e) {
      ui.status('Error: ' + (e && e.message || e));
    } finally { busy = false; ui.busy(false); cache.clear(); }
  }
})();
})();
