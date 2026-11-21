(() => {
  if (window.__fbHdDownloader) return;
  window.__fbHdDownloader = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let isAndroid = false;
  try { browser.runtime.getPlatformInfo().then((info) => { isAndroid = info.os === "android"; }).catch(() => {}); } catch {}

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
    button.disabled = true;
    button.style.opacity = ".6";
    try {
      say("Scanning…");
      const result = await scan((found) => say(`Scanning… ${found} photo${found === 1 ? "" : "s"}`));
      if (!result.images.length) { say(result.reason || "No photos found."); return; }
      say(`Found ${result.images.length}. Building PDF…`);
      const saved = await browser.runtime.sendMessage({ type: "download", images: result.images });
      if (!saved || !saved.ok) { say(`Failed: ${(saved && saved.error) || "unknown error"}`); return; }
      say(saved.how === "tab" ? `Opened PDF (${saved.count} pages).` : `Saved PDF (${saved.count} pages).`);
    } catch (error) {
      say(`Error: ${(error && error.message) || error}`);
    } finally {
      button.disabled = false;
      button.style.opacity = "1";
      setTimeout(() => say(""), 10000);
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

  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "progress-page") { if (message.text) showStatus(message.text); return undefined; }
    if (message.type === "ping") return Promise.resolve({ ok: true });
    if (message.type === "scan") return scan().catch((error) => ({ images: [], reason: error.message || String(error), diag: { source: "error" } }));
    return undefined;
  });
})();
