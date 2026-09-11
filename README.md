# The Collector

A Manifest V3 browser extension that extracts a blog article from the current
tab, sanitizes it (Readability + DOMPurify), stores it locally in IndexedDB,
and exports a self-contained HTML + images bundle for conversion with Calibre
(`.azw3` / `.epub`).

## Install (unpacked)

1. `npm install`
2. `npm run build` (outputs to `dist/`)
3. Open `chrome://extensions` (or `brave://extensions`), enable **Developer
   mode**, **Load unpacked**, and select the `dist/` folder.
4. For one-click Kindle conversion, install the native host (Linux):

```bash
./native-host/install.sh --extension-id <PASTE_ID_HERE>
```

Find the ID on the extensions page (Developer mode) under The Collector.
Details, Brave/Chromium paths, and uninstall: `native-host/README.md`.

Notes:

- The ID is derived from the repo's absolute path: **reloading is safe**,
  and reinstalling at the same path keeps the same ID (no need to re-run
  `install.sh`). Moving the repo directory changes the ID — re-run
  `install.sh` with the new one.
- The host registration lives outside the extension on purpose: Chrome only
  talks to hosts installed at OS level that whitelist your extension ID.
  No restart of the browser is needed after registering.
- Prerequisites: `python3` and [Calibre](https://calibre-ebook.com/)
  (`ebook-convert` on PATH).

## Usage

- Click the toolbar icon and press **Save** to clip the current article.
- Or press **Ctrl+Shift+E** from any tab — same save flow, no popup needed. 
  - Remappable at `chrome://extensions/shortcuts`.

## Convert to Kindle (.azw3)

Export from the popup or Options page. With the native host installed (see
`native-host/README.md`) and [Calibre](https://calibre-ebook.com/) installed
(`ebook-convert` on PATH), the extension auto-converts the download to a
timestamped `reading_list_<date>.azw3` next to the zip, then deletes the zip.
The collection is cleared only after a successful conversion (when
"Export & clear" is selected). On failure the ZIP is kept in Downloads and
the error is shown.

Exporting from the popup is safe: the download starts in the popup but the
conversion and cleanup run in the background service worker, so closing the
popup mid-export doesn't interrupt anything.

Manual fallback (no native host):

```bash
unzip the-collector-export.zip -d export/ && cd export/ \
  && DT=$(date '+%Y-%m-%d_%H-%M') \
  && ebook-convert combined.html "../reading_list_${DT}.azw3" \
    --title "My Reading List $(date '+%Y-%m-%d %H:%M')" \
    --authors "Various" \
  && cd .. && rm -rf export/ the-collector-export.zip
```


## Troubleshooting conversion

| Symptom | Likely cause | Fix |
|---|---|---|
| Only the ZIP appears, no `.azw3` | Native host not registered | Run `./native-host/install.sh --extension-id <ID>` |
| `Native host not installed` in status | `allowed_origins` ID mismatch (repo moved?) | Re-run `install.sh` with the current ID |
| `Calibre is required…` | `ebook-convert` not on PATH | Install Calibre |
| ZIP kept + conversion error | Conversion itself failed | Read the status message; the ZIP is preserved deliberately |
| Articles never clear | Clear happens only after verified success | Fix the conversion error above first |

To check the host by hand (no browser):

```bash
./native-host/test-roundtrip.sh
```


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
