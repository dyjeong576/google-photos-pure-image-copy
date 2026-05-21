const MENU_ID = "copy-pure-image";
const OFFSCREEN_URL = "offscreen.html";
const GOOGLE_PHOTOS_HOST = "photos.google.com";

setupContextMenu();

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "순수 이미지로 복사",
      contexts: ["image"],
      documentUrlPatterns: ["https://photos.google.com/*"]
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

  if (!tabId || !isGooglePhotosPage(info.pageUrl) || !info.srcUrl) {
    throw new Error("This menu item only supports Google Photos images.");
  }

  if (!isSupportedSource(info.srcUrl)) {
    throw new Error(`Unsupported image source: ${getSourceHost(info.srcUrl)}`);
  }

  try {
    await focusTab(tab);
    await copyViaInjectedScript(tabId, info.srcUrl);

    setBadge(tabId, "OK", "#188038");
  } catch (error) {
    if (isFocusError(error)) {
      throw error;
    }

    if (isHttpUrl(info.srcUrl)) {
      const dataUrl = await fetchImageAsDataUrl(info.srcUrl);
      await copyViaOffscreen({ dataUrl });
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

function isFocusError(error) {
  const message = error && error.message ? error.message : String(error);
  return message.includes("Document is not focused");
}

function isGooglePhotosPage(url) {
  try {
    return new URL(url).hostname === GOOGLE_PHOTOS_HOST;
  } catch {
    return false;
  }
}

function isSupportedSource(url) {
  if (url.startsWith("data:image/") || url.startsWith("blob:")) {
    return true;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (
      parsed.hostname.endsWith(".googleusercontent.com") ||
      parsed.hostname.endsWith(".usercontent.google.com")
    );
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
  return url.startsWith("https://");
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

async function copyViaInjectedScript(tabId, srcUrl) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: copyImageInPage,
    args: [srcUrl],
    world: "MAIN"
  });

  if (!result || !result.result || !result.result.ok) {
    const message = result && result.result && result.result.error ? result.result.error : "Injected copy failed.";
    throw new Error(message);
  }
}

async function copyImageInPage(srcUrl) {
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

    const pngBlob = await createSizedPngBlob(canvas);

    window.focus();
    if (!document.hasFocus()) {
      throw new Error("Document is not focused.");
    }

    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": pngBlob
      })
    ]);

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }

  async function createSizedPngBlob(canvas) {
    const maxPngBytes = 4.9 * 1024 * 1024;
    let currentCanvas = canvas;
    let pngBlob = await canvasToPngBlob(currentCanvas);

    while (pngBlob.size > maxPngBytes && currentCanvas.width > 1 && currentCanvas.height > 1) {
      const scale = Math.min(0.9, Math.sqrt(maxPngBytes / pngBlob.size) * 0.95);
      const width = Math.max(1, Math.floor(currentCanvas.width * scale));
      const height = Math.max(1, Math.floor(currentCanvas.height * scale));

      if (width === currentCanvas.width && height === currentCanvas.height) {
        break;
      }

      currentCanvas = resizeCanvas(currentCanvas, width, height);
      pngBlob = await canvasToPngBlob(currentCanvas);
    }

    if (pngBlob.size > maxPngBytes) {
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
