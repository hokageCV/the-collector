import { Readability } from '@mozilla/readability';
import DOMPurify from 'dompurify';
import type { ExtractResponse } from './messages';

declare global {
  interface Window {
    __theCollectorExtract?: () => ExtractResponse;
  }
}

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li', 'a', 'img',
    'strong', 'em', 'b', 'i', 'code', 'pre', 'figure', 'figcaption', 'br', 'hr',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
};

function normalizeImages(doc: Document): void {
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

function extract(): ExtractResponse {
  const cloned = document.cloneNode(true) as Document;
  normalizeImages(cloned);

  const article = new Readability(cloned).parse();
  if (!article || !article.content) {
    return { ok: false, reason: 'unparseable' };
  }

  const clean = DOMPurify.sanitize(article.content, PURIFY_CONFIG) as string;
  return {
    ok: true,
    title: article.title,
    byline: article.byline ?? null,
    excerpt: article.excerpt ?? null,
    html: clean,
    url: location.href,
    images: collectImageUrls(clean),
  };
}

window.__theCollectorExtract = extract;

