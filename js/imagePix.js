// Convert an image/video region into a low-res, reduced-color pixel-art grid
// suitable for a paint layer (base). Supports auto palette (median-cut) or a
// fixed palette.

function hexToRgb(hex) {
  const m = hex.replace("#", "");
  const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}
function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}
function nearest(pal, c) {
  let best = pal[0], bd = Infinity;
  for (const p of pal) { const d = dist2(p, c); if (d < bd) { bd = d; best = p; } }
  return best;
}

// Median-cut colour quantization → up to `k` representative colours.
function medianCut(pixels, k) {
  if (!pixels.length) return [[128, 128, 128]];
  let boxes = [pixels];
  while (boxes.length < k) {
    // pick the box with the largest channel range
    let bi = 0, brange = -1, bch = 0;
    boxes.forEach((box, i) => {
      const r = channelRange(box);
      if (r.range > brange) { brange = r.range; bi = i; bch = r.ch; }
    });
    const box = boxes[bi];
    if (box.length < 2) break;
    box.sort((a, b) => a[bch] - b[bch]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    const s = [0, 0, 0];
    for (const p of box) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    return [s[0] / box.length, s[1] / box.length, s[2] / box.length];
  });
}
function channelRange(box) {
  const min = [255, 255, 255], max = [0, 0, 0];
  for (const p of box) for (let c = 0; c < 3; c++) { if (p[c] < min[c]) min[c] = p[c]; if (p[c] > max[c]) max[c] = p[c]; }
  let ch = 0, range = -1;
  for (let c = 0; c < 3; c++) { const r = max[c] - min[c]; if (r > range) { range = r; ch = c; } }
  return { ch, range };
}

/**
 * @param source  drawable (HTMLImageElement / HTMLCanvasElement / HTMLVideoElement)
 * @param crop    {sx, sy, sw, sh} source crop region
 * @param N       output grid resolution (N x N)
 * @param opts    {colorCount, paletteMode:'auto'|'palette', palette:[hex...]}
 * @returns Array<string|null> grid of hex colours (length N*N)
 */
export function imageToGrid(source, crop, N, opts) {
  const c = document.createElement("canvas");
  c.width = N; c.height = N;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;

  const rgb = [];
  for (let i = 0; i < d.length; i += 4) rgb.push([d[i], d[i + 1], d[i + 2], d[i + 3]]);

  let pal;
  if (opts.paletteMode === "palette" && opts.palette && opts.palette.length) {
    pal = opts.palette.map(hexToRgb);
  } else {
    const opaque = rgb.filter((p) => p[3] > 128).map((p) => [p[0], p[1], p[2]]);
    pal = medianCut(opaque, Math.max(2, opts.colorCount || 8));
  }

  const grid = new Array(N * N).fill(null);
  for (let i = 0; i < rgb.length; i++) {
    if (rgb[i][3] < 100) { grid[i] = null; continue; }
    grid[i] = rgbToHex(nearest(pal, rgb[i]));
  }
  return grid;
}

// Square center-crop for an arbitrary drawable of the given natural size.
export function centerSquare(w, h) {
  const s = Math.min(w, h);
  return { sx: (w - s) / 2, sy: (h - s) / 2, sw: s, sh: s };
}
