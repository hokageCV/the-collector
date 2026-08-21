import {
  getArticleByUrl,
  listArticles,
  saveArticle,
  saveImage,
  type ArticleRecord,
} from './db/db';
import type { SaveArticleRequest, SaveArticleResponse } from './messages';

const MAX_IMAGE_WIDTH = 1600;

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
      // Skip failed images; the original URL stays in the HTML as a fallback.
    }
  }
  return replacements;
}

function rewriteHtml(html: string, replacements: Map<string, string>): string {
  let out = html;
  for (const [url, local] of replacements) {
    out = out.split(url).join(local);
  }
  return out;
}

async function handleSave(req: SaveArticleRequest): Promise<SaveArticleResponse> {
  const ex = req.extract;
  if (!ex.ok || !ex.html || !ex.url || !ex.title) {
    return { ok: false, reason: 'invalid extract payload' };
  }

  const existing = req.overwriteId ? await getArticleByUrl(ex.url) : undefined;
  const articleId = req.overwriteId ?? existing?.id ?? crypto.randomUUID();

  const replacements = await fetchAndStoreImages(ex.images ?? [], articleId);
  const html = rewriteHtml(ex.html, replacements);

  const articles = await listArticles();
  let slug: string;
  let order: number;
  if (existing) {
    slug = existing.slug;
    order = existing.order_index;
  } else {
    slug = uniqueSlug(slugify(ex.title), articles.map((a) => a.slug));
    order = articles.length ? Math.max(...articles.map((a) => a.order_index)) + 1 : 0;
  }

  const record: ArticleRecord = {
    id: articleId,
    url: ex.url,
    title: ex.title,
    byline: ex.byline ?? null,
    excerpt: ex.excerpt ?? null,
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

chrome.runtime.onInstalled.addListener(() => {
  console.log('[the-collector] installed');
});
