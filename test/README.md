# Extraction regression corpus

Saved articles plus the problems each one caused, so a change to the extraction
pipeline can be checked against real pages instead of a fresh spot-check.

The extracted output is fragile by nature: Readability decides what survives
using class names, link density, and regexes, and small edits to our pre-passes
can silently change those decisions. Each case pins the behaviour we already
verified by hand.

## Run

```bash
npm test                       # build + run every case
node test/run.mjs <substring>  # one case
node test/run.mjs --update     # rewrite observed values (review the diff!)
```

The runner loads `dist/content-script.js` (the same bundle the extension ships)
into jsdom and feeds it a saved page. No browser, no network, ~1s total.

## Add a case

1. Capture the page:

   ```bash
   node test/capture.mjs <article-url> <slug>
   ```

   Saves `test/cases/<slug>/page.html` (rendered DOM, scripts/styles stripped)
   and a `case.json` skeleton.

2. Describe what broke, in `case.json`:

   ```json
   {
     "source": "https://…",
     "problems": [
       "Meme image missing: linked caption pushed link density over Readability's 0.2 cutoff."
     ],
     "expect": { … }
   }
   ```

3. Fill `expect` either by hand or with `node test/run.mjs --update <slug>`, then
   read the diff before committing. Add a few `contains` phrases for text that
   must survive, and `notContains` for page chrome that must be stripped.

## What a case asserts

| field | meaning |
|---|---|
| `title` | extracted article title |
| `images` | image URLs, reduced to their last path segment, in order |
| `headings` | `h1`–`h6` text, in order |
| `contains` | phrases that must appear in the extracted text |
| `notContains` | phrases that must not (nav, comments, subscribe prompts) |

Every case also checks invariants: extraction succeeds, output isn't empty, and
the sanitized HTML carries no `<script>`, `<style>`, or inline event handlers.

## What it does not cover

- Widget screenshot capture, image downloading, and Calibre conversion — those
  need a browser and the native host.
- Visual output. This compares extracted structure, not rendering.

Fixtures are snapshots. If a page changes upstream, capture it again under a new
slug rather than editing the old one — the old snapshot is still a valid
regression case for the extractor.
