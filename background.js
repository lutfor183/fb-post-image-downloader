const api = typeof browser !== "undefined" ? browser : chrome;

function badge(text, color) {
  try {
    api.browserAction.setBadgeText({ text: text || "" });
    if (color) api.browserAction.setBadgeBackgroundColor({ color });
  } catch {}
  try { api.runtime.sendMessage({ type: "progress", text }).catch(() => {}); } catch {}
}

function pdfName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `Facebook_Post_HD_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.pdf`;
}

const dimScore = (url) => {
  const match = String(url).match(/[sp](\d{2,5})x(\d{2,5})/);
  return match ? Math.max(Number(match[1]), Number(match[2])) : 0;
};

async function resolvePhotoPage(photoUrl) {
  const response = await fetch(photoUrl, { credentials: "include" });
  if (!response.ok) throw new Error(`photo page HTTP ${response.status}`);
  const html = (await response.text()).replace(/\\\//g, "/");
  const urls = new Set();
  for (const match of html.matchAll(/https:\/\/scontent[^"'\s\\<>]+/g)) urls.add(match[0].replace(/&amp;/g, "&"));
  const og = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  if (og) urls.add(og[1].replace(/&amp;/g, "&"));
  return [...urls].sort((a, b) => dimScore(b) - dimScore(a));
}

async function fetchImage(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type && !type.startsWith("image/")) throw new Error(`not an image (${type})`);
  const data = await response.arrayBuffer();
  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(new Blob([data], { type: type || "image/jpeg" }));
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch {}
  if (!data.byteLength) throw new Error("empty response");
  return { data, type, width, height };
}

async function loadCandidate(image) {
  const candidates = [];
  if (image.photo) {
    try { candidates.push(...(await resolvePhotoPage(image.photo)).slice(0, 4)); } catch {}
  }
  if (Array.isArray(image.urls)) candidates.push(...image.urls);
  if (image.url) candidates.push(image.url);
  const ordered = [...new Set(candidates)].filter((url) => typeof url === "string" && /^https?:/i.test(url)).slice(0, 6);
  let best = null;
  let lastError = null;
  for (const url of ordered) {
    try {
      const result = await fetchImage(url);
      if (!result.width || result.width < 300) throw new Error(`too small (${result.width || "?"}px)`);
      if (!best || result.width > best.width) best = result;
      if (result.width >= 1600) break;
    } catch (error) { lastError = error; }
  }
  if (best) return best;
  throw lastError || new Error("unavailable");
}

async function asJpeg(result) {
  const type = (result.type || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) {
    const bytes = new Uint8Array(result.data);
    const info = jpegInfo(bytes);
    return {
      bytes,
      width: (info && info.width) || result.width,
      height: (info && info.height) || result.height,
      components: (info && info.components) || 3
    };
  }
  const bitmap = await createImageBitmap(new Blob([result.data], { type: type || "image/jpeg" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, width: canvas.width, height: canvas.height, components: 3 };
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  let android = false;
  try {
    const info = await api.runtime.getPlatformInfo();
    android = info.os === "android";
  } catch {}
  const openTab = async () => { await api.tabs.create({ url, active: true }); };
  if (android) {
    try {
      await openTab();
      setTimeout(() => URL.revokeObjectURL(url), 600000);
      return { how: "tab" };
    } catch {}
  }
  try {
    await api.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return { how: "download" };
  } catch (error) {
    try {
      await openTab();
      setTimeout(() => URL.revokeObjectURL(url), 600000);
      return { how: "tab" };
    } catch {
      throw error;
    }
  }
}

async function downloadAll(images) {
  const list = [];
  const seen = new Set();
  for (const image of Array.isArray(images) ? images : []) {
    if (!image || typeof image.url !== "string") continue;
    const key = image.url.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(image);
  }
  if (!list.length) throw new Error("No photos to download.");

  const pages = [];
  const failures = [];
  let minWidth = Infinity;
  for (let i = 0; i < list.length; i++) {
    badge(`${i + 1}/${list.length}`, "#1877f2");
    try {
      const result = await loadCandidate(list[i]);
      pages.push(await asJpeg(result));
      if (result.width) minWidth = Math.min(minWidth, result.width);
    } catch (error) {
      failures.push(`${i + 1}: ${error.message}`);
    }
  }
  if (!pages.length) throw new Error(`No photo could be fetched. ${failures.join("; ")}`);

  badge("PDF", "#1877f2");
  const saved = await saveBlob(makePdf(pages), pdfName());
  const width = Number.isFinite(minWidth) ? minWidth : null;
  badge("", null);
  try { api.runtime.sendMessage({ type: "progress", text: "" }).catch(() => {}); } catch {}
  return { ok: true, count: pages.length, failures, minWidth: width, how: saved.how };
}

api.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return undefined;
  if (message.type === "download") {
    return downloadAll(message.images).catch((error) => {
      badge("", null);
      return { ok: false, error: error.message || String(error) };
    });
  }
  return undefined;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let running = false;

function notify(title, message) {
  try { api.notifications.create({ type: "basic", title, message }); } catch {}
}

async function ensureContentScript(tabId) {
  try {
    const reply = await api.tabs.sendMessage(tabId, { type: "ping" });
    if (reply && reply.ok) return true;
  } catch {}
  try {
    if (api.scripting && api.scripting.executeScript) {
      await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } else if (api.tabs.executeScript) {
      await api.tabs.executeScript(tabId, { file: "content.js" });
    }
  } catch {}
  await sleep(400);
  try {
    const reply = await api.tabs.sendMessage(tabId, { type: "ping" });
    return Boolean(reply && reply.ok);
  } catch {
    return false;
  }
}

async function chooseTab(tab) {
  const isFacebook = (url) => /^https:\/\/([a-z0-9-]+\.)?facebook\.com\//i.test(url || "");
  if (tab && isFacebook(tab.url)) return tab;
  const tabs = await api.tabs.query({ url: "*://*.facebook.com/*" });
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0] || tab;
}

async function runFromAction(tab) {
  if (running) return;
  running = true;
  try {
    const target = await chooseTab(tab);
    if (!target || !/^https:\/\/([a-z0-9-]+\.)?facebook\.com\//i.test(target.url || "")) {
      notify("Facebook Post Image Downloader", "Open a Facebook post first.");
      return;
    }
    let ready = await ensureContentScript(target.id);
    if (!ready) {
      try { await api.tabs.reload(target.id); await sleep(2500); } catch {}
      ready = await ensureContentScript(target.id);
    }
    if (!ready) {
      notify("Facebook Post Image Downloader", "Reload the Facebook tab, then click again.");
      return;
    }
    try { await api.tabs.update(target.id, { active: true }); } catch {}
    await sleep(150);
    const scan = await api.tabs.sendMessage(target.id, { type: "scan" });
    if (!scan || !scan.images || !scan.images.length) {
      notify("Facebook Post Image Downloader", (scan && scan.reason) || "No photos found.");
      return;
    }
    const result = await downloadAll(scan.images);
    if (result && result.ok) {
      notify("Facebook Post Image Downloader", result.how === "tab" ? `Opened ${result.count}-page PDF.` : `Saved ${result.count}-page PDF to Downloads.`);
    } else {
      notify("Facebook Post Image Downloader", `Failed: ${(result && result.error) || "unknown error"}`);
    }
  } catch (error) {
    notify("Facebook Post Image Downloader", `Failed: ${(error && error.message) || error}`);
  } finally {
    running = false;
  }
}

api.browserAction.onClicked.addListener((tab) => { runFromAction(tab); });
