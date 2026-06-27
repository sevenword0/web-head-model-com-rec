// Face rig: composites painted layers (base / brows / eyes / mouth) onto a cube
// face, animating brows/eyes/mouth procedurally from emotion + blink + mouth open.

// Editor guide regions (fractions of the grid) for where to paint each layer.
export const REGIONS = {
  brows: { x0: 0.05, y0: 0.26, x1: 0.95, y1: 0.45 },
  eyes: { x0: 0.05, y0: 0.42, x1: 0.95, y1: 0.66 },
  mouth: { x0: 0.15, y0: 0.66, x1: 0.85, y1: 0.96 },
};

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Per-emotion transform parameters (already scaled by intensity k).
function emoParams(emotion, k) {
  const lerp = (target) => 1 + (target - 1) * k; // for scale-like (1 = identity)
  const p = {
    eyeScaleY: 1, eyeSize: 1, eyeTilt: 0,   // tilt: + = outer corner down
    browInner: 0, browTransY: 0,            // browInner: + = inner end down
    mouthBend: 0,                            // + = frown (corners down), - = smile
  };
  switch (emotion) {
    case "happy":
      p.eyeScaleY = lerp(0.62); p.mouthBend = -1.4 * k; p.browTransY = -0.2 * k; p.browInner = -0.1 * k;
      break;
    case "sad":
      p.eyeTilt = 0.55 * k; p.browInner = -0.8 * k; p.browTransY = -0.15 * k; p.mouthBend = 1.1 * k;
      break;
    case "angry":
      p.browInner = 0.9 * k; p.browTransY = 0.35 * k; p.eyeTilt = -0.3 * k;
      p.eyeScaleY = lerp(0.85); p.mouthBend = 0.5 * k;
      break;
    case "surprised":
      p.eyeSize = lerp(1.25); p.eyeScaleY = lerp(1.2); p.browTransY = -1.15 * k; p.mouthBend = 0;
      break;
    default:
      break;
  }
  return p;
}

function forEachCell(grid, N, fn) {
  if (!grid) return;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = grid[y * N + x];
      if (c) fn(x, y, c);
    }
  }
}

// Centroid + horizontal extent of cells (optionally restricted to a side).
function stats(grid, N, side) {
  let sx = 0, sy = 0, n = 0, minX = Infinity, maxX = -Infinity;
  forEachCell(grid, N, (x, y) => {
    if (side === "L" && x >= N / 2) return;
    if (side === "R" && x < N / 2) return;
    sx += x + 0.5; sy += y + 0.5; n++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  });
  if (!n) return null;
  return { cx: sx / n, cy: sy / n, minX, maxX, span: (maxX - minX) || 1, n };
}

function fillCell(ctx, u, ncx, ncy, cw, ch, col) {
  ctx.fillStyle = col;
  ctx.fillRect((ncx - cw / 2) * u, (ncy - ch / 2) * u, Math.ceil(cw * u), Math.ceil(ch * u));
}

function drawBase(ctx, u, grid, N) {
  forEachCell(grid, N, (x, y, c) => fillCell(ctx, u, x + 0.5, y + 0.5, 1, 1, c));
}

function drawBrows(ctx, u, grid, N, p) {
  const sides = { L: stats(grid, N, "L"), R: stats(grid, N, "R") };
  forEachCell(grid, N, (x, y, c) => {
    const side = x < N / 2 ? "L" : "R";
    const s = sides[side]; if (!s) return;
    const inner = side === "L" ? (x - s.minX) / s.span : (s.maxX - x) / s.span; // 1 at inner
    let ny = (y + 0.5) + p.browTransY + p.browInner * (inner - 0.5) * 2;
    fillCell(ctx, u, x + 0.5, ny, 1, 1, c);
  });
}

function drawEyes(ctx, u, grid, N, p, blinkL, blinkR) {
  const sides = { L: stats(grid, N, "L"), R: stats(grid, N, "R") };
  forEachCell(grid, N, (x, y, c) => {
    const side = x < N / 2 ? "L" : "R";
    const s = sides[side]; if (!s) return;
    const blink = side === "L" ? blinkL : blinkR;
    const sx = p.eyeSize;
    const sy = (1 - clamp01(blink) * 0.95) * p.eyeScaleY * p.eyeSize;
    const outer = side === "L" ? (s.maxX - x) / s.span : (x - s.minX) / s.span; // 1 at outer
    const ncx = s.cx + (x + 0.5 - s.cx) * sx;
    let ncy = s.cy + (y + 0.5 - s.cy) * sy + p.eyeTilt * (outer - 0.5) * 2;
    fillCell(ctx, u, ncx, ncy, sx, Math.max(0.12, sy), c);
  });
}

function drawMouth(ctx, u, grid, N, p, mouthOpen, mouthWide) {
  const s = stats(grid, N, null); if (!s) return;
  const halfW = Math.max(s.cx - s.minX, s.maxX - s.cx) || 1;
  const sy = 1 + clamp01(mouthOpen) * 1.4;
  const wide = mouthWide ?? 1;
  forEachCell(grid, N, (x, y, c) => {
    const t = (x + 0.5 - s.cx) / halfW;
    const ncx = s.cx + (x + 0.5 - s.cx) * wide;
    let ncy = s.cy + (y + 0.5 - s.cy) * sy;
    ncy += (y + 0.5 >= s.cy ? 1 : -1) * clamp01(mouthOpen) * 1.0; // open gap
    ncy += p.mouthBend * (t * t);                                  // bend up/down
    fillCell(ctx, u, ncx, ncy, wide, sy, c);
  });
}

/** Composite painted layers statically (no animation) — used for cube sides. */
export function drawLayeredStatic(ctx, size, layers, N, faceColor) {
  const u = size / N;
  ctx.fillStyle = faceColor;
  ctx.fillRect(0, 0, size, size);
  if (!layers) return;
  drawBase(ctx, u, layers.base, N);
  drawBase(ctx, u, layers.brows, N);
  drawBase(ctx, u, layers.eyes, N);
  drawBase(ctx, u, layers.mouth, N);
}

/** Composite + animate the front face from emotion / blink / mouth open. */
export function drawRiggedFace(ctx, size, layers, N, params, faceColor) {
  const u = size / N;
  ctx.fillStyle = faceColor;
  ctx.fillRect(0, 0, size, size);
  if (!layers) return;
  const emotion = params.emotion || "neutral";
  const k = clamp01(params.intensity ?? 1);
  const p = emoParams(emotion, k);
  drawBase(ctx, u, layers.base, N);
  drawBrows(ctx, u, layers.brows, N, p);
  drawEyes(ctx, u, layers.eyes, N, p, params.blinkL ?? 0, params.blinkR ?? 0);
  drawMouth(ctx, u, layers.mouth, N, p, params.mouthOpen ?? 0, params.mouthWide ?? 1);
}
