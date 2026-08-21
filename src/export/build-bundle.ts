import { zipSync } from 'fflate';
import { listArticles, getImagesForArticle } from '../db/db';
import themeCss from '../styles/theme.css';

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
<title>The Collector — Reading List</title>
<style>
${themeCss}
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, 'Iowan Old Style', 'Times New Roman', serif;
    max-width: 44em;
    margin: 0 auto;
    padding: 3em 1.5em 5em;
    line-height: 1.65;
    background:
      radial-gradient(90% 40% at 50% -10%, rgba(255, 152, 0, 0.05), transparent 60%),
      var(--color-c-background);
    color: var(--color-c-text);
  }
  nav {
    margin: 0 0 3.5em;
    padding: 1.6em 1.8em;
    background: var(--color-c-surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
  }
  nav h1 {
    margin: 0 0 0.7em;
    font-style: italic;
    font-weight: 500;
    font-size: 1.15em;
    color: var(--color-c-accent-subtle);
  }
  nav ol { margin: 0; padding-left: 1.4em; }
  nav li { margin: 0.35em 0; }
  nav a { color: var(--color-c-text); text-decoration: none; }
  nav a:hover { color: var(--color-c-accent-subtle); }
  section { margin-bottom: 4.5em; }
  section + section { padding-top: 3em; position: relative; }
  section + section::before {
    content: "\\2726";
    display: block;
    margin-bottom: 2.5em;
    text-align: center;
    font-size: 0.8em;
    color: var(--color-c-accent);
    opacity: 0.6;
  }
  section > h1 {
    margin: 0 0 0.6em;
    font-style: italic;
    font-weight: 400;
    font-size: 1.9em;
    line-height: 1.25;
  }
  .meta {
    margin: 0 0 1.6em;
    color: var(--color-c-text-muted);
    font-size: 0.82em;
  }
  a { color: var(--color-c-accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  img { max-width: 100%; height: auto; border-radius: 10px; }
  blockquote {
    margin: 1.4em 0;
    padding: 0.2em 0 0.2em 1.2em;
    border-left: 3px solid var(--color-c-accent);
    color: var(--color-c-text-muted);
    font-style: italic;
  }
  pre {
    background: var(--color-c-surface-muted);
    padding: 1em 1.2em;
    overflow-x: auto;
    border-radius: var(--radius-md);
    line-height: 1.5;
    font-size: 0.88em;
  }
  code {
    background: var(--color-c-surface-muted);
    padding: 0.12em 0.38em;
    border-radius: 6px;
    font-size: 0.9em;
  }
  pre code { background: transparent; padding: 0; }
  hr {
    border: none;
    height: 3px;
    width: 110px;
    margin: 2.5em auto;
    border-radius: 99px;
    background: var(--color-c-border);
  }
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
