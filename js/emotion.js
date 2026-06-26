// Emotion analysis + synthesis from ARKit blendshapes.

const EMOTIONS = ["neutral", "happy", "sad", "angry", "surprised"];

function g(map, name) {
  return map.get(name) || 0;
}

/**
 * Estimate emotion scores (0..1) from a live blendshape map.
 * @returns {{ scores: Record<string,number>, top: string, intensity: number }}
 */
export function analyzeEmotion(bs) {
  const smile = (g(bs, "mouthSmileLeft") + g(bs, "mouthSmileRight")) / 2;
  const frown = (g(bs, "mouthFrownLeft") + g(bs, "mouthFrownRight")) / 2;
  const browDown = (g(bs, "browDownLeft") + g(bs, "browDownRight")) / 2;
  const browInner = g(bs, "browInnerUp");
  const browOuter = (g(bs, "browOuterUpLeft") + g(bs, "browOuterUpRight")) / 2;
  const eyeWide = (g(bs, "eyeWideLeft") + g(bs, "eyeWideRight")) / 2;
  const jawOpen = g(bs, "jawOpen");
  const noseSneer = (g(bs, "noseSneerLeft") + g(bs, "noseSneerRight")) / 2;
  const cheekSquint = (g(bs, "cheekSquintLeft") + g(bs, "cheekSquintRight")) / 2;
  const mouthPress = (g(bs, "mouthPressLeft") + g(bs, "mouthPressRight")) / 2;

  const scores = {
    happy: clamp01(smile * 1.2 + cheekSquint * 0.5),
    sad: clamp01(frown * 1.1 + browInner * 0.6),
    angry: clamp01(browDown * 1.2 + noseSneer * 0.5 + mouthPress * 0.4),
    surprised: clamp01(eyeWide * 0.9 + browOuter * 0.6 + browInner * 0.4 + jawOpen * 0.5),
    neutral: 0,
  };

  let top = "neutral";
  let max = 0;
  for (const e of EMOTIONS) {
    if (e === "neutral") continue;
    if (scores[e] > max) {
      max = scores[e];
      top = e;
    }
  }
  // If nothing is strong enough, it's neutral.
  if (max < 0.18) {
    top = "neutral";
  }
  scores.neutral = clamp01(1 - max);

  return { scores, top, intensity: clamp01(max) };
}

/**
 * Build a synthetic blendshape map for a chosen emotion + intensity.
 * Used in manual emotion mode and to drive both the cube face and GLB morphs.
 */
export function synthesizeBlendshapes(emotion, intensity) {
  const m = new Map();
  const k = clamp01(intensity);
  switch (emotion) {
    case "happy":
      set(m, "mouthSmileLeft", k);
      set(m, "mouthSmileRight", k);
      set(m, "cheekSquintLeft", k * 0.6);
      set(m, "cheekSquintRight", k * 0.6);
      set(m, "eyeSquintLeft", k * 0.3);
      set(m, "eyeSquintRight", k * 0.3);
      break;
    case "sad":
      set(m, "mouthFrownLeft", k);
      set(m, "mouthFrownRight", k);
      set(m, "browInnerUp", k * 0.8);
      set(m, "mouthLowerDownLeft", k * 0.2);
      set(m, "mouthLowerDownRight", k * 0.2);
      break;
    case "angry":
      set(m, "browDownLeft", k);
      set(m, "browDownRight", k);
      set(m, "noseSneerLeft", k * 0.5);
      set(m, "noseSneerRight", k * 0.5);
      set(m, "mouthPressLeft", k * 0.4);
      set(m, "mouthPressRight", k * 0.4);
      break;
    case "surprised":
      set(m, "eyeWideLeft", k);
      set(m, "eyeWideRight", k);
      set(m, "browInnerUp", k);
      set(m, "browOuterUpLeft", k * 0.8);
      set(m, "browOuterUpRight", k * 0.8);
      set(m, "jawOpen", k * 0.55);
      break;
    case "neutral":
    default:
      break;
  }
  return m;
}

function set(m, k, v) {
  m.set(k, v);
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export { EMOTIONS };
