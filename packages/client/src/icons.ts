/**
 * Generate an arrow icon as a data URL for use with deck.gl IconLayer.
 * White arrow on transparent background — colored via getColor at render time.
 */
export function createArrowIconURL(size = 64): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.4;

  // Arrow pointing UP (bearing 0 = north)
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);             // tip (north)
  ctx.lineTo(cx + r * 0.5, cy + r * 0.4);  // bottom-right
  ctx.lineTo(cx, cy + r * 0.15);      // notch
  ctx.lineTo(cx - r * 0.5, cy + r * 0.4);  // bottom-left
  ctx.closePath();

  ctx.fillStyle = "#ffffff";
  ctx.fill();

  return canvas.toDataURL();
}

/** Icon atlas mapping for a single icon */
export const ARROW_ICON_MAPPING = {
  arrow: { x: 0, y: 0, width: 64, height: 64, mask: true },
} as const;
