import { Readability } from '@mozilla/readability';
import DOMPurify from 'dompurify';
import type { DetectResponse, ExtractResponse, ToastMessage, WidgetInfo, WidgetRect } from './messages';

declare global {
  interface Window {
    __theCollectorDetect?: () => DetectResponse;
    __theCollectorExtract?: (screenshots: Record<string, string>) => ExtractResponse;
  }
}

const PURIFY_CONFIG = {
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'],
};

const MIN_MEDIA_DIM = 100;
const MIN_BOX_AREA = 5000;
const SCORE_THRESHOLD = 5;
// Widgets are visual-first. A container carrying this much prose is the article
// itself (or a layout wrapper), not an interactive widget. Skip it — but still
// let its descendants be considered, and honor a manual force-capture.
const LOW_TEXT_MAX = 300;

function uuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'w-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function flattenMath(doc: Document): void {
  const katexEls = doc.querySelectorAll('.katex, .katex-display');
  for (const el of katexEls) {
    const mathml = el.querySelector('.katex-mathml');
    if (mathml) el.replaceWith(mathml);
    else el.remove();
  }
}

function normalizeImages(doc: Document): void {
  // <source> outranks <img src> inside <picture>; drop it so the resolved
  // src (the only URL we download) is what actually renders.
  doc.querySelectorAll('picture source').forEach((source) => source.remove());
  const imgs = doc.querySelectorAll('img');
  for (const img of imgs) {
    const candidate =
      img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-original');
    if (candidate) {
      img.setAttribute('src', candidate);
    }
    const rawSrc = img.getAttribute('src');
    if (rawSrc) {
      try {
        img.setAttribute('src', new URL(rawSrc, location.href).href);
      } catch {
        // Leave the original value if it cannot be resolved.
      }
    }
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
  }
}

function collectImageUrls(html: string): string[] {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const urls: string[] = [];
  for (const img of tmp.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src) urls.push(src);
  }
  return urls;
}

// ---- Widget detection -------------------------------------------------------

function rectOf(el: Element): WidgetRect | null {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function isInViewport(r: WidgetRect): boolean {
  return (
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.width <= window.innerWidth &&
    r.y + r.height <= window.innerHeight
  );
}

function textLength(el: Element): number {
  return (el.textContent ?? '').trim().length;
}

// A plain single-image figure is already handled by the normal image pipeline;
// don't double-capture it as a widget.
function isSingleImageWrapper(el: Element): boolean {
  const imgs = el.querySelectorAll('img, picture');
  if (imgs.length !== 1) return false;
  const otherMedia = el.querySelectorAll('svg, canvas').length;
  return otherMedia === 0 && textLength(el) < 200;
}

function scoreElement(el: Element): number {
  let score = 0;

  const media = el.querySelectorAll('svg, canvas');
  let hasBigMedia = false;
  for (const m of media) {
    const r = m.getBoundingClientRect();
    if (r.width > MIN_MEDIA_DIM && r.height > MIN_MEDIA_DIM) {
      hasBigMedia = true;
      break;
    }
  }
  if (hasBigMedia) score += 3;

  if (el.querySelectorAll('button, [role="button"], input[type="range"]').length > 0) {
    score += 2;
  }

  const r = el.getBoundingClientRect();
  const area = r.width * r.height;
  const len = textLength(el);
  if (area > MIN_BOX_AREA && len < area / 300) {
    score += 2;
  }

  // Weak framework-root signal (internals change often; never a hard requirement).
  if (el.hasAttribute('data-reactroot') || el.querySelector('[data-reactroot]')) {
    score += 1;
  }

  return score;
}

function detectWidgets(): DetectResponse {
  const tagged = new Set<Element>();
  const widgets: WidgetInfo[] = [];

  const all = Array.from(document.body.querySelectorAll('*'));
  for (const el of all) {
    // Skip any element already inside a tagged subtree (avoid nested double-count).
    let parent = el.parentElement;
    while (parent) {
      if (tagged.has(parent)) break;
      parent = parent.parentElement;
    }
    if (parent && tagged.has(parent)) continue;

    if (el.hasAttribute('data-collector-skip')) {
      tagged.add(el);
      continue;
    }

    const forced = el.hasAttribute('data-collector-capture');
    if (!forced && textLength(el) > LOW_TEXT_MAX) continue;

    const score = forced ? SCORE_THRESHOLD + 1 : scoreElement(el);

    if (score >= SCORE_THRESHOLD) {
      if (isSingleImageWrapper(el)) continue;
      const rect = rectOf(el);
      if (!rect) {
        tagged.add(el);
        continue;
      }
      const id = uuid();
      el.setAttribute('data-collector-widget-id', id);
      tagged.add(el);
      widgets.push({ id, rect, in_viewport: isInViewport(rect) });
    }
  }

  return {
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio || 1,
    widgets,
  };
}

// ---- Extraction -------------------------------------------------------------

function extract(screenshots: Record<string, string> = {}): ExtractResponse {
  const cloned = document.cloneNode(true) as Document;

  for (const [id, src] of Object.entries(screenshots)) {
    const live = document.querySelector(`[data-collector-widget-id="${id}"]`);
    const inClone = cloned.querySelector(`[data-collector-widget-id="${id}"]`);
    if (!live || !inClone) continue;
    const img = cloned.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('alt', live.getAttribute('aria-label') ?? 'interactive widget');
    inClone.replaceWith(img);
  }
  // Remove our marker attribute from the clone (DOMPurify would strip it anyway).
  cloned
    .querySelectorAll('[data-collector-widget-id]')
    .forEach((e) => e.removeAttribute('data-collector-widget-id'));

  normalizeImages(cloned);
  flattenMath(cloned);

  const article = new Readability(cloned).parse();
  if (!article || !article.content) {
    return { ok: false, reason: 'unparseable', title: document.title || 'Untitled' };
  }

  const clean = DOMPurify.sanitize(article.content, PURIFY_CONFIG) as string;
  return {
    ok: true,
    title: article.title || document.title || 'Untitled',
    byline: article.byline ?? null,
    excerpt: article.excerpt ?? null,
    html: clean,
    url: location.href,
    images: collectImageUrls(clean),
  };
}

window.__theCollectorDetect = detectWidgets;
window.__theCollectorExtract = extract;

// ---- Save toast -------------------------------------------------------------

const TOAST_DURATION_MS = 2000;

let toastHost: HTMLDivElement | null = null;
let toastLabel: HTMLElement | null = null;
let toastHideTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(state: ToastMessage['state']): void {
  if (!document.body) return;

  if (!toastHost || !toastLabel) {
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;top:24px;right:24px;z-index:2147483647;pointer-events:none;';

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .pill {
        font: 13px/1.4 system-ui, sans-serif;
        color: #fff;
        padding: 8px 14px;
        border-radius: 999px;
        opacity: 0;
        transform: translateY(-6px);
        transition: opacity 150ms ease, transform 150ms ease;
      }
      .processing { background: #37474f; }
      .success { background: #2e7d32; }
      .error { background: #c62828; }
      .spinner {
        display: inline-block;
        width: 11px;
        height: 11px;
        margin-right: 7px;
        vertical-align: -1px;
        border: 2px solid rgba(255, 255, 255, 0.45);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 650ms linear infinite;
      }
      .show { opacity: 1; transform: translateY(0); }
      @keyframes spin { to { transform: rotate(360deg); } }
    `;
    const pill = document.createElement('div');
    pill.className = 'pill';
    shadow.append(style, pill);

    document.body.appendChild(host);
    toastHost = host;
    toastLabel = pill;
  }

  toastLabel.replaceChildren();
  if (state === 'processing') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    toastLabel.append(spinner, 'Saving article…');
  } else {
    toastLabel.textContent = state === 'success' ? 'Saved ✓' : 'Save failed';
  }
  toastLabel.classList.remove('show', 'processing', 'success', 'error');
  toastLabel.classList.add(state);
  requestAnimationFrame(() => toastLabel!.classList.add('show'));

  if (toastHideTimer !== undefined) clearTimeout(toastHideTimer);
  if (state !== 'processing') {
    toastHideTimer = setTimeout(() => toastLabel?.classList.remove('show'), TOAST_DURATION_MS);
  }
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as ToastMessage | undefined;
  if (m && m.type === 'collector-toast') showToast(m.state);
});
