// Settings: default state, persistence to localStorage, named presets, JSON I/O.

const STORAGE_KEY = "headStudio.settings";
const PRESET_KEY = "headStudio.presets";

// Minecraft Steve-style 8x8 face as a paint grid.
// H=hair S=skin B=brow W=eyeWhite I=iris M=mouth/mustache
export const STEVE_SKIN = "#b58868";
export function buildSteveGrid() {
  const H = "#4b3621", S = "#b58868", B = "#46352b",
        W = "#e9e9e9", I = "#3f3a8c", M = "#6c4f33";
  return [
    H, H, H, H, H, H, H, H,
    H, H, H, H, H, H, H, H,
    S, S, S, S, S, S, S, S,
    S, B, B, S, S, B, B, S,
    S, W, I, S, S, I, W, S,
    S, S, M, M, M, M, S, S,
    S, S, S, M, M, S, S, S,
    S, S, S, S, S, S, S, S,
  ];
}

// Cube faces and emotions used by the per-face / per-expression painting.
export const FACE_KEYS = ["front", "back", "left", "right", "top", "bottom"];
export const FACE_LABELS = { front: "앞", back: "뒤", left: "왼쪽", right: "오른쪽", top: "위", bottom: "아래" };
export const EMO_KEYS = ["neutral", "happy", "sad", "angry", "surprised"];
export const EMO_LABELS = { neutral: "중립", happy: "기쁨", sad: "슬픔", angry: "분노", surprised: "놀람" };

function emptyEmotionSet() {
  const o = {};
  for (const e of EMO_KEYS) o[e] = null;
  return o;
}

// Build the default paint set: Steve on the front (neutral), everything else empty.
export function buildDefaultPaintFaces() {
  const faces = {};
  for (const f of FACE_KEYS) faces[f] = emptyEmotionSet();
  faces.front.neutral = buildSteveGrid();
  return faces;
}

export const DEFAULTS = {
  headType: "cube",
  mirror: true,
  // alignment
  scale: 1,
  offsetX: 0,
  offsetY: 0,
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
  // capture
  audio: true,
  showVideo: true,
};

// Ensure a settings object has a well-formed paintFaces structure (and migrate
// the old single `paintGrid` field into front/neutral).
export function normalizeSettings(s) {
  if (!s.paintFaces || typeof s.paintFaces !== "object") {
    s.paintFaces = buildDefaultPaintFaces();
    if (Array.isArray(s.paintGrid)) {
      for (const f of FACE_KEYS) s.paintFaces[f] = emptyEmotionSet();
      s.paintFaces.front.neutral = s.paintGrid;
    }
  } else {
    for (const f of FACE_KEYS) {
      if (!s.paintFaces[f] || typeof s.paintFaces[f] !== "object") {
        s.paintFaces[f] = emptyEmotionSet();
      } else {
        for (const e of EMO_KEYS) {
          if (!(e in s.paintFaces[f])) s.paintFaces[f][e] = null;
        }
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
