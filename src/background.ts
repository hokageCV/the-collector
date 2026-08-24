import {
  getArticleByUrl,
  listArticles,
  saveArticle,
  saveImage,
  type ArticleRecord,
} from './db/db';
import type {
  DetectResponse,
  ExtractResponse,
  ProgressMessage,
  SaveArticleRequest,
  SaveArticleResponse,
  ToastMessage,
  WidgetInfo,
} from './messages';

const MAX_IMAGE_WIDTH = 1600;
const CAPTURE_SPACING_MS = 450;
const SCROLL_SETTLE_MS = 200;
// Avoid flashing feedback for quick saves, while reassuring users before a
// noticeably slow save feels unresponsive.
const PROCESSING_TOAST_DELAY_MS = 250;

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? 'img';
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'article';
}

function uniqueSlug(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportProgress(text: string): void {
  try {
    const p = chrome.runtime.sendMessage({ type: 'collector-progress', text } as ProgressMessage);
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      (p as Promise<unknown>).catch(() => {});
    }
  } catch {
    // No receiver (popup closed) — progress is best-effort.
  }
}

async function fetchImage(url: string): Promise<{ blob: Blob; mime: string }> {
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
  const blob = await resp.blob();
  const mime = blob.type || 'image/jpeg';

  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width > MAX_IMAGE_WIDTH) {
      const scale = MAX_IMAGE_WIDTH / bitmap.width;
      const w = MAX_IMAGE_WIDTH;
      const h = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
        return { blob: out, mime: 'image/jpeg' };
      }
    }
    bitmap.close();
  } catch {
    // Not decodable as a bitmap; store the original blob as-is.
  }
  return { blob, mime };
}

async function makePlaceholderImage(): Promise<{ blob: Blob; mime: string }> {
  const canvas = new OffscreenCanvas(800, 450);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = '#e8eaed';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#bdc1c6';
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, mime: 'image/png' };
}

async function fetchAndStoreImages(
  urls: string[],
  articleId: string,
): Promise<Map<string, string>> {
  const replacements = new Map<string, string>();
  for (const url of urls) {
    try {
      const { blob, mime } = await fetchImage(url);
      const key = crypto.randomUUID();
      const local = `images/${key}.${extForMime(mime)}`;
      await saveImage({ key, article_id: articleId, original_src: url, blob, mime_type: mime });
      replacements.set(url, local);
    } catch {
      // Unfetchable image: swap in a stored placeholder so nothing stays remote.
      try {
        const { blob, mime } = await makePlaceholderImage();
        const key = crypto.randomUUID();
        const local = `images/${key}.${extForMime(mime)}`;
        await saveImage({ key, article_id: articleId, original_src: url, blob, mime_type: mime });
        replacements.set(url, local);
      } catch {
        // Could not even store a placeholder; leave the remote URL as-is.
      }
    }
  }
  return replacements;
}

function rewriteHtml(html: string, replacements: Map<string, string>): string {
  let out = html;
  for (const [url, local] of replacements) {
    // Serialized attribute values escape '&' to '&amp;'; match both forms.
    out = out.split(url.replace(/&/g, '&amp;')).join(local);
    out = out.split(url).join(local);
  }
  return out;
}

// ---- Widget screenshot capture (Phase 2) ------------------------------------

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

// captureVisibleTab only captures the current viewport at devicePixelRatio.
// Taller-than-viewport widgets are cropped to what fits (known limitation).
async function captureWidget(
  tabId: number,
  windowId: number,
  widget: WidgetInfo,
  dpr: number,
): Promise<string | null> {
  let rect = widget.rect;

  if (!widget.in_viewport) {
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: (id: string) => {
          const el = document.querySelector(`[data-collector-widget-id="${id}"]`);
          if (el) el.scrollIntoView({ block: 'center' });
        },
        args: [widget.id],
      })
      .catch(() => {});
    await delay(SCROLL_SETTLE_MS);

    const measured = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: (id: string) => {
          const el = document.querySelector(`[data-collector-widget-id="${id}"]`);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        },
        args: [widget.id],
      })
      .catch(() => null);
    const remeasured = measured && measured[0] ? (measured[0].result as WidgetRect | null) : null;
    if (!remeasured) return null;
    rect = remeasured;
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const sx = Math.max(0, Math.floor(rect.x * dpr));
  const sy = Math.max(0, Math.floor(rect.y * dpr));
  const sw = Math.min(bitmap.width - sx, Math.ceil(rect.width * dpr));
  const sh = Math.min(bitmap.height - sy, Math.ceil(rect.height * dpr));
  if (sw <= 0 || sh <= 0) {
    bitmap.close();
    return null;
  }

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const out = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(out);
}

type WidgetRect = { x: number; y: number; width: number; height: number };

async function handleSave(req: SaveArticleRequest): Promise<SaveArticleResponse> {
  if (typeof req.tabId !== 'number') {
    return { ok: false, reason: 'missing tabId' };
  }

  const tab = await chrome.tabs.get(req.tabId).catch(() => null);
  if (!tab) return { ok: false, reason: 'tab not found' };
  const windowId = tab.windowId;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: req.tabId },
      files: ['content-script.js'],
    });
  } catch (err) {
    return { ok: false, reason: `inject failed: ${String(err)}` };
  }

  let detect: DetectResponse;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: req.tabId },
      func: () => window.__theCollectorDetect!(),
    });
    detect = result[0].result as DetectResponse;
  } catch (err) {
    return { ok: false, reason: `detect failed: ${String(err)}` };
  }

  const screenshots: Record<string, string> = {};
  for (let i = 0; i < detect.widgets.length; i++) {
    const widget = detect.widgets[i];
    reportProgress(`Capturing widget ${i + 1} of ${detect.widgets.length}…`);
    try {
      const shot = await captureWidget(req.tabId, windowId, widget, detect.dpr);
      if (shot) screenshots[widget.id] = shot;
    } catch {
      // Skip this widget; it falls back to DOMPurify's text-soup behavior.
    }
    await delay(CAPTURE_SPACING_MS);
  }

  // Restore the original scroll position after capture.
  await chrome.scripting
    .executeScript({
      target: { tabId: req.tabId },
      func: (s: { x: number; y: number }) => window.scrollTo(s.x, s.y),
      args: [detect.scroll],
    })
    .catch(() => {});

  let extract: ExtractResponse;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: req.tabId },
      func: (sc: Record<string, string>) => window.__theCollectorExtract!(sc),
      args: [screenshots],
    });
    extract = result[0].result as ExtractResponse;
  } catch (err) {
    return { ok: false, reason: `extract failed: ${String(err)}` };
  }

  if (!extract.ok || !extract.html || !extract.url) {
    return {
      ok: false,
      reason: `invalid extract payload (${extract?.reason ?? 'missing fields'})`,
    };
  }

  const existing = req.overwriteId ? await getArticleByUrl(extract.url) : undefined;
  const articleId = req.overwriteId ?? existing?.id ?? crypto.randomUUID();

  const replacements = await fetchAndStoreImages(extract.images ?? [], articleId);
  const html = rewriteHtml(extract.html, replacements);

  const articles = await listArticles();
  let slug: string;
  let order: number;
  if (existing) {
    slug = existing.slug;
    order = existing.order_index;
  } else {
    slug = uniqueSlug(slugify(extract.title), articles.map((a) => a.slug));
    order = articles.length ? Math.max(...articles.map((a) => a.order_index)) + 1 : 0;
  }

  const record: ArticleRecord = {
    id: articleId,
    url: extract.url,
    title: extract.title,
    byline: extract.byline ?? null,
    excerpt: extract.excerpt ?? null,
    html,
    slug,
    saved_at: Date.now(),
    order_index: order,
  };
  await saveArticle(record);
  return { ok: true, articleId };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'save') {
    handleSave(msg as SaveArticleRequest)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, reason: String(err) }));
    return true;
  }
  return false;
});

function flashBadge(ok: boolean): void {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#2e7d32' : '#c62828' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
}

function sendToast(tabId: number, state: ToastMessage['state']): void {
  const msg: ToastMessage = { type: 'collector-toast', state };
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'save-article') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (typeof tab?.id !== 'number') return;
    const tabId = tab.id;
    const processingTimer = setTimeout(
      () => sendToast(tabId, 'processing'),
      PROCESSING_TOAST_DELAY_MS,
    );

    handleSave({ type: 'save', tabId: tab.id })
      .then((resp) => {
        clearTimeout(processingTimer);
        flashBadge(resp.ok);
        sendToast(tabId, resp.ok ? 'success' : 'error');
      })
      .catch(() => {
        clearTimeout(processingTimer);
        flashBadge(false);
        sendToast(tabId, 'error');
      });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[the-collector] installed');
});
