const DEFAULT_IMAGE_QUALITY = "high";
const IMAGE_QUALITY_PRESETS = {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "copy-image") {
    return false;
  }

  copyImage(message)
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    });

  return true;
});

async function copyImage(message) {
  const sourceBlob = await loadImageBlob(message);
  const image = await convertImage(sourceBlob, message.imageQuality);

  await writeImageToClipboard(image);

  return {
    ok: true,
    size: image.pngBlob.size
  };
}

async function writeImageToClipboard(image) {
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": image.pngBlob
    })
  ]);
}

async function loadImageBlob(message) {
  if (message.dataUrl) {
    const response = await fetch(message.dataUrl);
    return response.blob();
  }

  if (message.srcUrl) {
    const response = await fetch(message.srcUrl, {
      cache: "no-store",
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`Image fetch failed: ${response.status}`);
    }

    return response.blob();
  }

  throw new Error("No image payload was provided.");
}

async function convertImage(blob, imageQuality) {
  if (!blob.type.startsWith("image/")) {
    throw new Error(`Payload is not an image: ${blob.type || "unknown"}`);
  }

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const pngBlob = await createSizedPngBlob(canvas, getImageQualityPreset(imageQuality));

  return {
    pngBlob
  };
}

function getImageQualityPreset(value) {
  return IMAGE_QUALITY_PRESETS[value] || IMAGE_QUALITY_PRESETS[DEFAULT_IMAGE_QUALITY];
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
