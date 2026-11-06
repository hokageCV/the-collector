#!/usr/bin/env node
/**
 * Capture an article as a regression fixture.
 *
 *   node test/capture.mjs <url> <slug>
 *
 * Loads the page in headless Chrome, waits for lazy images, then saves the
 * rendered DOM (minus scripts/styles) to test/cases/<slug>/page.html and writes
 * a case.json skeleton next to it. Edit the `problems` field by hand.
 *
 * Fixtures are snapshots, not live requests: the runner never touches the
 * network.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, 'cases');

const [url, slugArg] = process.argv.slice(2);
if (!url) {
  console.error('usage: node test/capture.mjs <url> <slug>');
  process.exit(2);
}
const slug =
  slugArg ??
  new URL(url).pathname.replace(/^\/+|\/+$/g, '').split('/').pop().slice(0, 60) ??
  'case';

const PORT = 9400 + Math.floor(Math.random() * 100);
const chrome = spawn(
  process.env.CHROME_PATH ?? 'google-chrome',
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join('/tmp', `collector-capture-${PORT}`)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
);

async function json(path) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('chrome did not start');
}

await json('/json/version');
const target = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
  method: 'PUT',
}).then((r) => r.json());

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1000));
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
for (let i = 0; i < 80; i++) {
  if ((await evaluate('document.readyState')) === 'complete') break;
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 1500));

// Scroll through the page: some sites only assign real src attributes to
// images once they enter the viewport.
await evaluate(`(async () => {
  const h = document.body.scrollHeight;
  for (let y = 0; y < h; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 500));
  return true;
})()`);

// Keep the rendered body, drop scripts/styles/links: they add hundreds of KB
// and never reach the extractor.
const html = await evaluate(`(() => {
  const doc = document.cloneNode(true);
  doc.querySelectorAll('script, style, link, noscript, iframe, template').forEach(n => n.remove());
  doc.querySelectorAll('[nonce]').forEach(n => n.removeAttribute('nonce'));
  const title = doc.querySelector('title')?.textContent ?? '';
  return '<!doctype html>\\n<html><head><meta charset="utf-8"><title>' +
    title.replace(/&/g, '&amp;').replace(/</g, '&lt;') +
    '</title></head><body>' + doc.body.innerHTML + '</body></html>\\n';
})()`);

const dir = join(CASES, slug);
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'page.html'), html);

const caseFile = join(dir, 'case.json');
let exists = true;
try {
  await access(caseFile);
} catch {
  exists = false;
}
if (!exists) {
  await writeFile(
    caseFile,
    JSON.stringify(
      {
        source: url,
        problems: ['TODO: describe what this article broke'],
        expect: {},
      },
      null,
      2,
    ) + '\n',
  );
}

ws.close();
chrome.kill('SIGKILL');

const size = (await readFile(join(dir, 'page.html'))).length;
console.log(`captured ${slug}: ${(size / 1024).toFixed(0)} KB -> test/cases/${slug}/page.html`);
console.log(`next: fill in problems/expect (or run: node test/run.mjs --update ${slug})`);
