const api = typeof browser !== "undefined" ? browser : chrome;
const statusEl = document.getElementById("status");
const fill = document.getElementById("fill");

function setStatus(text, ratio) {
  statusEl.textContent = text;
  if (typeof ratio === "number") fill.style.width = `${Math.max(0, Math.min(100, Math.round(ratio * 100)))}%`;
}

api.runtime.onMessage.addListener((message) => {
  if (message && message.type === "progress" && message.text) setStatus(message.text);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ping(tabId) {
  const reply = await api.tabs.sendMessage(tabId, { type: "ping" });
  if (!reply || !reply.ok) throw new Error("no content script");
}

async function injectContentScript(tabId) {
  const errors = [];
  try {
    if (api.scripting && api.scripting.executeScript) {
      await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return;
    }
  } catch (error) { errors.push(error.message); }
  try {
    if (api.tabs.executeScript) {
      await api.tabs.executeScript(tabId, { file: "content.js" });
      return;
    }
  } catch (error) { errors.push(error.message); }
  throw new Error(errors.join(" / ") || "injection API unavailable");
}

function waitForLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      api.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, timeout);
    api.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId) {
  try { await ping(tabId); return true; } catch {}
  try {
    await injectContentScript(tabId);
    await sleep(350);
    await ping(tabId);
    return true;
  } catch {}
  try {
    const loaded = waitForLoad(tabId);
    await api.tabs.reload(tabId);
    await loaded;
    await sleep(900);
    await ping(tabId);
    return true;
  } catch {}
  return false;
}

const FACEBOOK_URL = /^https:\/\/([a-z0-9-]+\.)?facebook\.com\//i;

async function targetTab() {
  const [active] = await api.tabs.query({ active: true, currentWindow: true });
  if (active && FACEBOOK_URL.test(active.url || "")) return active;
  const candidates = await api.tabs.query({ url: "*://*.facebook.com/*" });
  candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return candidates[0] || active;
}

(async () => {
  try {
    const tab = await targetTab();
    if (!tab || !FACEBOOK_URL.test(tab.url || "")) {
      setStatus("Open a Facebook post in a tab, then click the toolbar button again.");
      return;
    }
    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      setStatus("Reload the Facebook tab once, then click here again (or use the on-page PDF button).");
      return;
    }
    try { await api.tabs.update(tab.id, { active: true }); } catch {}
    await sleep(200);
    setStatus("Scanning the post's photos…", 0.05);
    const scan = await Promise.race([
      api.tabs.sendMessage(tab.id, { type: "scan" }),
      sleep(150000).then(() => { throw new Error("Scan timed out. Use the on-page PDF button instead."); })
    ]);
    if (!scan || !scan.images || !scan.images.length) {
      setStatus((scan && scan.reason) || "No photos found in the open post.");
      return;
    }
    const count = scan.images.length;
    const total = scan.total || count;
    const source = (scan.diag && scan.diag.source) || "unknown";
    if (total > 1 && count < total) {
      setStatus(`Found ${count} of ${total} photos (${source}).\nOpen the post and click any photo so the photo viewer is showing, then click this button again.`, 0.05);
      return;
    }
    setStatus(`Found ${count} photo${count === 1 ? "" : "s"} (${source}). Fetching the highest resolution Facebook has…`, 0.15);
    const result = await api.runtime.sendMessage({ type: "download", images: scan.images });
    if (!result || !result.ok) {
      setStatus(`Download failed: ${(result && result.error) || "unknown error"}`);
      return;
    }
    const failed = result.failures && result.failures.length ? `\nSkipped: ${result.failures.join("; ")}` : "";
    const quality = result.minWidth ? `\nSmallest image: ${result.minWidth}px wide.` : "";
    const where = result.how === "tab"
      ? `Opened ${result.count}-page PDF in a new tab (use its download/share button).`
      : `Saved ${result.count} photo${result.count === 1 ? "" : "s"} into one PDF in Downloads.`;
    setStatus(`${where}${quality}${failed}`, 1);
  } catch (error) {
    setStatus(`Error: ${(error && error.message) || error}`);
  }
})();
