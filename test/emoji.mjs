#!/usr/bin/env node
/**
 * Export-side emoji tests.
 *
 * The extraction corpus (test/run.mjs) stops at stored HTML; emoji replacement
 * happens later, while the export ZIP is built. This runs that pass directly
 * against jsdom with a stub rasterizer, so the DOM rules (clustering, inline
 * placement, skip list, dedupe, fallback) are covered without a canvas.
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

const tmp = await mkdtemp(join(tmpdir(), 'collector-emoji-'));
const outfile = join(tmp, 'emoji.mjs');
try {
  await build({
    entryPoints: [resolve(ROOT, 'src/export/emoji.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });

  const { isEmojiCluster, emojiFileName, emojiRenderSource, replaceEmojiWithImages } = await import(
    pathToFileURL(outfile).href
  );

  const png = (cluster) => new TextEncoder().encode(`PNG:${cluster}`);

  /** A stub renderer: everything renders, except clusters named in `fail`. */
  function renderer(fail = new Set()) {
    return async (cluster) => (fail.has(cluster) ? null : png(cluster));
  }

  function docWith(html) {
    return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
  }

  const failures = [];
  function check(name, ok, detail = '') {
    if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
  }

  // --- clustering ---------------------------------------------------------

  const clusters = [
    ['🙃', true],
    ['👨‍👩‍👧‍👦', true],
    ['👍🏽', true],
    ['🇮🇳', true],
    ['1️⃣', true],
    ['❤️', true],
    ['a', false],
    ['→', false],
    ['3', false],
    ['', false],
  ];
  for (const [value, want] of clusters) {
    check(`isEmojiCluster(${JSON.stringify(value)})`, isEmojiCluster(value) === want, `want ${want}`);
  }

  check(
    'ZWJ family is one asset name',
    emojiFileName('👨‍👩‍👧‍👦') === 'emoji-1f468-200d-1f469-200d-1f467-200d-1f466.png',
    emojiFileName('👨‍👩‍👧‍👦'),
  );

  // The bundled font has no U+FE0F, so the selector must not reach the canvas.
  check('render source drops VS16', emojiRenderSource('❤️') === '❤', JSON.stringify(emojiRenderSource('❤️')));
  check(
    'asset name ignores VS16',
    emojiFileName('❤️') === 'emoji-2764.png',
    emojiFileName('❤️'),
  );
  check(
    'asset name ignores tag characters',
    emojiFileName('🏴󠁧󠁢󠁥󠁮󠁧󠁿') === 'emoji-1f3f4.png',
    emojiFileName('🏴󠁧󠁢󠁥󠁮󠁧󠁿'),
  );

  // --- inline placement ---------------------------------------------------

  {
    const doc = docWith('<p id="p">before 🙃 after</p>');
    const { assets, replaced } = await replaceEmojiWithImages(doc.body, renderer());
    const p = doc.getElementById('p');
    const img = p.querySelector('img');

    check('one emoji replaced', replaced === 1, String(replaced));
    check('one asset emitted', assets.size === 1, String(assets.size));
    check('paragraph still has text', p.textContent === 'before  after', JSON.stringify(p.textContent));
    check('image stays inside the paragraph', p.children.length === 1);
    check('image sits between the text runs', p.childNodes[1] === img, String(p.childNodes[1]?.nodeName));
    check('image src', img?.getAttribute('src') === 'emoji/emoji-1f643.png', img?.getAttribute('src'));
    check('image alt keeps the character', img?.getAttribute('alt') === '🙃', img?.getAttribute('alt'));
    check('image class', img?.classList.contains('emoji'));
    check('asset bytes survive', new TextDecoder().decode(assets.get('emoji-1f643.png')) === 'PNG:🙃');
  }

  // --- cluster integrity --------------------------------------------------

  {
    const doc = docWith('<p id="p">👨‍👩‍👧‍👦 🇮🇳 👍🏽 1️⃣</p>');
    const { assets, replaced } = await replaceEmojiWithImages(doc.body, renderer());
    const alts = [...doc.querySelectorAll('img')].map((img) => img.getAttribute('alt'));
    check('one image per grapheme', replaced === 4, String(replaced));
    check('four assets', assets.size === 4, String(assets.size));
    check(
      'clusters kept whole in alt text',
      JSON.stringify(alts) === JSON.stringify(['👨‍👩‍👧‍👦', '🇮🇳', '👍🏽', '1️⃣']),
      JSON.stringify(alts),
    );
  }

  // --- skipped contexts ---------------------------------------------------

  {
    const doc = docWith(
      '<p id="ok">prose 🙂</p><pre id="pre">🙃 code</pre><code id="code">🙌 inline code</code><kbd>🤔</kbd>' +
        '<svg xmlns="http://www.w3.org/2000/svg"><text>😎 diagram label</text></svg>',
    );
    const { replaced } = await replaceEmojiWithImages(doc.body, renderer());
    check('only prose is converted', replaced === 1, String(replaced));
    check('pre untouched', doc.getElementById('pre').textContent === '🙃 code');
    check('code untouched', doc.getElementById('code').textContent === '🙌 inline code');
    check('no images in skipped tags', doc.querySelectorAll('pre img, code img, kbd img').length === 0);
    check('svg untouched', doc.querySelector('svg text').textContent === '😎 diagram label');
  }

  // --- dedupe -------------------------------------------------------------

  {
    const doc = docWith('<p>🙃</p><p>🙃</p><p>🙌</p>');
    const { assets, replaced } = await replaceEmojiWithImages(doc.body, renderer());
    check('three replacements', replaced === 3, String(replaced));
    check('two distinct assets', assets.size === 2, String(assets.size));
    check('two images for the repeated emoji', doc.querySelectorAll('img[alt="🙃"]').length === 2);
  }

  // --- fallback -----------------------------------------------------------

  {
    const doc = docWith('<p id="p">a 🙃 b 🙌 c</p>');
    const { assets, replaced } = await replaceEmojiWithImages(doc.body, renderer(new Set(['🙃'])));
    check('only the renderable emoji is replaced', replaced === 1, String(replaced));
    check('failed cluster stays as text', doc.getElementById('p').textContent.includes('🙃'));
    check('other cluster still becomes an image', doc.querySelectorAll('img[alt="🙌"]').length === 1);
    check('only one asset', assets.size === 1, String(assets.size));
  }

  // --- idempotency --------------------------------------------------------

  {
    const doc = docWith('<p>a <img class="emoji" src="emoji/emoji-1f643.png" alt="🙃"> b</p>');
    const { replaced, assets } = await replaceEmojiWithImages(doc.body, renderer());
    check('existing emoji image is untouched', replaced === 0, String(replaced));
    check('no assets emitted', assets.size === 0, String(assets.size));
    check('still exactly one image', doc.querySelectorAll('img').length === 1);
  }

  // --- non-emoji text -----------------------------------------------------

  {
    const doc = docWith('<p id="p">arrows → ← and digits 42 and prose</p>');
    const { replaced, assets } = await replaceEmojiWithImages(doc.body, renderer());
    check('non-emoji text untouched', replaced === 0 && assets.size === 0);
    check('text intact', doc.getElementById('p').textContent === 'arrows → ← and digits 42 and prose');
  }

  // --- report -------------------------------------------------------------

  if (failures.length === 0) {
    console.log(`emoji export pass ${green('ok')}`);
  } else {
    console.log(`emoji export pass ${red('FAIL')}`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exitCode = 1;
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
