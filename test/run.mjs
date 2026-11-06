#!/usr/bin/env node
/**
 * Regression corpus for article extraction.
 *
 *   npm test                     run every case, compare to case.json
 *   node test/run.mjs --update   rewrite expectations from current behaviour
 *   node test/run.mjs <case>     run a single case
 *
 * Runs the built content script (dist/content-script.js) against a saved page
 * in jsdom, so it exercises the real Readability + DOMPurify pipeline without
 * a browser and without the network.
 */
import { JSDOM } from 'jsdom';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CASES = join(HERE, 'cases');

const args = process.argv.slice(2);
const update = args.includes('--update');
const only = args.find((a) => !a.startsWith('--'));

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/** Stable identity for an image URL: the last path segment, decoded. */
function imageKey(url) {
  try {
    return decodeURIComponent(url).split('/').pop().split('?')[0];
  } catch {
    return url;
  }
}

function headingText(html) {
  const tmp = `<div>${html}</div>`;
  return (tmp.match(/<h[1-6][^>]*>.*?<\/h[1-6]>/gi) ?? []).map((h) =>
    h
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function textOf(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  return dom.window.document.body.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * The bundle reads `document` / `location` / `window` from the global scope, so
 * jsdom's objects have to be installed there before it is evaluated.
 */
let extract;
async function loadExtractor(dom) {
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.Node = dom.window.Node;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };

  if (!extract) {
    await import(pathToFileURL(join(ROOT, 'dist/content-script.js')).href);
    extract = dom.window.__theCollectorExtract;
    if (typeof extract !== 'function') {
      throw new Error('dist/content-script.js did not expose __theCollectorExtract (run npm run build)');
    }
  }
  return extract;
}

async function runCase(name) {
  const dir = join(CASES, name);
  const html = await readFile(join(dir, 'page.html'), 'utf8');
  const spec = JSON.parse(await readFile(join(dir, 'case.json'), 'utf8'));
  const url = spec.source ?? 'https://example.com/';

  const dom = new JSDOM(html, { url });
  const extractArticle = await loadExtractor(dom);

  let got;
  try {
    got = extractArticle({});
  } catch (err) {
    return { name, spec, dir, ok: false, errors: [`extractor threw: ${err?.message ?? err}`] };
  }

  if (!got?.ok) {
    return { name, spec, dir, ok: false, errors: [`extract failed: ${got?.reason ?? 'unknown'}`] };
  }

  const actual = {
    title: got.title,
    images: (got.images ?? []).map(imageKey),
    headings: headingText(got.html ?? ''),
    contains: null,
    notContains: null,
  };
  const text = textOf(got.html ?? '');

  if (update) {
    // Only the observed shape is rewritten. `contains` / `notContains` are
    // authored intent and must keep failing until the behaviour is fixed.
    spec.expect = {
      title: actual.title,
      images: actual.images,
      headings: actual.headings,
      contains: spec.expect?.contains ?? [],
      notContains: spec.expect?.notContains ?? [],
    };
    await writeFile(join(dir, 'case.json'), JSON.stringify(spec, null, 2) + '\n');
  }

  const expect = spec.expect ?? {};
  const errors = [];

  const diffList = (label, want, have) => {
    if (!want) return;
    const missing = want.filter((x) => !have.includes(x));
    const extra = have.filter((x) => !want.includes(x));
    if (missing.length) errors.push(`${label} missing: ${missing.map((x) => `"${x}"`).join(', ')}`);
    if (extra.length) errors.push(`${label} unexpected: ${extra.map((x) => `"${x}"`).join(', ')}`);
  };

  if (expect.title !== undefined && got.title !== expect.title) {
    errors.push(`title: expected "${expect.title}", got "${got.title}"`);
  }
  diffList('images', expect.images, actual.images);
  diffList('headings', expect.headings, actual.headings);

  for (const phrase of expect.contains ?? []) {
    if (!text.includes(phrase)) errors.push(`content missing: "${phrase}"`);
  }
  for (const phrase of expect.notContains ?? []) {
    if (text.includes(phrase)) errors.push(`content should be gone: "${phrase}"`);
  }

  // Invariants that must hold for every case, expectation file or not.
  if (!got.html || got.html.length < 200) errors.push('extracted html is suspiciously short');
  if (/<script[\s>]/i.test(got.html)) errors.push('sanitized html still contains <script>');
  if (/<style[\s>]/i.test(got.html)) errors.push('sanitized html still contains <style>');
  if (/\son[a-z]+\s*=/i.test(got.html)) errors.push('sanitized html still contains an inline event handler');

  return { name, spec, dir, ok: errors.length === 0, errors };
}

const entries = (await readdir(CASES, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => !only || n.includes(only))
  .sort();

if (entries.length === 0) {
  console.error('no cases matched');
  process.exit(2);
}

const results = await Promise.all(entries.map(runCase));

let failed = 0;
for (const r of results) {
  const label = r.name.padEnd(52);
  if (r.ok) {
    console.log(`${label} ${green('ok')} ${dim(`(${r.spec.expect?.images?.length ?? 0} images, ${r.spec.expect?.headings?.length ?? 0} headings)`)}`);
  } else {
    failed++;
    console.log(`${label} ${red('FAIL')}`);
    for (const e of r.errors) console.log(`  ${e}`);
  }
}

console.log();
console.log(
  `${results.length - failed} passed, ${failed} failed` + (update ? dim(' (expectations rewritten)') : ''),
);
process.exit(failed === 0 ? 0 : 1);
