// FaceTracker: wraps MediaPipe Tasks-Vision FaceLandmarker.
// Provides head pose (4x4 matrix), 478 landmarks, and 52 ARKit blendshapes.
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";

const WASM_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.ready = false;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    } catch (e) {
      // Fall back to CPU delegate if GPU is unavailable.
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    }
    this.ready = true;
  }

  /**
   * @returns {null | {landmarks, blendshapes: Map<string,number>, matrix: number[]}}
   */
  detect(video, timestampMs) {
    if (!this.ready || !this.landmarker) return null;
    const res = this.landmarker.detectForVideo(video, timestampMs);
    if (!res || !res.faceLandmarks || res.faceLandmarks.length === 0) return null;

    const blendshapes = new Map();
    if (res.faceBlendshapes && res.faceBlendshapes[0]) {
      for (const c of res.faceBlendshapes[0].categories) {
        blendshapes.set(c.categoryName, c.score);
      }
    }
    const matrix =
      res.facialTransformationMatrixes && res.facialTransformationMatrixes[0]
        ? res.facialTransformationMatrixes[0].data
        : null;

    return { landmarks: res.faceLandmarks[0], blendshapes, matrix };
  }
}
