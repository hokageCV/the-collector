import { zipSync } from 'fflate';
import { listArticles, getImagesForArticle } from '../db/db';

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

export async function buildBundle(): Promise<void> {
  const articles = await listArticles();
  if (articles.length === 0) throw new Error('No articles to export');

  const toc = articles
    .map((a) => `<li><a href="#${a.slug}">${escapeHtml(a.title)}</a></li>`)
    .join('\n');

  const sections = articles
    .map((a) => {
      const meta = `<p class="meta">Source: <a href="${escapeHtml(
        a.url,
      )}">${escapeHtml(a.url)}</a> — saved ${formatDate(a.saved_at)}</p>`;
      return `<section id="${a.slug}">\n<h1>${escapeHtml(a.title)}</h1>\n${meta}\n${a.html}\n</section>`;
    })
    .join('\n');

  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Reading List</title>
<style>
  body { font-family: Georgia, serif; max-width: 42em; margin: 2em auto; padding: 0 1em; line-height: 1.5; }
  nav { border-bottom: 1px solid #ccc; margin-bottom: 2em; padding-bottom: 1em; }
  nav ol { padding-left: 1.2em; }
  .meta { color: #777; font-size: 0.85em; font-style: italic; }
  section { margin-bottom: 3em; }
  img { max-width: 100%; height: auto; }
  pre { background: #f4f4f4; padding: 0.8em; overflow-x: auto; }
  code { background: #f4f4f4; padding: 0.1em 0.3em; }
</style>
</head>
<body>
<nav>
<h1>Contents</h1>
<ol>
${toc}
</ol>
</nav>
${sections}
</body>
</html>`;

  const files: Record<string, Uint8Array> = {
    'combined.html': new TextEncoder().encode(doc),
  };

  for (const a of articles) {
    const imgs = await getImagesForArticle(a.id);
    for (const img of imgs) {
      const path = `images/${img.key}.${extForMime(img.mime_type)}`;
      files[path] = new Uint8Array(await img.blob.arrayBuffer());
    }
  }

  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: 'the-collector-export.zip', saveAs: true });
  URL.revokeObjectURL(url);
}
