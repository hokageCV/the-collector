/**
 * Markup for one article inside the combined export document.
 *
 * The shape is dictated by Kindle's chapter model. The native host points
 * Calibre's level-1 TOC at `//h:section/h:h1`, and the KF8 reader attributes a
 * page to the previous chapter when text precedes the new chapter's heading on
 * that page. Anything emitted before the `<h1>` therefore stays in the previous
 * article's chapter, and the reader shows that orphan page as "Chapter
 * complete" instead of moving on.
 *
 * Sections force a page break and Calibre adds its own break before the
 * chapter heading, so a banner above the `<h1>` ends up alone on a page.
 * Keeping the heading as the first node makes both breaks coincide and the
 * article's title the first thing on its page.
 */

export interface ArticleSection {
  slug: string;
  title: string;
  url: string;
  /** Sanitized article body, inserted verbatim. */
  html: string;
  /** Pre-formatted save date, e.g. `11/25/2026`. */
  savedLabel: string;
}

export function escapeHtml(s: string): string {
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

export function articleSectionHtml(article: ArticleSection): string {
  const meta = `<p class="meta">Source: <a href="${escapeHtml(
    article.url,
  )}">${escapeHtml(article.url)}</a> — saved ${escapeHtml(article.savedLabel)}</p>`;
  return `<section id="${escapeHtml(article.slug)}">\n<h1>${escapeHtml(article.title)}</h1>\n${meta}\n${article.html}\n<p class="article-boundary article-end"><strong>=========== ARTICLE END ===========</strong></p>\n</section>`;
}
