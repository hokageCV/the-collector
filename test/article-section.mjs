#!/usr/bin/env node
/**
 * Combined-document structure tests.
 *
 * Kindle attributes a page to the previous chapter when text precedes the new
 * chapter's heading on that page, and the KF8 reader shows such a page as
 * "Chapter complete". Calibre also inserts its own page break before the
 * chapter heading, so anything emitted above the `<h1>` lands alone on a page
 * belonging to the previous article.
 *
 * That makes "the `<h1>` is the first node in its section" a hard requirement,
 * not a style choice. This test pins it down.
 */
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const tmp = await mkdtemp(join(tmpdir(), 'collector-section-'));
const outfile = join(tmp, 'article-section.mjs');
try {
  await build({
    entryPoints: [resolve(ROOT, 'src/export/article-section.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });

  const { articleSectionHtml, escapeHtml } = await import(pathToFileURL(outfile).href);

  const failures = [];
  function check(name, ok, detail = '') {
    if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
  }

  function section(overrides = {}) {
    return articleSectionHtml({
      slug: 'article-one',
      title: 'Article One',
      url: 'https://example.com/one',
      html: '<p>Body text.</p>',
      savedLabel: '11/25/2026',
      ...overrides,
    });
  }

  function docFor(sections) {
    const html = `<!doctype html><html><body>\n${sections.join('\n')}\n</body></html>`;
    return new JSDOM(html).window.document;
  }

  /** Rendered text that sits before the section's heading. */
  function textBeforeHeading(sectionEl) {
    const heading = sectionEl.querySelector('h1');
    let text = '';
    for (let node = sectionEl.firstChild; node && node !== heading; node = node.nextSibling) {
      text += node.nodeType === 3 ? node.data : node.textContent;
    }
    return text;
  }

  // --- the invariant ------------------------------------------------------

  {
    const doc = docFor([section()]);
    const el = doc.querySelector('section');

    check('section exists', el !== null);
    check(
      'heading is the first element',
      el?.firstElementChild?.tagName === 'H1',
      el?.firstElementChild?.tagName,
    );
    check(
      'nothing rendered before the heading',
      textBeforeHeading(el).trim() === '',
      JSON.stringify(textBeforeHeading(el)),
    );
    check(
      'section text starts with the title',
      el?.textContent.trim().startsWith('Article One'),
      JSON.stringify(el?.textContent.slice(0, 20)),
    );
    check('no start banner', !section().includes('ARTICLE START'));
    check('end banner kept', el?.lastElementChild?.classList.contains('article-end'));
    check(
      'body preserved',
      el?.querySelector('p:not(.meta):not(.article-boundary)')?.textContent === 'Body text.',
    );
  }

  // --- every article, not just the first ---------------------------------

  {
    const sections = [
      section({ slug: 'a1', title: 'One' }),
      section({ slug: 'a2', title: 'Two' }),
      section({ slug: 'a3', title: 'Three' }),
    ];
    const doc = docFor(sections);
    const els = [...doc.querySelectorAll('section')];

    check('three sections', els.length === 3, String(els.length));
    for (const [i, el] of els.entries()) {
      check(`section ${i + 1} starts with its heading`, el.firstElementChild?.tagName === 'H1');
      check(
        `section ${i + 1} has nothing before the heading`,
        textBeforeHeading(el).trim() === '',
        JSON.stringify(textBeforeHeading(el)),
      );
    }
    check(
      'titles stay in order',
      JSON.stringify(els.map((el) => el.querySelector('h1').textContent)) ===
        JSON.stringify(['One', 'Two', 'Three']),
    );
  }

  // --- body headings cannot become the chapter heading --------------------

  {
    const doc = docFor([
      section({ title: 'Real Title', html: '<h1>Body Heading</h1><p>Body.</p>' }),
    ]);
    const el = doc.querySelector('section');
    check(
      'chapter heading is the generated title',
      el.firstElementChild?.textContent === 'Real Title',
      el.firstElementChild?.textContent,
    );
  }

  // --- escaping -----------------------------------------------------------

  {
    check('escapeHtml handles all five', escapeHtml('&<>"\'') === '&amp;&lt;&gt;&quot;&#39;');

    const doc = docFor([
      section({
        slug: 'safe',
        title: '</h1><script>alert(1)</script>',
        url: 'https://example.com/?a=1&b="2"',
      }),
    ]);
    const el = doc.querySelector('section');

    check('title markup is escaped', el.querySelector('h1').textContent === '</h1><script>alert(1)</script>');
    check('no injected script', doc.querySelector('script') === null);
    check('url round-trips', el.querySelector('p.meta a').getAttribute('href') === 'https://example.com/?a=1&b="2"');
    check('slug is escaped', articleSectionHtml({
      slug: 'a"b',
      title: 't',
      url: 'u',
      html: '',
      savedLabel: 'd',
    }).includes('id="a&quot;b"'));
  }

  // --- report -------------------------------------------------------------

  if (failures.length === 0) {
    console.log(`article section ${green('ok')}`);
  } else {
    console.log(`article section ${red('FAIL')}`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exitCode = 1;
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
