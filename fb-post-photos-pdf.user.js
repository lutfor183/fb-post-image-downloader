// ==UserScript==
// @name         FB Post Photos to PDF (HD)
// @namespace    https://github.com/lutfor183/fb-post-image-downloader
// @version      1.5.1
// @description  Save every photo of the open Facebook post as one high-resolution PDF.
// @match        https://facebook.com/*
// @match        https://*.facebook.com/*
// @grant        GM_xmlhttpRequest
// @connect      fbcdn.net
// @connect      fbsbx.com
// @downloadURL  https://raw.githubusercontent.com/lutfor183/fb-post-image-downloader/main/fb-post-photos-pdf.user.js
// @updateURL    https://raw.githubusercontent.com/lutfor183/fb-post-image-downloader/main/fb-post-photos-pdf.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const A4 = [595.276, 841.89];

  function jpegInfo(bytes) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
          components: bytes[i + 9]
        };
      }
      i += 2 + length;
    }
    return null;
  }

  const colorSpace = (components) => (components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK" : "/DeviceRGB");

  function makePdf(images) {
    const encoder = new TextEncoder();
    const parts = [];
    let size = 0;
    const putBytes = (bytes) => { parts.push(bytes); size += bytes.length; };
    const putText = (text) => putBytes(encoder.encode(text));
    const offsets = [];

    putBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const pageBase = (index) => 3 + index * 3;
    offsets[1] = size;
    putText("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    offsets[2] = size;
    const kids = images.map((_, index) => `${pageBase(index)} 0 R`).join(" ");
    putText(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>\nendobj\n`);

    images.forEach((image, index) => {
      const pageNo = pageBase(index);
      const contentNo = pageNo + 1;
      const imageNo = pageNo + 2;
      const portrait = image.height >= image.width;
      const pageWidth = portrait ? A4[0] : A4[1];
      const pageHeight = portrait ? A4[1] : A4[0];
      const scale = Math.min(pageWidth / image.width, pageHeight / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      const x = (pageWidth - drawWidth) / 2;
      const y = (pageHeight - drawHeight) / 2;
      const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;

      offsets[pageNo] = size;
      putText(`${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 ${imageNo} 0 R >> >> /Contents ${contentNo} 0 R >>\nendobj\n`);

      const contentBytes = encoder.encode(content);
      offsets[contentNo] = size;
      putText(`${contentNo} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      putBytes(contentBytes);
      putText("endstream\nendobj\n");

      offsets[imageNo] = size;
      putText(`${imageNo} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${colorSpace(image.components)} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`);
      putBytes(image.bytes);
      putText("\nendstream\nendobj\n");
    });

    const xrefOffset = size;
    const count = 3 + images.length * 3;
    putText(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let n = 1; n < count; n++) putText(`${String(offsets[n] || 0).padStart(10, "0")} 00000 n \n`);
    putText(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return new Blob(parts, { type: "application/pdf" });
  }



  if (window.__fbPdfUser) return;
  window.__fbPdfUser = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isAndroid = /Android/i.test(navigator.userAgent);

  function shown(el) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight + 500 && r.left < innerWidth;
  }

  function blurred(el) {
    let node = el;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return true;
      const filter = getComputedStyle(node).filter;
      if (filter && filter !== "none" && filter.includes("blur")) return true;
    }
    return false;
  }

  const urlOf = (img) => (img ? img.currentSrc || img.src || img.getAttribute("src") || null : null);

  const keyOf = (url) => {
    try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return url; }
  };

  function imageArea(img) {
    const r = img.getBoundingClientRect();
    return r.width * r.height;
  }

  function mainImage(root) {
    let best = null;
    let bestArea = 0;
    for (const img of root.querySelectorAll("img")) {
      if (!shown(img) || blurred(img)) continue;
      if (!img.currentSrc && !img.src) continue;
      const area = imageArea(img);
      if (area < 40000) continue;
      if (area > bestArea) { bestArea = area; best = img; }
    }
    return best;
  }

  function parseSrcset(value) {
    const out = [];
    for (const part of String(value || "").split(",")) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0] || !/^https?:/i.test(bits[0])) continue;
      const descriptor = bits[1] || "";
      let weight = 0;
      if (/^\d+w$/.test(descriptor)) weight = Number.parseInt(descriptor, 10);
      else if (/^\d+(\.\d+)?x$/.test(descriptor)) weight = Number.parseFloat(descriptor) * 1000;
      else weight = Number.parseInt(descriptor, 10) || 0;
      out.push({ url: bits[0], weight });
    }
    return out.sort((a, b) => b.weight - a.weight).map((entry) => entry.url);
  }

  function candidatesFor(img) {
    if (!img) return [];
    const list = [
      ...parseSrcset(img.getAttribute("srcset")),
      img.currentSrc,
      img.src,
      img.getAttribute("data-src")
    ];
    return [...new Set(list.filter((url) => typeof url === "string" && /^https?:/i.test(url)))];
  }

  function postDialog() {
    let best = null;
    let bestArea = 0;
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!shown(dialog)) continue;
      if (!dialog.querySelector('a[href*="fbid="], a[href*="/photo"], a[href*="/photos/"], img[data-visualcompletion]')) continue;
      const area = imageArea(dialog);
      if (area > bestArea) { bestArea = area; best = dialog; }
    }
    return best;
  }

  function postScope() {
    const dialog = postDialog();
    if (dialog) return dialog;
    let best = document.body;
    let bestScore = 0;
    for (const article of document.querySelectorAll('[role="article"]')) {
      const r = article.getBoundingClientRect();
      if (r.width < 250 || !shown(article)) continue;
      const score = Math.min(r.height, innerHeight) * (article.querySelector('a[href*="fbid="], a[href*="/photo"], a[href*="/photos/"]') ? 3 : 1);
      if (score > bestScore) { bestScore = score; best = article; }
    }
    return best;
  }

  function isPhotoLink(anchor) {
    if (anchor.closest('header, nav, [role="banner"], [role="complementary"], [role="navigation"]')) return false;
    const label = `${anchor.getAttribute("aria-label") || ""} ${(anchor.closest("[aria-label]") || anchor).getAttribute("aria-label") || ""}`;
    if (/stor|reel|suggest|sponsor/i.test(label)) return false;
    try {
      const url = new URL(anchor.href, location.href);
      return /(^|\.)facebook\.com$/i.test(url.hostname) &&
        (url.searchParams.has("fbid") || /\/(photo|photos|media)\b/i.test(url.pathname));
    } catch { return false; }
  }

  function photoAnchors(scope) {
    const anchors = [...scope.querySelectorAll("a[href]")].filter(isPhotoLink);
    return anchors.filter((a) => {
      const img = a.querySelector("img");
      const r = img && img.getBoundingClientRect();
      return r && r.width >= 100 && r.height >= 80;
    });
  }

  function press(key) {
    const code = key === "ArrowRight" ? 39 : key === "ArrowLeft" ? 37 : 27;
    const opts = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true };
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", opts));
      document.dispatchEvent(new KeyboardEvent("keyup", opts));
    } catch {}
  }

  function control(root, direction) {
    for (const el of root.querySelectorAll('[aria-label],[title],[role="button"],button,a')) {
      const name = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.trim().toLowerCase();
      if (!name || name.length > 60) continue;
      if (!new RegExp(`\\b${direction}\\b`, "i").test(name)) continue;
      if (/stor|reel|comment|reaction|share|send|like|menu|close|mute|volume|play|pause|hide/i.test(name)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      return el;
    }
    return null;
  }

  function edgeControl(root, side) {
    const box = root.getBoundingClientRect();
    const targetX = side === "right" ? box.right - 40 : box.left + 40;
    const targetY = box.top + box.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const el of root.querySelectorAll('[role="button"],button,a,div[tabindex]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;
      if (Math.abs(r.left + r.width / 2 - targetX) > 120) continue;
      if (Math.abs(r.top + r.height / 2 - targetY) > box.height * 0.32) continue;
      if (getComputedStyle(el).cursor !== "pointer" && el.tagName !== "A" && el.tagName !== "BUTTON") continue;
      const distance = Math.abs(r.top + r.height / 2 - targetY) + Math.abs(r.left + r.width / 2 - targetX) / 4;
      if (distance < bestDistance) { bestDistance = distance; best = el; }
    }
    return best;
  }

  function counter(root) {
    const text = root.innerText || "";
    let m = text.match(/(\d{1,3})\s+of\s+(\d{1,3})/i);
    if (!m && root !== document.body) m = text.match(/(\d{1,3})\s*\/\s*(\d{1,3})/i);
    return m ? { cur: Number(m[1]), total: Number(m[2]) } : null;
  }

  function viewerCandidate(root) {
    const img = mainImage(root);
    if (!img) return null;
    const count = counter(root);
    const nav = control(root, "next") || control(root, "previous");
    const label = (root.getAttribute("aria-label") || "").toLowerCase();
    const r = root.getBoundingClientRect();
    let score = (r.width * r.height) / 1000;
    if (count) score += 2e6;
    if (/photo|media/i.test(label)) score += 1e6;
    if (nav) score += 5e5;
    if (!count && !/photo|media/i.test(label)) return null;
    return { root, img, count, score };
  }

  function findViewer() {
    let best = null;
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!shown(dialog)) continue;
      const candidate = viewerCandidate(dialog);
      if (candidate && (!best || candidate.score > best.score)) best = candidate;
    }
    if (best) return best;
    if (/\/(photo|photos|media)(\.php)?(\/|$)/i.test(location.pathname)) {
      const candidate = viewerCandidate(document.body);
      if (candidate) return candidate;
    }
    return null;
  }

  async function waitMainChange(root, before, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      await sleep(90);
      const url = urlOf(mainImage(root));
      if (url && url !== before) return url;
    }
    return null;
  }

  async function settle(root, quiet = 500, timeout = 3000) {
    let last = urlOf(mainImage(root));
    let since = Date.now();
    const started = Date.now();
    while (Date.now() - started < timeout) {
      await sleep(100);
      const url = urlOf(mainImage(root));
      if (url !== last) { last = url; since = Date.now(); }
      else if (last && Date.now() - since >= quiet) break;
    }
    return last;
  }

  function swipe(root) {
    const target = mainImage(root) || root;
    const r = target.getBoundingClientRect();
    if (!r.width) return;
    const y = r.top + r.height / 2;
    const from = r.left + r.width * 0.82;
    const to = r.left + r.width * 0.18;
    const touch = (x, type) => {
      try {
        const hasTouch = typeof Touch === "function";
        if (hasTouch && typeof TouchEvent === "function") {
          const point = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
          const list = type === "touchend" ? [] : [point];
          target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: [point] }));
          return;
        }
      } catch {}
      try {
        target.dispatchEvent(new PointerEvent(type.replace("touch", "pointer"), {
          bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "touch", isPrimary: true
        }));
      } catch {}
    };
    touch(from, "touchstart");
    for (let i = 1; i <= 6; i++) touch(from + ((to - from) * i) / 6, "touchmove");
    touch(to, "touchend");
  }

  async function clickNext(root) {
    const before = urlOf(mainImage(root));
    if (!before) return null;
    const button = control(root, "next");
    if (button) {
      button.click();
      const changed = await waitMainChange(root, before, isAndroid ? 1800 : 2500);
      if (changed) return changed;
    }
    const edge = edgeControl(root, "right");
    if (edge && edge !== button) {
      edge.click();
      const changed = await waitMainChange(root, before, isAndroid ? 1800 : 2500);
      if (changed) return changed;
    }
    return null;
  }

  async function advance(root) {
    const before = urlOf(mainImage(root));
    if (!before) return null;
    if (isAndroid) {
      const clicked = await clickNext(root);
      if (clicked) return clicked;
      press("ArrowRight");
      let changed = await waitMainChange(root, before, 1200);
      if (changed) return changed;
      swipe(root);
      return waitMainChange(root, before, 2200);
    }
    press("ArrowRight");
    const keyed = await waitMainChange(root, before, 2500);
    if (keyed) return keyed;
    const clicked = await clickNext(root);
    if (clicked) return clicked;
    swipe(root);
    return waitMainChange(root, before, 2200);
  }

  async function rewind(root, steps) {
    for (let i = 0; i < steps; i++) {
      const before = urlOf(mainImage(root));
      if (!before) return;
      const button = control(root, "previous");
      if (button) button.click(); else press("ArrowLeft");
      if (!(await waitMainChange(root, before, 1200))) return;
    }
  }

  async function openViewer() {
    const startedPath = location.pathname + location.search;
    const scope = postScope();
    const anchors = photoAnchors(scope);
    const anchor = anchors[0];
    if (anchor) {
      const target = anchor.getAttribute("target");
      if (target) anchor.removeAttribute("target");
      anchor.click();
      if (target) setTimeout(() => { try { anchor.setAttribute("target", target); } catch {} }, 1500);
    } else {
      const img = mainImage(scope);
      if (img) img.click();
    }
    for (let i = 0; i < 90; i++) {
      await sleep(100);
      const viewer = findViewer();
      if (viewer) {
        await sleep(500);
        return { viewer, navigated: location.pathname + location.search !== startedPath, opened: true };
      }
    }
    return { viewer: null, navigated: location.pathname + location.search !== startedPath, opened: true };
  }

  async function sweep(viewer, onProgress) {
    const root = viewer.root;
    const out = [];
    const seen = new Set();
    for (let step = 0; step < 40; step++) {
      await settle(root, step === 0 ? 600 : 350, step === 0 ? 3000 : 2500);
      const urls = candidatesFor(mainImage(root));
      if (!urls.length) break;
      const key = keyOf(urls[0]);
      if (seen.has(key)) break;
      seen.add(key);
      out.push({ urls, url: urls[0], pos: out.length + 1 });
      if (onProgress) onProgress(out.length);
      if (!(await advance(root))) break;
    }
    return out;
  }

  async function harvest() {
    const response = await fetch(location.href, { credentials: "include" });
    if (!response.ok) return [];
    const text = (await response.text()).replace(/\\\//g, "/").replace(/&amp;/g, "&");
    const found = [];
    const seen = new Set();
    const add = (url) => {
      if (!/^https:\/\/scontent/i.test(url)) return;
      const key = keyOf(url);
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ urls: [url], url, pos: found.length + 1, harvested: true });
    };
    for (const m of text.matchAll(/"image":\{"uri":"(https:\/\/scontent[^"]+)","width":(\d+),"height":(\d+)/g)) {
      if (Number(m[2]) >= 400) add(m[1]);
    }
    for (const m of text.matchAll(/"photo_image":\{"uri":"(https:\/\/scontent[^"]+)"/g)) add(m[1]);
    for (const m of text.matchAll(/"uri":"(https:\/\/scontent[^"]+?)"[^}]{0,160}?"width":(\d+)/g)) {
      if (Number(m[2]) >= 700) add(m[1]);
    }
    return found;
  }

  function fallbackImages() {
    const scope = postScope();
    const out = [];
    const seen = new Set();
    for (const anchor of photoAnchors(scope)) {
      const url = new URL(anchor.href, location.href);
      const fbid = url.searchParams.get("fbid");
      if (!fbid) continue;
      const img = anchor.querySelector("img");
      const urls = candidatesFor(img);
      if (!urls.length) continue;
      const key = keyOf(urls[0]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ urls, url: urls[0], pos: out.length + 1, photo: url.href });
    }
    if (!out.length) {
      for (const img of scope.querySelectorAll("img")) {
        if (!shown(img) || blurred(img)) continue;
        const urls = candidatesFor(img);
        if (!urls.length || imageArea(img) < 30000) continue;
        const key = keyOf(urls[0]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ urls, url: urls[0], pos: out.length + 1 });
      }
    }
    return out;
  }

  let busy = false;
  async function scan(onProgress) {
    if (busy) throw new Error("A scan is already running.");
    busy = true;
    const diag = { source: "none", viewer: false, anchors: 0, total: null };
    try {
      const scope = postScope();
      diag.anchors = photoAnchors(scope).length;
      let viewer = findViewer();
      let opened = false;
      let navigated = false;
      if (viewer) diag.viewer = true;
      if (!viewer) {
        const result = await openViewer();
        viewer = result.viewer;
        opened = result.opened;
        navigated = result.navigated;
        diag.viewer = Boolean(viewer);
      }
      let images = [];
      if (viewer) {
        diag.source = "viewer";
        images = await sweep(viewer, onProgress);
        if (opened) {
          press("Escape");
          await sleep(500);
          if (navigated && /\/(photo|photos|media)(\.php)?(\/|$)/i.test(location.pathname)) {
            history.back();
            await sleep(1200);
          }
        }
      }
      if (!images.length) {
        images = fallbackImages();
        if (images.length) diag.source = "thumbnails";
      }
      return {
        images,
        total: images.length,
        reason: images.length ? null : "No photos found. Open the post itself, then click the button again.",
        diag
      };
    } finally {
      busy = false;
    }
  }

  let uiTimer = null;
  function ensureUi() {
    if (document.getElementById("fbhd-launcher")) return;
    let show = false;
    try {
      show = photoAnchors(postScope()).length > 0 ||
        document.querySelectorAll('a[href*="fbid="], a[href*="/photo"]').length > 0 ||
        Boolean(findViewer());
    } catch {}
    if (!show) return;
    const host = document.createElement("div");
    host.id = "fbhd-launcher";
    host.style.cssText = "position:fixed;left:14px;bottom:14px;z-index:2147483647;display:flex;align-items:center;gap:8px;font:13px/1.3 system-ui,sans-serif;";
    const statusEl = document.createElement("span");
    statusEl.style.cssText = "display:none;max-width:56vw;background:rgba(0,0,0,.82);color:#fff;padding:6px 10px;border-radius:8px;";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "⤓ PDF";
    button.title = "Download this post's photos as one PDF";
    button.style.cssText = "all:unset;cursor:pointer;background:#1877f2;color:#fff;padding:9px 14px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,.35);font:600 13px system-ui,sans-serif;";
    button.addEventListener("click", () => runFromPage(button, statusEl));
    host.append(statusEl, button);
    document.documentElement.appendChild(host);
  }
  function checkUi() {
    try { if (!document.getElementById("fbhd-launcher")) ensureUi(); } catch {}
    clearTimeout(uiTimer);
    uiTimer = setTimeout(checkUi, 5000);
  }
  async function runFromPage(button, statusEl) {
    const say = (text) => { statusEl.textContent = text || ""; statusEl.style.display = text ? "inline-block" : "none"; };
    if (busy) return;
    let keepStatus = false;
    button.disabled = true;
    button.style.opacity = ".6";
    try {
      say("Scanning…");
      const result = await scan((found) => say(`Scanning… ${found} photo${found === 1 ? "" : "s"}`));
      if (!result.images.length) { say(result.reason || "No photos found."); return; }
      say(`Found ${result.images.length}. Building PDF…`);
      const saved = await saveImagesAsPdf(result.images, (text) => say(text));
      if (!saved || !saved.ok) { say(`Failed: ${(saved && saved.error) || "unknown error"}`); return; }
      if (saved.how === "link") {
        statusEl.textContent = "";
        const link = document.createElement("a");
        link.href = saved.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = `Open PDF (${saved.count} pages)`;
        link.style.cssText = "color:#fff;text-decoration:underline";
        statusEl.appendChild(link);
        statusEl.style.display = "inline-block";
        keepStatus = true;
      } else {
        say(`Saved PDF (${saved.count} pages).`);
      }
    } catch (error) {
      say(`Error: ${(error && error.message) || error}`);
    } finally {
      button.disabled = false;
      button.style.opacity = "1";
      if (!keepStatus) setTimeout(() => say(""), 10000);
    }
  }
  setTimeout(checkUi, 1500);

  function showStatus(text) {
    const host = document.getElementById("fbhd-launcher");
    const span = host && host.querySelector("span");
    if (!span) return;
    span.textContent = text || "";
    span.style.display = text ? "inline-block" : "none";
  }


  function pdfName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `Facebook_Post_HD_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.pdf`;
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: "arraybuffer",
          timeout: 60000,
          onload: (response) => {
            const headers = response.responseHeaders || "";
            const match = headers.match(/content-type:\s*([^\r\n;]+)/i);
            const type = match ? match[1].trim().toLowerCase() : "image/jpeg";
            if (response.status >= 200 && response.status < 300 && response.response && response.response.byteLength) {
              resolve({ buffer: response.response, type });
            } else {
              reject(new Error(`HTTP ${response.status}`));
            }
          },
          onerror: () => reject(new Error("network error")),
          ontimeout: () => reject(new Error("timeout"))
        });
      } catch (error) { reject(error); }
    });
  }

  async function toJpegPage(buffer, type) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const info = jpegInfo(bytes) || {};
      return { bytes, width: info.width || 0, height: info.height || 0, components: info.components || 3 };
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type: type || "image/jpeg" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
    const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return { bytes: out, width: canvas.width, height: canvas.height, components: 3 };
  }

  function triggerDownload(url, name) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function saveImagesAsPdf(images, progress) {
    const report = typeof progress === "function" ? progress : () => {};
    const pages = [];
    const failures = [];
    for (let i = 0; i < images.length; i++) {
      report(`Downloading ${i + 1}/${images.length}…`);
      const image = images[i] || {};
      const urls = [...new Set([...(Array.isArray(image.urls) ? image.urls : []), image.url].filter((u) => typeof u === "string" && /^https?:/i.test(u)))].slice(0, 4);
      let done = false;
      for (const url of urls) {
        try {
          const response = await gmFetch(url);
          const page = await toJpegPage(response.buffer, response.type);
          if (!page.width || page.width < 300) throw new Error(`too small (${page.width || "?"}px)`);
          pages.push(page);
          done = true;
          break;
        } catch (error) { failures.push(`${i + 1}: ${error.message}`); }
      }
      if (!done) continue;
    }
    if (!pages.length) throw new Error(`No photo could be fetched. ${failures.slice(0, 3).join("; ")}`);
    report("Building PDF…");
    const name = pdfName();
    const url = URL.createObjectURL(makePdf(pages));
    triggerDownload(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 600000);
    return { ok: true, count: pages.length, failures, how: isAndroid ? "link" : "download", url };
  }

})();
