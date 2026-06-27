// Pixel-art face drawing: eyes, brows, nose, mouth on a grid.
// Reacts to emotion, emotion intensity, live blink and "speaking" mouth open.

const GRID = 32; // logical pixel grid

/**
 * Draw a pixel face onto a square canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size canvas pixel size (square)
 * @param {object} p params
 *   colors: {face, eye, brow, mouth, cheek}
 *   emotion: 'neutral'|'happy'|'sad'|'angry'|'surprised'
 *   intensity: 0..1
 *   mouthOpen: 0..1  (speaking / jaw)
 *   mouthWide: 0..1  (pucker -> narrow 'O' when low width)
 *   blinkL, blinkR: 0..1
 */
export function drawPixelFace(ctx, size, p) {
  const u = size / GRID; // unit
  const colors = p.colors;
  const emo = p.emotion || "neutral";
  const k = clamp01(p.intensity ?? 1);

  // background (skin)
  ctx.fillStyle = colors.face;
  ctx.fillRect(0, 0, size, size);

  const px = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x * u), Math.round(y * u), Math.ceil(w * u), Math.ceil(h * u));
  };

  // cheeks (blush) — stronger when happy
  const blush = emo === "happy" ? 0.4 + k * 0.6 : emo === "angry" ? 0.5 : 0.25;
  ctx.globalAlpha = clamp01(blush);
  px(5, 19, 4, 3, colors.cheek);
  px(23, 19, 4, 3, colors.cheek);
  ctx.globalAlpha = 1;

  // ----- Eyebrows -----
  // slope: + = inner-down (angry), - = inner-up (sad/surprised)
  let browSlope = 0;
  let browLift = 0;
  if (emo === "angry") browSlope = 2 * k;
  else if (emo === "sad") browSlope = -1.5 * k;
  else if (emo === "surprised") {
    browSlope = -1 * k;
    browLift = -2 * k;
  } else if (emo === "happy") browLift = -0.5 * k;

  drawBrow(px, 7, 9 + browLift, browSlope, colors.brow);   // left
  drawBrow(px, 17, 9 + browLift, -browSlope, colors.brow); // right (mirror slope)

  // ----- Eyes -----
  const wide = emo === "surprised" ? 1 + k * 0.6 : 1;
  drawEye(px, 8, 12, colors, p.blinkL ?? 0, wide, emo, k);
  drawEye(px, 18, 12, colors, p.blinkR ?? 0, wide, emo, k);

  // ----- Nose -----
  px(15, 16, 2, 4, shade(colors.face, -0.18));
  px(14, 19, 4, 1, shade(colors.face, -0.18));

  // ----- Mouth -----
  drawMouth(px, ctx, u, colors, emo, k, clamp01(p.mouthOpen ?? 0), clamp01(p.mouthWide ?? 1));
}

function drawBrow(px, x, y, slope, color) {
  for (let i = 0; i < 6; i++) {
    const yy = y + Math.round((i - 2.5) * (slope / 5));
    px(x + i, yy, 1, 1, color);
  }
}

function drawEye(px, cx, cy, colors, blink, wide, emo, k) {
  const h = Math.max(1, Math.round(3 * wide * (1 - blink)));
  const w = Math.round(4 * (emo === "surprised" ? 1 + k * 0.3 : 1));
  if (blink > 0.7) {
    // closed: a line
    px(cx, cy + 1, w, 1, colors.eye);
    return;
  }
  // white
  px(cx, cy, w, h, "#ffffff");
  // pupil
  const pw = Math.max(1, Math.round(w * 0.5));
  px(cx + Math.round((w - pw) / 2), cy, pw, h, colors.eye);
  // happy squint: bottom curve
  if (emo === "happy" && k > 0.4) {
    px(cx, cy + h, w, 1, colors.face);
  }
}

function drawMouth(px, ctx, u, colors, emo, k, open, wide) {
  const cx = 16;
  const baseY = 24;
  const mouthColor = colors.mouth;
  const dark = shade(mouthColor, -0.35);

  if (open > 0.12) {
    // open mouth (speaking / surprised). width narrows with low "wide"
    const ow = Math.round((emo === "surprised" ? 5 : 6) * (0.5 + wide * 0.5));
    const oh = Math.max(1, Math.round(2 + open * 6));
    const x0 = cx - Math.round(ow / 2);
    // outer lips
    px(x0, baseY - 1, ow, oh + 2, mouthColor);
    // inner (mouth cavity)
    px(x0 + 1, baseY, ow - 2, oh, dark);
    // teeth hint on top
    if (open > 0.4) px(x0 + 1, baseY, ow - 2, 1, "#ffffff");
    // tongue hint
    if (open > 0.6) px(x0 + 2, baseY + oh - 1, ow - 4, 1, shade(mouthColor, 0.25));
    return;
  }

  // closed mouth — curve depends on emotion.
  // curve > 0 => smile (U: corners up, center dips down),
  // curve < 0 => frown (∩: center up, corners down). Canvas y grows downward.
  let curve = 0;
  if (emo === "happy") curve = 1 + k * 2;
  else if (emo === "sad") curve = -(1 + k * 1.5);
  else if (emo === "angry") curve = -0.5 * k;

  const width = 8;
  const x0 = cx - width / 2;
  for (let i = 0; i <= width; i++) {
    const t = (i / width) * 2 - 1; // -1..1
    // corners anchored at baseY; center offset by `curve` (down for smile).
    const yy = baseY + Math.round(curve * (1 - t * t));
    px(x0 + i, yy, 1, 1, mouthColor);
    // thickness
    px(x0 + i, yy + 1, 1, 1, dark);
  }
}

/**
 * Draw a user-painted face from a grid of cell colors.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size canvas pixel size (square)
 * @param {Array<string|null>} grid  length gridN*gridN, null = transparent/bg
 * @param {number} gridN grid resolution (e.g. 16)
 * @param {string} bg background color filled before cells
 */
export function drawPaintedFace(ctx, size, grid, gridN, bg) {
  ctx.fillStyle = bg || "#000000";
  ctx.fillRect(0, 0, size, size);
  if (!grid) return;
  const u = size / gridN;
  for (let y = 0; y < gridN; y++) {
    for (let x = 0; x < gridN; x++) {
      const c = grid[y * gridN + x];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(Math.round(x * u), Math.round(y * u), Math.ceil(u), Math.ceil(u));
    }
  }
}

/**
 * Draw only the dynamic mouth layer (for overlaying on a painted face so the
 * speaking / emotion mouth still animates).
 */
export function drawMouthLayer(ctx, size, p) {
  const u = size / GRID;
  const px = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x * u), Math.round(y * u), Math.ceil(w * u), Math.ceil(h * u));
  };
  drawMouth(
    px,
    ctx,
    u,
    { face: p.colors.face, mouth: p.colors.mouth },
    p.emotion || "neutral",
    clamp01(p.intensity ?? 1),
    clamp01(p.mouthOpen ?? 0),
    clamp01(p.mouthWide ?? 1)
  );
}

export { GRID };

// --- color helpers ---
function shade(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + 255 * amt)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
function hexToRgb(hex) {
  const m = hex.replace("#", "");
  const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return {
    r: parseInt(v.substring(0, 2), 16),
    g: parseInt(v.substring(2, 4), 16),
    b: parseInt(v.substring(4, 6), 16),
  };
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
