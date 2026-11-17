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
  const url = URL.createObjectURL(makePdf(pages));
  try {
    await api.downloads.download({ url, filename: pdfName(), saveAs: false, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
  const width = Number.isFinite(minWidth) ? minWidth : null;
  badge("", null);
  try { api.runtime.sendMessage({ type: "progress", text: "" }).catch(() => {}); } catch {}
  return { ok: true, count: pages.length, failures, minWidth: width };
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
