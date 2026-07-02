// Face rig: composites painted layers (base / brows / eyes / mouth) onto a cube
// face. Brows / eyes / mouth are drawn as WHOLE connected shapes and moved /
// rotated / scaled as a unit (not sliced per pixel) by emotion + blink + open.

export const REGIONS = {
  brows: { x0: 0.05, y0: 0.26, x1: 0.95, y1: 0.45 },
  eyes: { x0: 0.05, y0: 0.42, x1: 0.95, y1: 0.66 },
  mouth: { x0: 0.15, y0: 0.66, x1: 0.85, y1: 0.96 },
};

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Per-emotion transform parameters (scaled by intensity k).
// Angles in radians (canvas: +θ = clockwise). Translations in grid-cell units.
function emoParams(emotion, k) {
  const lerp = (t) => 1 + (t - 1) * k;
  const p = {
    eyeScaleY: 1, eyeSize: 1, eyeTilt: 0,   // eyeTilt: + = outer corner DOWN
    browTilt: 0, browTransY: 0,             // browTilt: + = inner end DOWN
    mouthDY: 0, mouthScaleX: 1,
  };
  switch (emotion) {
    case "happy":
      p.eyeScaleY = lerp(0.6); p.eyeTilt = -0.28 * k; p.browTilt = -0.18 * k;
      p.browTransY = -0.4 * k; p.mouthDY = -0.25 * k; p.mouthScaleX = lerp(1.15);
      break;
    case "sad":
      p.eyeTilt = 0.55 * k; p.browTilt = -0.6 * k; p.browTransY = -0.2 * k; p.mouthDY = 0.4 * k;
      break;
    case "angry":
      p.browTilt = 0.75 * k; p.browTransY = 0.55 * k; p.eyeTilt = -0.5 * k;
      p.eyeScaleY = lerp(0.8); p.mouthDY = 0.15 * k;
      break;
    case "surprised":
      p.eyeSize = lerp(1.3); p.eyeScaleY = lerp(1.3); p.browTransY = -1.3 * k;
      p.mouthDY = 0.35 * k; p.mouthScaleX = lerp(0.9);
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

// Centroid + bounds (cell units), optionally restricted to a horizontal side.
function stats(grid, N, side) {
  let sx = 0, sy = 0, n = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  forEachCell(grid, N, (x, y) => {
    if (side === "L" && x >= N / 2) return;
    if (side === "R" && x < N / 2) return;
    sx += x + 0.5; sy += y + 0.5; n++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  });
  if (!n) return null;
  return { cx: sx / n, cy: sy / n, minX, maxX, minY, maxY, n };
}

// Reusable offscreen canvas for rendering a layer before compositing.
let _tmp = null, _tmpCtx = null;
function tmpCanvas(size) {
  if (!_tmp) { _tmp = document.createElement("canvas"); _tmpCtx = _tmp.getContext("2d"); }
  if (_tmp.width !== size) { _tmp.width = size; _tmp.height = size; }
  _tmpCtx.clearRect(0, 0, size, size);
  return _tmp;
}

function renderGrid(ctx, grid, N, size) {
  const u = size / N;
  forEachCell(grid, N, (x, y, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(x * u), Math.round(y * u), Math.ceil(u), Math.ceil(u));
  });
}

// Composite a sub-region of `src` onto dest as a rigid transform around a pivot.
function blit(dest, src, sxr, sw, size, piv, rot, sx, sy, dx, dy) {
  dest.save();
  dest.imageSmoothingEnabled = false; // keep crisp pixels
  dest.translate(piv.x + dx, piv.y + dy);
  if (rot) dest.rotate(rot);
  if (sx !== 1 || sy !== 1) dest.scale(sx, sy);
  dest.translate(-piv.x, -piv.y);
  dest.drawImage(src, sxr, 0, sw, size, sxr, 0, sw, size);
  dest.restore();
}

function drawBase(ctx, grid, N, size) {
  renderGrid(ctx, grid, N, size);
}

function drawBrows(ctx, grid, N, size, p) {
  if (!grid) return;
  const u = size / N;
  const tc = tmpCanvas(size);
  renderGrid(_tmpCtx, grid, N, size);
  const dy = p.browTransY * u;
  for (const side of ["L", "R"]) {
    const s = stats(grid, N, side); if (!s) continue;
    const piv = { x: s.cx * u, y: s.cy * u };
    const rot = side === "L" ? p.browTilt : -p.browTilt; // mirror inner-end tilt
    blit(ctx, tc, side === "L" ? 0 : size / 2, size / 2, size, piv, rot, 1, 1, 0, dy);
  }
}

function drawEyes(ctx, grid, N, size, p, blinkL, blinkR) {
  if (!grid) return;
  const tc = tmpCanvas(size);
  renderGrid(_tmpCtx, grid, N, size);
  for (const side of ["L", "R"]) {
    const s = stats(grid, N, side); if (!s) continue;
    const piv = { x: s.cx * (size / N), y: s.cy * (size / N) };
    const blink = side === "L" ? blinkL : blinkR;
    const sy = Math.max(0.12, p.eyeSize * p.eyeScaleY * (1 - clamp01(blink) * 0.92));
    const sx = p.eyeSize;
    const rot = side === "L" ? -p.eyeTilt : p.eyeTilt; // outer-corner tilt, mirrored
    blit(ctx, tc, side === "L" ? 0 : size / 2, size / 2, size, piv, rot, sx, sy, 0, 0);
  }
}

function drawMouth(ctx, grid, N, size, p, mouthOpen, mouthWide) {
  if (!grid) return;
  const u = size / N;
  const s = stats(grid, N, null); if (!s) return;
  const tc = tmpCanvas(size);
  renderGrid(_tmpCtx, grid, N, size);
  // Jaw drop: pivot at the TOP of the mouth so scaleY opens it downward.
  const piv = { x: s.cx * u, y: s.minY * u };
  const sy = 1 + clamp01(mouthOpen) * 1.3; // open
  const sx = (mouthWide ?? 1) * p.mouthScaleX; // wide / pucker + emotion width
  const dy = p.mouthDY * u;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(piv.x, piv.y + dy);
  ctx.scale(sx, sy);
  ctx.translate(-piv.x, -piv.y);
  ctx.drawImage(tc, 0, 0);
  ctx.restore();
}

// Compute transformed cell centers (grid units) for the animated feature layers
// — used to place 3D extruded blocks that match the flat rig.
export function computeBlocks(layers, N, params) {
  const emotion = params.emotion || "neutral";
  const k = clamp01(params.intensity ?? 1);
  const p = emoParams(emotion, k);
  const out = [];
  // Each block carries the SAME scale (sx,sy) and rotation as the whole-shape
  // affine, so the blocks tile seamlessly (no gaps) — like the flat rig.
  const tf = (x, y, c, s, sx, sy, rot, dy) => {
    let vx = (x + 0.5 - s.cx) * sx, vy = (y + 0.5 - s.cy) * sy;
    if (rot) { const co = Math.cos(rot), si = Math.sin(rot); const nx = vx * co - vy * si, ny = vx * si + vy * co; vx = nx; vy = ny; }
    out.push({ cx: s.cx + vx, cy: s.cy + vy + dy, sx, sy, rot, color: c });
  };
  if (layers && layers.brows) {
    const sides = { L: stats(layers.brows, N, "L"), R: stats(layers.brows, N, "R") };
    forEachCell(layers.brows, N, (x, y, c) => {
      const s = sides[x < N / 2 ? "L" : "R"]; if (!s) return;
      tf(x, y, c, s, 1, 1, x < N / 2 ? p.browTilt : -p.browTilt, p.browTransY);
    });
  }
  if (layers && layers.eyes) {
    const sides = { L: stats(layers.eyes, N, "L"), R: stats(layers.eyes, N, "R") };
    forEachCell(layers.eyes, N, (x, y, c) => {
      const side = x < N / 2 ? "L" : "R"; const s = sides[side]; if (!s) return;
      const blink = side === "L" ? params.blinkL ?? 0 : params.blinkR ?? 0;
      const sy = Math.max(0.12, p.eyeSize * p.eyeScaleY * (1 - clamp01(blink) * 0.92));
      tf(x, y, c, s, p.eyeSize, sy, side === "L" ? -p.eyeTilt : p.eyeTilt, 0);
    });
  }
  if (layers && layers.mouth) {
    const s = stats(layers.mouth, N, null);
    if (s) {
      const sx = (params.mouthWide ?? 1) * p.mouthScaleX;
      const sy = 1 + clamp01(params.mouthOpen ?? 0) * 1.3;
      const top = { cx: s.cx, cy: s.minY };
      forEachCell(layers.mouth, N, (x, y, c) => tf(x, y, c, top, sx, sy, 0, p.mouthDY));
    }
  }
  return out;
}

/** Composite painted layers statically (no animation) — used for cube sides. */
export function drawLayeredStatic(ctx, size, layers, N, faceColor) {
  ctx.fillStyle = faceColor;
  ctx.fillRect(0, 0, size, size);
  if (!layers) return;
  drawBase(ctx, layers.base, N, size);
  drawBase(ctx, layers.brows, N, size);
  drawBase(ctx, layers.eyes, N, size);
  drawBase(ctx, layers.mouth, N, size);
}

/** Composite + animate the front face from emotion / blink / mouth open. */
export function drawRiggedFace(ctx, size, layers, N, params, faceColor) {
  ctx.fillStyle = faceColor;
  ctx.fillRect(0, 0, size, size);
  if (!layers) return;
  const emotion = params.emotion || "neutral";
  const k = clamp01(params.intensity ?? 1);
  const p = emoParams(emotion, k);
  drawBase(ctx, layers.base, N, size);
  drawBrows(ctx, layers.brows, N, size, p);
  drawEyes(ctx, layers.eyes, N, size, p, params.blinkL ?? 0, params.blinkR ?? 0);
  drawMouth(ctx, layers.mouth, N, size, p, params.mouthOpen ?? 0, params.mouthWide ?? 1);
}
