/**
 * Emoji -> inline images, applied at export time.
 *
 * Kindle firmware fonts (Bookerly, Amazon Ember) carry no emoji glyphs, and
 * KF8 has no font fallback that can supply them, so emoji leave the device as
 * tofu boxes. The characters are still present in the export, which means the
 * reading experience silently loses the tone they convey.
 *
 * The export is the right place to fix this, not extraction: the stored HTML
 * stays faithful to the page for the in-extension reader, which renders emoji
 * through the browser's own font stack. It also lets one pass cover the
 * generated article titles, which are built in build-bundle.ts and may contain
 * emoji of their own.
 *
 * Each emoji is replaced by an `<img>` in the same text node, sized `1em` by
 * the export stylesheet. An inline image flows with the text and wraps like a
 * word; a block-level replacement (figure, div) would break the paragraph.
 */

export type EmojiRenderer = (cluster: string) => Promise<Uint8Array | null>;

export interface EmojiPassResult {
  /** PNG files to add to the ZIP, keyed by path relative to the ZIP root. */
  assets: Map<string, Uint8Array>;
  /** Number of emoji replaced. Zero means the caller can keep the input as-is. */
  replaced: number;
}

export const EMOJI_CLASS = 'emoji';

/** DOM constants, spelled out so this module needs no global Node/NodeFilter. */
const ELEMENT_NODE = 1;
const SHOW_ELEMENT = 1;
const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_SKIP = 3;
const FILTER_REJECT = 2;

/**
 * Emoji inside these tags are literal characters, not tone: an image would
 * break monospace alignment and could not be copied back out of a listing.
 */
const SKIP_TAGS = new Set(['PRE', 'CODE', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'TEXTAREA']);
/** HTML elements only: replacing text inside SVG/MathML would corrupt the tree. */
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/** Flags are pairs of regional indicators and match no pictographic scalar. */
const REGIONAL_INDICATOR = /[\u{1f1e6}-\u{1f1ff}]/u;
/** Keycaps (`1️⃣`) are a digit plus VS16 plus COMBINING ENCLOSING KEYCAP. */
const KEYCAP = /\u20e3/;
/** U+FE0E / U+FE0F, the text and emoji variation selectors. */
const VARIATION_SELECTORS = /[\ufe0e\ufe0f]/g;
/** U+E0020–U+E007F, the tag characters used by subdivision flags. */
const TAG_CHARS = /[\u{e0020}-\u{e007f}]/gu;

/**
 * A grapheme cluster is an emoji if any part of it is pictographic, a regional
 * indicator, or a keycap. Testing clusters rather than codepoints is what keeps
 * ZWJ families, skin tones, and flags together as one image.
 */
export function isEmojiCluster(cluster: string): boolean {
  return containsEmoji(cluster);
}

/**
 * Cheap pre-check over raw HTML, used to skip the font load and the DOM
 * round-trip when there is nothing to convert. Matching attribute text or a
 * style block only costs an unnecessary parse, never a wrong result.
 */
export function containsEmoji(text: string): boolean {
  return PICTOGRAPHIC.test(text) || REGIONAL_INDICATOR.test(text) || KEYCAP.test(text);
}

/**
 * The form of the cluster that should be drawn.
 *
 * Variation selectors are dropped because Noto Emoji has no U+FE0F: a cluster
 * like `❤️` (heart + VS16) then falls back to the host's colour emoji font,
 * which produces a saturated bitmap in the middle of an otherwise monochrome
 * export. The font's own glyph for the base codepoint is already the emoji
 * form, so dropping the selector yields the intended shape. Tag characters
 * (subdivision flags) are dropped for the same reason.
 */
export function emojiRenderSource(cluster: string): string {
  const stripped = cluster.replace(TAG_CHARS, '').replace(VARIATION_SELECTORS, '');
  return stripped || cluster;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clustersOf(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Stable, collision-free asset name: the rendered cluster's codepoints. */
export function emojiFileName(cluster: string): string {
  const points = Array.from(emojiRenderSource(cluster), (ch) => ch.codePointAt(0)!.toString(16));
  return `emoji-${points.join('-')}.png`;
}

function collectTextNodes(root: Node): Text[] {
  const doc = root.ownerDocument ?? (root as Document);
  const found: Text[] = [];
  const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (node.nodeType === ELEMENT_NODE) {
        const el = node as Element;
        // SVG/MathML have their own namespaces; an HTML <img> inside them is
        // invalid markup, so leave any text there alone.
        if (el.namespaceURI !== XHTML_NAMESPACE) return FILTER_REJECT;
        if (SKIP_TAGS.has(el.tagName) || el.classList.contains(EMOJI_CLASS)) {
          return FILTER_REJECT; // skip the whole subtree
        }
        return FILTER_SKIP; // keep walking, do not collect the element
      }
      return isEmojiCluster((node as Text).data) ? FILTER_ACCEPT : FILTER_SKIP;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    found.push(node as Text);
  }
  return found;
}

function emojiImage(doc: Document, cluster: string, fileName: string): HTMLImageElement {
  const img = doc.createElement('img');
  img.className = EMOJI_CLASS;
  img.src = `emoji/${fileName}`;
  // alt keeps the character available to assistive tech and, if a device drops
  // images entirely, degrades to the same text the export would have shipped.
  img.alt = cluster;
  // Intrinsic size is only a fallback: the export CSS sets height:1em so the
  // glyph tracks the reader's font size. Fixed attributes protect the layout if
  // a renderer ignores CSS and would otherwise draw a 128px source image.
  img.width = 16;
  img.height = 16;
  return img;
}

/**
 * Replaces every emoji cluster under `root` with an `<img>`, using `render` to
 * produce each distinct PNG. Clusters the renderer cannot produce stay as text
 * rather than becoming a blank image.
 */
export async function replaceEmojiWithImages(
  root: Node,
  render: EmojiRenderer,
): Promise<EmojiPassResult> {
  const doc = root.ownerDocument ?? (root as Document);
  const assets = new Map<string, Uint8Array>();
  const cache = new Map<string, Uint8Array | null>();
  let replaced = 0;

  for (const node of collectTextNodes(root)) {
    const fragment = doc.createDocumentFragment();
    let pending = '';
    let converted = 0;

    for (const cluster of clustersOf(node.data)) {
      if (!isEmojiCluster(cluster)) {
        pending += cluster;
        continue;
      }

      if (!cache.has(cluster)) cache.set(cluster, await render(cluster));
      const bytes = cache.get(cluster) ?? null;
      if (!bytes) {
        pending += cluster;
        continue;
      }

      if (pending) {
        fragment.append(doc.createTextNode(pending));
        pending = '';
      }
      const fileName = emojiFileName(cluster);
      assets.set(fileName, bytes);
      fragment.append(emojiImage(doc, cluster, fileName));
      converted += 1;
      replaced += 1;
    }

    if (pending) fragment.append(doc.createTextNode(pending));
    // Leave nodes the renderer could not help untouched: no needless DOM churn.
    if (converted > 0) node.replaceWith(fragment);
  }

  return { assets, replaced };
}
