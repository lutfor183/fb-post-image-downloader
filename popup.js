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

async function injectContentScript(tabId) {
  if (api.scripting && api.scripting.executeScript) {
    await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } else {
    await api.tabs.executeScript(tabId, { file: "content.js" });
  }
}

async function ensureContentScript(tabId) {
  try {
    await api.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await injectContentScript(tabId);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/([a-z0-9-]+\.)?facebook\.com\//i.test(tab.url || "")) {
      setStatus("Open a Facebook post in this tab, then click the toolbar button again.");
      return;
    }
    await ensureContentScript(tab.id);
    setStatus("Scanning the post's photos…", 0.05);
    const scan = await api.tabs.sendMessage(tab.id, { type: "scan" });
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
    setStatus(`Saved ${result.count} photo${result.count === 1 ? "" : "s"} into one PDF in Downloads.${quality}${failed}`, 1);
  } catch (error) {
    setStatus(`Error: ${(error && error.message) || error}`);
  }
})();
