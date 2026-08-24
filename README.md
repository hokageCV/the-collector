# The Collector

A Manifest V3 browser extension that extracts a blog article from the current
tab, sanitizes it (Readability + DOMPurify), stores it locally in IndexedDB,
and exports a self-contained HTML + images bundle for conversion with Calibre
(`.azw3` / `.epub`).

## Install (unpacked)

1. `npm install`
2. `npm run build` (outputs to `dist/`)
3. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, and
   select the `dist/` folder.

## Usage

- Click the toolbar icon and press **Save** to clip the current article.
- Or press **Ctrl+Shift+E** from any tab — same save flow, no popup needed. 
  - Remappable at `chrome://extensions/shortcuts`.

## Convert to Kindle (.azw3)

Export the combined bundle from the Options page, then — with
[Calibre](https://calibre-ebook.com/) installed (`ebook-convert` on PATH):

```bash
unzip the-collector-export.zip -d export/ && cd export/ \
  && DT=$(date '+%Y-%m-%d_%H-%M') \
  && ebook-convert combined.html "../reading_list_${DT}.azw3" \
    --title "My Reading List $(date '+%Y-%m-%d %H:%M')" \
    --authors "Various" \
  && cd .. && rm -rf export/ the-collector-export.zip
```

Produces a timestamped `reading_list_<date>.azw3` next to the zip, then cleans
up both the unzipped folder and the archive.


## Interactive widgets

Many posts embed diagrams built from live DOM (`<svg>`, `<canvas>`, buttons,
sliders) rather than static `<img>` tags. The default sanitizer would discard
those. The extension detects likely interactive containers, screenshots each one
(cropped to its bounding box), and splices the screenshot in as a normal
`<img>` before extraction — so it flows through the usual image pipeline and
survives the Calibre export.

Detection is heuristic and conservative (it favors false negatives — an
untagged widget just degrades to today's text-soup behavior, never a crash). If
the heuristic misses a widget, or captures something it shouldn't, tag it
manually from the devtools console before saving:

- `data-collector-capture` — force a container to be captured, whatever the score.
- `data-collector-skip` — force a container to be ignored.

Example:

```js
document.querySelector('#my-diagram').setAttribute('data-collector-capture', '');
```

## Known limitations

- **Viewport height**: a screenshot only covers what is on screen at capture
  time. A widget taller than the viewport is cropped to the visible portion
  (no multi-shot stitching yet). Scroll it into view manually if a specific
  region matters.
- **Single state**: only the widget's current/initial render is captured, not
  hover or other interactive states.
- Save time scales with widget count (captures run serially, ~0.5s each).
