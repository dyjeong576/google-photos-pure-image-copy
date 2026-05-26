importScripts("i18n.js");

const MENU_ID = "copy-pure-image";
const OFFSCREEN_URL = "offscreen.html";
const DEFAULT_IMAGE_QUALITY = "high";
const IMAGE_QUALITY_VALUES = new Set(["low", "normal", "high"]);
const DEFAULT_SITES = [
  {
    host: "photos.google.com",
    enabled: true
  },
  {
    host: "drive.google.com",
    enabled: true
  },
  {
    host: "www.icloud.com",
    enabled: true
  },
  {
    host: "www.instagram.com",
    enabled: true
  },
  {
    host: "www.facebook.com",
    enabled: true
  },
  {
    host: "www.notion.so",
    enabled: true
  }
];
const DEFAULT_SITES_VERSION = 2;
let setupContextMenuQueue = Promise.resolve();

setupContextMenu();

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && (changes.sites || changes.language)) {
    setupContextMenu();
  }
});

function setupContextMenu() {
  setupContextMenuQueue = setupContextMenuQueue
    .then(rebuildContextMenu)
    .catch((error) => {
      console.error(error);
    });
}

async function rebuildContextMenu() {
  const sites = await getSites();
  const language = await getLanguage();
  const patterns = sites
    .filter((site) => site.enabled)
    .flatMap((site) => getHostPatterns(site.host));

  await removeAllContextMenus();
  if (patterns.length === 0) {
    return;
  }

  await createContextMenu({
    id: MENU_ID,
    title: t(language, "menuTitle"),
    contexts: ["image"],
    documentUrlPatterns: patterns
  });
}

function removeAllContextMenus() {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.removeAll(() => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

function createContextMenu(options) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(options, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve();
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  setBadge(tab && tab.id, "...", "#5f6368");

  copyImageFromMenu(info, tab).catch((error) => {
    console.error(error);
    setBadge(tab && tab.id, "FAIL", "#c5221f");
  });
});

async function copyImageFromMenu(info, tab) {
  const tabId = tab && tab.id;

  if (!tabId || !info.srcUrl || !(await isAllowedPage(info.pageUrl))) {
    throw new Error("This menu item only supports enabled sites.");
  }

  if (!isSupportedSource(info.srcUrl)) {
    throw new Error(`Unsupported image source: ${getSourceHost(info.srcUrl)}`);
  }

  const imageQuality = await getImageQuality();

  try {
    await focusTab(tab);
    await copyViaInjectedScript(tabId, info.srcUrl, imageQuality);

    setBadge(tabId, "OK", "#188038");
  } catch (error) {
    if (error.fallbackDataUrl) {
      try {
        await focusTab(tab);
        await delay(100);
        await copyViaInjectedScript(tabId, error.fallbackDataUrl, imageQuality);
      } catch {
        await copyViaOffscreen({ dataUrl: error.fallbackDataUrl, imageQuality });
      }

      setBadge(tabId, "OK", "#188038");
      return;
    }

    if (info.srcUrl.startsWith("data:image/")) {
      await copyViaOffscreen({ dataUrl: info.srcUrl, imageQuality });
      setBadge(tabId, "OK", "#188038");
      return;
    }

    if (isHttpUrl(info.srcUrl)) {
      const dataUrl = await fetchImageAsDataUrl(info.srcUrl);
      await copyViaOffscreen({ dataUrl, imageQuality });
      setBadge(tabId, "OK", "#188038");
      return;
    }

    throw error;
  }
}

async function focusTab(tab) {
  if (tab && tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  if (tab && tab.id) {
    await chrome.tabs.update(tab.id, { active: true });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getSites() {
  const stored = await chrome.storage.sync.get(["sites", "defaultSitesVersion"]);
  if (Array.isArray(stored.sites) && stored.sites.length > 0) {
    if (stored.defaultSitesVersion !== DEFAULT_SITES_VERSION) {
      const mergedSites = mergeDefaultSites(stored.sites);
      await chrome.storage.sync.set({
        sites: mergedSites,
        defaultSitesVersion: DEFAULT_SITES_VERSION
      });
      return mergedSites;
    }

    return stored.sites;
  }

  await chrome.storage.sync.set({
    sites: DEFAULT_SITES,
    defaultSitesVersion: DEFAULT_SITES_VERSION
  });
  return DEFAULT_SITES;
}

function mergeDefaultSites(storedSites) {
  const hosts = new Set(storedSites.map((site) => site.host));
  return storedSites.concat(DEFAULT_SITES.filter((site) => !hosts.has(site.host)));
}

async function getLanguage() {
  const stored = await chrome.storage.sync.get("language");
  return I18N.messages[stored.language] ? stored.language : I18N.defaultLanguage;
}

async function getImageQuality() {
  const stored = await chrome.storage.sync.get("imageQuality");
  return IMAGE_QUALITY_VALUES.has(stored.imageQuality) ? stored.imageQuality : DEFAULT_IMAGE_QUALITY;
}

async function isAllowedPage(url) {
  try {
    const host = new URL(url).hostname;
    const sites = await getSites();
    return sites.some((site) => site.enabled && isSameSiteHost(site.host, host));
  } catch {
    return false;
  }
}

function t(language, key) {
  const messages = I18N.messages[language] || I18N.messages[I18N.defaultLanguage];
  return messages[key] || I18N.messages[I18N.defaultLanguage][key] || key;
}

function getHostPatterns(host) {
  return getRelatedHosts(host).flatMap((relatedHost) => [
    `http://${relatedHost}/*`,
    `https://${relatedHost}/*`
  ]);
}

function getRelatedHosts(host) {
  if (host.startsWith("www.")) {
    return [host, host.slice(4)];
  }

  if (host.includes(".") && !isIpAddress(host)) {
    return [host, `www.${host}`];
  }

  return [host];
}

function isSameSiteHost(host, otherHost) {
  return getRelatedHosts(host).includes(otherHost) || getRelatedHosts(otherHost).includes(host);
}

function isIpAddress(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function isSupportedSource(url) {
  if (url.startsWith("data:image/") || url.startsWith("blob:")) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getSourceHost(url) {
  try {
    return new URL(url).hostname || url.split(":")[0];
  } catch {
    return url.split(":")[0];
  }
}

function isHttpUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

async function fetchImageAsDataUrl(url) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error(`Image fetch failed: ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error(`Response is not an image: ${blob.type || "unknown"}`);
  }

  return blobToDataUrl(blob);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function copyViaOffscreen(payload) {
  await ensureOffscreenDocument();

  const result = await chrome.runtime.sendMessage({
    type: "copy-image",
    ...payload
  });

  if (!result || !result.ok) {
    throw new Error(result && result.error ? result.error : "Clipboard copy failed.");
  }
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["CLIPBOARD"],
    justification: "Write normalized PNG image data to the clipboard."
  });
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  return contexts.length > 0;
}

async function copyViaInjectedScript(tabId, srcUrl, imageQuality) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: copyImageInPage,
    args: [srcUrl, imageQuality],
    world: "MAIN"
  });

  if (!result || !result.result || !result.result.ok) {
    const message = result && result.result && result.result.error ? result.result.error : "Injected copy failed.";
    const error = new Error(message);
    if (result && result.result && result.result.dataUrl) {
      error.fallbackDataUrl = result.result.dataUrl;
    }

    throw error;
  }
}

async function copyImageInPage(srcUrl, imageQuality) {
  try {
    const response = await fetch(srcUrl, {
      cache: "no-store",
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`Image fetch failed: ${response.status}`);
    }

    const sourceBlob = await response.blob();
    const bitmap = await createImageBitmap(sourceBlob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    const pngBlob = await createSizedPngBlob(canvas, getImageQualityPreset(imageQuality));

    window.focus();
    await waitForDocumentFocus();
    if (!document.hasFocus()) {
      return {
        ok: false,
        error: "Document is not focused.",
        dataUrl: await blobToDataUrl(pngBlob)
      };
    }

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": pngBlob
        })
      ]);
    } catch (error) {
      if (isFocusError(error)) {
        return {
          ok: false,
          error: error && error.message ? error.message : String(error),
          dataUrl: await blobToDataUrl(pngBlob)
        };
      }

      throw error;
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }

  function getImageQualityPreset(value) {
    const presets = {
      low: {
        maxLongEdge: 1280,
        maxPngBytes: 5 * 1024 * 1024
      },
      normal: {
        maxLongEdge: 2560,
        maxPngBytes: 12 * 1024 * 1024
      },
      high: {
        maxLongEdge: Infinity,
        maxPngBytes: 20 * 1024 * 1024
      }
    };

    return presets[value] || presets.high;
  }

  async function createSizedPngBlob(canvas, preset) {
    let currentCanvas = resizeToMaxLongEdge(canvas, preset.maxLongEdge);
    let pngBlob = await canvasToPngBlob(currentCanvas);

    while (pngBlob.size > preset.maxPngBytes && currentCanvas.width > 1 && currentCanvas.height > 1) {
      const scale = Math.min(0.9, Math.sqrt(preset.maxPngBytes / pngBlob.size) * 0.95);
      const width = Math.max(1, Math.floor(currentCanvas.width * scale));
      const height = Math.max(1, Math.floor(currentCanvas.height * scale));

      if (width === currentCanvas.width && height === currentCanvas.height) {
        break;
      }

      currentCanvas = resizeCanvas(currentCanvas, width, height);
      pngBlob = await canvasToPngBlob(currentCanvas);
    }

    if (pngBlob.size > preset.maxPngBytes) {
      throw new Error(`PNG is too large after resize: ${pngBlob.size}`);
    }

    return pngBlob;
  }

  async function canvasToPngBlob(canvas) {
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!pngBlob) {
      throw new Error("PNG conversion failed.");
    }

    return pngBlob;
  }

  function resizeCanvas(sourceCanvas, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(sourceCanvas, 0, 0, width, height);

    return canvas;
  }

  function resizeToMaxLongEdge(canvas, maxLongEdge) {
    const longEdge = Math.max(canvas.width, canvas.height);
    if (!Number.isFinite(maxLongEdge) || longEdge <= maxLongEdge) {
      return canvas;
    }

    const scale = maxLongEdge / longEdge;
    return resizeCanvas(
      canvas,
      Math.max(1, Math.floor(canvas.width * scale)),
      Math.max(1, Math.floor(canvas.height * scale))
    );
  }

  function isFocusError(error) {
    const message = error && error.message ? error.message : String(error);
    return message.includes("Document is not focused");
  }

  async function waitForDocumentFocus() {
    for (let index = 0; index < 10 && !document.hasFocus(); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return `data:${blob.type};base64,${btoa(binary)}`;
  }
}

function setBadge(tabId, text, color) {
  if (!tabId || !chrome.action) {
    return;
  }

  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });

  if (text !== "...") {
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: "" });
    }, 2500);
  }
}
