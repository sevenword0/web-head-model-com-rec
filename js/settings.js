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
  // painted face (grid pixel painting) — defaults to a Minecraft Steve face
  faceMode: "painted", // 'procedural' | 'painted'
  gridN: 8,
  paintGrid: buildSteveGrid(), // Array<string|null> length gridN*gridN
  paintOverlayMouth: true,
  // capture
  audio: true,
  showVideo: true,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return { ...DEFAULTS, ...JSON.parse(raw) };
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
        resolve({ ...DEFAULTS, ...JSON.parse(reader.result) });
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
