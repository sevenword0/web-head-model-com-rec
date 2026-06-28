// Settings: default state, persistence to localStorage, named presets, JSON I/O.

const STORAGE_KEY = "headStudio.settings";
const PRESET_KEY = "headStudio.presets";

export const STEVE_SKIN = "#b58868";

// Cube faces and the per-face paint LAYERS. Eyes / brows / mouth are separate
// layers so they can be animated (blink, tilt, open, bend) by the face rig.
export const FACE_KEYS = ["front", "back", "left", "right", "top", "bottom"];
export const FACE_LABELS = { front: "앞", back: "뒤", left: "왼쪽", right: "오른쪽", top: "위", bottom: "아래" };
export const LAYER_KEYS = ["base", "brows", "eyes", "mouth"];
export const LAYER_LABELS = { base: "베이스", brows: "눈썹", eyes: "눈", mouth: "입" };

function emptyLayerSet() {
  const o = {};
  for (const l of LAYER_KEYS) o[l] = null;
  return o;
}

// Minecraft Steve face split into animatable layers (8x8).
// H=hair S=skin B=brow W=eyeWhite I=iris M=mouth/mustache
export function buildSteveLayers() {
  const H = "#4b3621", S = "#b58868", B = "#46352b",
        W = "#e9e9e9", I = "#3f3a8c", M = "#6c4f33", _ = null;
  const base = [
    H, H, H, H, H, H, H, H,
    H, H, H, H, H, H, H, H,
    S, S, S, S, S, S, S, S,
    S, S, S, S, S, S, S, S,
    S, S, S, S, S, S, S, S,
    S, S, S, S, S, S, S, S,
    S, S, S, S, S, S, S, S,
    S, S, S, S, S, S, S, S,
  ];
  const brows = [
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, B, B, _, _, B, B, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
  ];
  const eyes = [
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, W, I, _, _, I, W, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
  ];
  const mouth = [
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, _, _, _, _, _, _,
    _, _, M, M, M, M, _, _,
    _, _, _, M, M, _, _, _,
    _, _, _, _, _, _, _, _,
  ];
  return { base, brows, eyes, mouth };
}

// Build the default paint set: Steve layers on the front, others empty.
export function buildDefaultPaintFaces() {
  const faces = {};
  for (const f of FACE_KEYS) faces[f] = emptyLayerSet();
  faces.front = buildSteveLayers();
  return faces;
}

export const DEFAULTS = {
  headType: "cube",
  mirror: true,
  // alignment
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0, // depth position (toward/away from camera)
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  // emotion
  emotionMode: "auto",
  manualEmotion: "neutral",
  intensity: 1,
  exprStrength: 1,
  speaking: true,
  // appearance
  faceColor: "#b58868", // Steve skin tone by default
  cubeColor: "#9b7253",
  eyeColor: "#2b2b2b",
  browColor: "#46352b",
  mouthColor: "#6c4f33",
  cheekColor: "#e88f8f",
  // painted faces (grid pixel painting) — per cube face × per expression
  faceMode: "painted", // 'procedural' | 'painted'
  gridN: 8,
  paintFaces: buildDefaultPaintFaces(),
  paintOverlayMouth: true,
  // render (3D)
  fov: 30,                // perspective field of view (deg); low = near-orthographic
  lightPreset: "studio",  // virtual environment light preset
  lightAuto: true,        // auto-pick preset from the input video (default on)
  lightIntensity: 1,      // global light multiplier
  metalness: 0,           // material reflectivity
  roughness: 0.85,        // material roughness
  // capture
  audio: true,
  showVideo: true,
};

// Virtual environment light presets. Each light: [color, intensity, [dirX,dirY,dirZ]?].
export const LIGHT_ORDER = ["studio", "soft", "warm", "cool", "top", "dramatic"];
export const LIGHT_PRESETS = {
  studio:   { label: "스튜디오", ambient: ["#ffffff", 0.85], key: ["#ffffff", 1.0, [0.3, 0.6, 1]],   fill: ["#ffffff", 0.4, [-0.6, 0.2, 0.7]], rim: ["#ffffff", 0.25, [0, 0.4, -1]], hemi: ["#ffffff", "#444444", 0.3] },
  soft:     { label: "부드럽게", ambient: ["#ffffff", 1.3],  key: ["#ffffff", 0.45, [0.2, 0.5, 1]],  fill: ["#ffffff", 0.5, [-0.5, 0.3, 0.8]], rim: ["#ffffff", 0.1, [0, 0.5, -1]],  hemi: ["#ffffff", "#888888", 0.5] },
  warm:     { label: "노을(따뜻)", ambient: ["#ffd9a0", 0.6], key: ["#ffb060", 1.1, [0.5, 0.4, 0.8]], fill: ["#ffcaa0", 0.35, [-0.6, 0.1, 0.6]], rim: ["#ffe0b0", 0.3, [-0.3, 0.5, -1]], hemi: ["#ffd9a0", "#402810", 0.3] },
  cool:     { label: "야간(차가움)", ambient: ["#90a8ff", 0.4], key: ["#a8c4ff", 0.7, [0.2, 0.5, 1]], fill: ["#7088c0", 0.25, [-0.5, 0.2, 0.7]], rim: ["#c0d0ff", 0.35, [0, 0.4, -1]], hemi: ["#a0b8ff", "#101830", 0.25] },
  top:      { label: "탑라이트", ambient: ["#ffffff", 0.5],  key: ["#ffffff", 1.2, [0, 1, 0.2]],     fill: ["#ffffff", 0.25, [0, -0.4, 1]],   rim: ["#ffffff", 0.2, [0, 0.6, -1]],  hemi: ["#ffffff", "#303030", 0.3] },
  dramatic: { label: "드라마틱", ambient: ["#ffffff", 0.2],  key: ["#ffffff", 1.5, [0.9, 0.3, 0.5]], fill: ["#6080ff", 0.15, [-0.8, 0.1, 0.5]], rim: ["#ffffff", 0.5, [-0.4, 0.5, -1]], hemi: ["#404040", "#000000", 0.15] },
};

// Ensure a settings object has a well-formed layered paintFaces structure,
// migrating older formats (single paintGrid, or per-emotion grids) into layers.
export function normalizeSettings(s) {
  if (!s.paintFaces || typeof s.paintFaces !== "object") {
    s.paintFaces = buildDefaultPaintFaces();
    if (Array.isArray(s.paintGrid)) {
      for (const f of FACE_KEYS) s.paintFaces[f] = emptyLayerSet();
      s.paintFaces.front.base = s.paintGrid;
    }
  } else {
    for (const f of FACE_KEYS) {
      const cur = s.paintFaces[f];
      if (!cur || typeof cur !== "object") {
        s.paintFaces[f] = emptyLayerSet();
      } else if (!("base" in cur)) {
        // old per-emotion format → use the neutral grid as the base layer
        const set = emptyLayerSet();
        if (Array.isArray(cur.neutral)) set.base = cur.neutral;
        s.paintFaces[f] = set;
      } else {
        for (const l of LAYER_KEYS) if (!(l in cur)) cur[l] = null;
      }
    }
  }
  delete s.paintGrid;
  return s;
}

// A fresh default state with its own (non-shared) paintFaces object.
export function freshDefaults() {
  return normalizeSettings({ ...DEFAULTS, paintFaces: undefined });
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // paintFaces:undefined first so a saved value overrides; otherwise normalize
    // allocates a fresh one instead of sharing DEFAULTS.paintFaces.
    return normalizeSettings({ ...DEFAULTS, paintFaces: undefined, ...JSON.parse(raw) });
  } catch {
    return null;
  }
}

export function saveSettings(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearSettings() {
  localStorage.removeItem(STORAGE_KEY);
}

// ---- named presets ----
export function getPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESET_KEY) || "{}");
  } catch {
    return {};
  }
}

export function savePreset(name, state) {
  const presets = getPresets();
  presets[name] = state;
  localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
}

export function deletePreset(name) {
  const presets = getPresets();
  delete presets[name];
  localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
}

// ---- JSON file import/export ----
export function exportJSON(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "head-settings.json";
  a.click();
  URL.revokeObjectURL(url);
}

export function importJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(normalizeSettings({ ...DEFAULTS, paintFaces: undefined, ...JSON.parse(reader.result) }));
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
