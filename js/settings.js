// Settings: default state, persistence to localStorage, named presets, JSON I/O.

const STORAGE_KEY = "headStudio.settings";
const PRESET_KEY = "headStudio.presets";

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
  faceColor: "#f1c27d",
  cubeColor: "#d9a066",
  eyeColor: "#2b2b2b",
  browColor: "#5a3a1a",
  mouthColor: "#b5403a",
  cheekColor: "#e88f8f",
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
