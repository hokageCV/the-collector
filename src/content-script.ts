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

function flattenCaptionLinks(doc: Document): void {
  // Readability deletes any div with link density above 0.2. A caption like
  // "Image credit: <a>imgflip</a>" pushes its media container over that line,
  // taking the image with it. Unwrap the anchors first: the credit text stays,
  // the URL is worthless in an ebook.
  doc.querySelectorAll('figcaption a').forEach((a) => a.replaceWith(...a.childNodes));
}

function stripHeadingClasses(doc: Document): void {
  // Readability deletes any node whose class matches its "unlikely candidate"
  // regex, and that regex includes /header/. Substack tags every in-post
  // heading class="header-anchor-post", so all headings vanished before
  // scoring. Classes are stripped from the output anyway.
  doc
    .querySelectorAll('h1, h2, h3, h4, h5, h6')
    .forEach((h) => h.removeAttribute('class'));
}

// Block-level tags, used to tell a paragraph boundary from an inline wrapper.
// Phrasing content (span, a, b, code, img, …) is absent on purpose: the only
// question here is whether removing a <div> would merge two paragraphs.
const BLOCK_TAGS =
  'address,article,aside,audio,blockquote,canvas,dd,details,dialog,div,dl,dt,' +
  'fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,' +
  'li,main,nav,ol,p,pre,section,table,ul,video';

function flattenInlineDivs(doc: Document): void {
  // A <div> inside a block that has no other block-level children cannot act as
  // a paragraph boundary; it is an inline wrapper. x.com renders every link and
  // every nested text run this way (React Native Web), and Readability treats
  // the wrapper as its own block: it splits the surrounding sentence into
  // sibling <p>s, then `_cleanConditionally` deletes the link-only div for
  // link density 1.0. Short wrappers (<25 chars) also hit its "no commas, no
  // headings, little text" rule. Unwrapping restores the original inline flow.
  //
  // The parent check is what keeps this safe: unwrapping a paragraph block that
  // sits beside other paragraph blocks would merge them. Reverse order visits
  // children before parents, so nested wrappers collapse in one pass.
  const divs = Array.from(doc.querySelectorAll('div')).reverse();
  for (const div of divs) {
    const parent = div.parentElement;
    if (!parent || div.querySelector(BLOCK_TAGS)) continue;
    if (Array.from(parent.children).some((c) => c !== div && c.matches(BLOCK_TAGS))) continue;
    div.replaceWith(...Array.from(div.childNodes));
  }
}

// A fully bold block this short, without sentence punctuation, reads as a
// label ("1.Pre-PR verification:", "Approval"), not prose. Anything longer or
// ending in . ! ? is emphasis inside a sentence, and promoting it would invent
// structure. 80 is a guard rail, not a precise cutoff: the labels in X's
// longform posts top out around 50 characters.
const MAX_BOLD_HEADING_CHARS = 80;

function isBoldElement(el: Element): boolean {
  if (el.tagName === 'B' || el.tagName === 'STRONG') return true;
  // Inline style only: extraction runs on a DOM clone and never calls
  // getComputedStyle, so class-based weights (Tailwind's font-bold, say) are
  // invisible here. X writes an inline weight, which is the case we need.
  const style = (el.getAttribute('style') ?? '').toLowerCase();
  const match = style.match(/font-weight\s*:\s*([0-9]+|bold|bolder)/);
  if (!match) return false;
  // 600 is the CSS "semibold" boundary; bold/bolder are the keyword forms.
  return match[1] === 'bold' || match[1] === 'bolder' || Number(match[1]) >= 600;
}

/**
 * How much of the block's text is bold, counted in characters.
 *
 * Walks text nodes rather than summing <b>/<strong> lengths so nested markup
 * (b > strong) is not counted twice. Whitespace-only nodes are ignored so
 * indentation between tags cannot make a fully bold block look partially bold.
 */
function boldness(el: Element): { total: number; bold: number } {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let total = 0;
  let bold = 0;
  let node = walker.nextNode();
  while (node) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) {
      total += text.length;
      let parent = node.parentElement;
      let isBold = false;
      while (parent && parent !== el) {
        if (isBoldElement(parent)) {
          isBold = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (isBold) bold += text.length;
    }
    node = walker.nextNode();
  }
  return { total, bold };
}

/**
 * The article container on x.com, or null on every other site.
 *
 * This is the gate for the heading promotion below. It is keyed on markup
 * rather than hostname because the DOM is what makes the promotion correct:
 * twitter.com and the mobile site serve the same shapes. Two shapes exist:
 *   - logged out: server-rendered [data-article-part="body"]
 *   - logged in:  Draft.js read view, an <article> holding [data-block] nodes
 * The read-view test id has changed before, so look for the draft blocks
 * instead of a specific marker attribute.
 */
function xArticleRoot(doc: Document): Element | null {
  const body = doc.querySelector('[data-article-part="body"]');
  if (body) return body;
  for (const article of doc.querySelectorAll('article')) {
    if (article.querySelector('[data-block="true"]')) return article;
  }
  return null;
}

/**
 * Turn X's fully bold section labels into real headings.
 *
 * Why: X longform authors write "1.Pre-PR verification:" as a bold paragraph,
 * not an <h*>. Readability deletes any div block under 25 characters ("no
 * commas, no headings, little text") and treats the rest as body copy, so the
 * label either disappears or loses the article outline. Promoting it before
 * parsing fixes both.
 *
 * Why only here: on a normal site a short fully bold paragraph is emphasis
 * ("This cannot be undone"), and promoting it would render a warning sentence
 * as a section heading. test/cases/bold-emphasis-not-heading pins that.
 *
 * The remaining filters keep the rule tight even on X:
 *   - leaf block only          — never wrap over other structure
 *   - every character bold     — a partially bold paragraph is prose
 *   - no . ! ? at the end      — bold sentences are not labels
 *   - skip captions/code/lists — those already carry their own semantics
 *
 * h3, not h2: X uses h2 for its own section headings; these labels sit under
 * them. The new heading carries no attributes. Readability and DOMPurify strip
 * them anyway, and copying the source class risks matching the /header/
 * unlikely-candidate regex that stripHeadingClasses exists to work around.
 */
function promoteXArticleHeadings(doc: Document): void {
  const root = xArticleRoot(doc);
  if (!root) return;
  for (const el of Array.from(root.querySelectorAll('p, div'))) {
    if (el.querySelector(BLOCK_TAGS)) continue;
    if (el.closest('figure, figcaption, pre, code, li')) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_BOLD_HEADING_CHARS || /[.!?]$/.test(text)) continue;
    const { total, bold } = boldness(el);
    if (!total || bold !== total) continue;
    const heading = doc.createElement('h3');
    heading.replaceChildren(...Array.from(el.childNodes));
    el.replaceWith(heading);
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
  flattenCaptionLinks(cloned);
  stripHeadingClasses(cloned);
  flattenInlineDivs(cloned);
  promoteXArticleHeadings(cloned);
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
