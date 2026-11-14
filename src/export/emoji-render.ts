/**
 * Canvas rasterizer for emoji, used by the export.
 *
 * A bundled font rather than the system emoji font: the export has to look the
 * same on every machine that runs the extension, and a Linux box without an
 * emoji font would otherwise bake tofu into the PNG. Noto Emoji is monochrome
 * (outlines) so it stays crisp on e-ink instead of turning into grey smudges
 * the way a downsampled colour emoji does.
 *
 * Any failure returns null and the caller leaves the emoji as text: that is the
 * status quo, never a blank image or a crash.
 */
import type { EmojiRenderer } from './emoji';
import { emojiRenderSource } from './emoji';

const FONT_FAMILY = 'The Collector Emoji';
const FONT_PATH = 'fonts/NotoEmoji-Regular.ttf';
/** Rendered well above 1em so the glyph stays sharp on a 300ppi screen. */
const CANVAS_PX = 128;
/** Font size used only to measure the glyph's ink box before scaling it. */
const PROBE_PX = 100;
/** Share of the canvas the ink is allowed to fill; the rest is breathing room. */
const INK_FRACTION = 0.86;

export async function createEmojiRenderer(): Promise<EmojiRenderer | null> {
  if (
    typeof document === 'undefined' ||
    typeof chrome === 'undefined' ||
    typeof chrome.runtime?.getURL !== 'function'
  ) {
    return null;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = CANVAS_PX;
  canvas.height = CANVAS_PX;

  try {
    const face = new FontFace(FONT_FAMILY, `url("${chrome.runtime.getURL(FONT_PATH)}")`);
    await face.load();
    document.fonts.add(face);
  } catch (err) {
    console.warn('[the-collector] emoji font unavailable, keeping emoji as text', err);
    return null;
  }

  return async function renderEmoji(cluster: string): Promise<Uint8Array | null> {
    try {
      // Draw the base form: the bundled font has no variation selectors, and
      // asking Chrome to shape them pulls in the host's colour emoji font.
      const glyph = emojiRenderSource(cluster);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
      ctx.fillStyle = '#000';

      // Measure the glyph at a fixed size, then draw it scaled and centred on
      // its ink box so every emoji occupies the same visual area.
      ctx.font = `${PROBE_PX}px "${FONT_FAMILY}"`;
      const metrics = ctx.measureText(glyph);
      const inkWidth = Math.max(
        metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
        1,
      );
      const inkHeight = Math.max(
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
        1,
      );
      const scale = (CANVAS_PX * INK_FRACTION) / Math.max(inkWidth, inkHeight);
      const inkCentreX = (metrics.actualBoundingBoxRight - metrics.actualBoundingBoxLeft) / 2;
      const inkCentreY = (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2;
      const half = CANVAS_PX / 2;

      ctx.setTransform(
        scale,
        0,
        0,
        scale,
        half - inkCentreX * scale,
        half - inkCentreY * scale,
      );
      ctx.fillText(glyph, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/png');
      });
      if (!blob) return null;
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return null;
    }
  };
}
