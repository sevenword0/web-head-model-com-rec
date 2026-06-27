// HeadRenderer: Three.js scene that draws either a pixel-face cube or a loaded
// GLB model, aligned onto the tracked face using landmarks + head-pose matrix.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { drawPixelFace, drawPaintedFace, drawMouthLayer } from "./pixelFace.js";

// Landmark indices (MediaPipe FaceMesh)
const L = {
  leftEye: 33,
  rightEye: 263,
  noseTip: 1,
  chin: 152,
  foreheadTop: 10,
  leftCheek: 234,
  rightCheek: 454,
};

export class HeadRenderer {
  constructor(width, height) {
    this.width = width;
    this.height = height;

    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    // Orthographic camera matching pixel space (origin center, y up).
    this.camera = new THREE.OrthographicCamera(
      -width / 2, width / 2, height / 2, -height / 2, -2000, 2000
    );
    this.camera.position.z = 500;

    // Lighting
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(0.3, 0.6, 1);
    this.scene.add(dir);

    // Root holds the head and is positioned/rotated each frame.
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.headType = "cube";
    this.morphTargets = []; // {mesh, index, name}

    // Painted-face state
    this.faceMode = "procedural"; // 'procedural' | 'painted'
    this.paintFaces = null; // { face: { emotion: grid|null } }
    this.paintGridN = 8;
    this.paintOverlayMouth = true;
    this._faceDirty = true; // redraw static (non-front) faces
    this._lastEmotion = null;

    this._buildCube();

    this.colors = {
      face: "#f1c27d",
      cube: "#d9a066",
      eye: "#2b2b2b",
      brow: "#5a3a1a",
      mouth: "#b5403a",
      cheek: "#e88f8f",
    };
    this.refreshCubeColors();
  }

  // ---------- Cube head with per-face canvas textures ----------
  _buildCube() {
    // BoxGeometry material order: +x(right), -x(left), +y(top), -y(bottom), +z(front), -z(back)
    this.FACE_INDEX = { right: 0, left: 1, top: 2, bottom: 3, front: 4, back: 5 };
    this.faces = {}; // faceKey -> {canvas, ctx, texture, material}

    const mats = new Array(6);
    for (const [key, idx] of Object.entries(this.FACE_INDEX)) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.LinearFilter;
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85 });
      this.faces[key] = { canvas, ctx, texture, material };
      mats[idx] = material;
    }
    // Convenience handle to the front face (used by procedural drawing).
    this.faceCanvas = this.faces.front.canvas;
    this.faceCtx = this.faces.front.ctx;
    this.faceTexture = this.faces.front.texture;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.cube = new THREE.Mesh(geo, mats);
    this.cubeGroup = new THREE.Group();
    this.cubeGroup.add(this.cube);
  }

  refreshCubeColors() {
    this._faceDirty = true;
  }

  // Draw a single cube face's static content for a given emotion.
  _drawFaceStatic(key, emotion) {
    const f = this.faces[key];
    const size = f.canvas.width;
    if (this.faceMode === "painted" && this.paintFaces) {
      const set = this.paintFaces[key] || {};
      const grid = set[emotion] || set.neutral || null;
      if (grid) {
        drawPaintedFace(f.ctx, size, grid, this.paintGridN, this.colors.face);
      } else {
        f.ctx.fillStyle = this.colors.cube;
        f.ctx.fillRect(0, 0, size, size);
      }
    } else {
      // procedural: only the front carries the drawn face; sides are solid.
      f.ctx.fillStyle = this.colors.cube;
      f.ctx.fillRect(0, 0, size, size);
    }
    f.texture.needsUpdate = true;
  }

  _colors() {
    return {
      face: this.colors.face,
      eye: this.colors.eye,
      brow: this.colors.brow,
      mouth: this.colors.mouth,
      cheek: this.colors.cheek,
    };
  }

  /** Redraw the cube face textures. Sides are redrawn only when dirty; the
   *  front is redrawn every frame so the mouth / expression animates. */
  updateFace(params) {
    const emotion = params.emotion || "neutral";
    if (emotion !== this._lastEmotion) {
      this._lastEmotion = emotion;
      this._faceDirty = true;
    }

    if (this._faceDirty) {
      for (const key of Object.keys(this.faces)) {
        if (key !== "front") this._drawFaceStatic(key, emotion);
      }
      this._faceDirty = false;
    }

    // Front face (dynamic).
    const f = this.faces.front;
    const size = f.canvas.width;
    const colors = this._colors();
    if (this.faceMode === "painted" && this.paintFaces) {
      const set = this.paintFaces.front || {};
      const grid = set[emotion] || set.neutral || null;
      if (grid) drawPaintedFace(f.ctx, size, grid, this.paintGridN, this.colors.face);
      else {
        f.ctx.fillStyle = this.colors.cube;
        f.ctx.fillRect(0, 0, size, size);
      }
      // Animated speaking mouth over custom art (only while mouth is open).
      if (this.paintOverlayMouth && (params.mouthOpen ?? 0) > 0.12) {
        drawMouthLayer(f.ctx, size, { colors, ...params });
      }
    } else {
      drawPixelFace(f.ctx, size, { colors, ...params });
    }
    f.texture.needsUpdate = true;
  }

  setFaceMode(mode) {
    if (mode !== this.faceMode) this._faceDirty = true;
    this.faceMode = mode;
  }

  setPaintData(paintFaces, gridN) {
    this.paintFaces = paintFaces;
    if (gridN) this.paintGridN = gridN;
    this._faceDirty = true;
  }

  setColors(c) {
    Object.assign(this.colors, c);
    this.refreshCubeColors();
  }

  // ---------- GLB loading ----------
  async loadGLB(urlOrBuffer) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      if (typeof urlOrBuffer === "string") {
        loader.load(urlOrBuffer, resolve, undefined, reject);
      } else {
        loader.parse(urlOrBuffer, "", resolve, reject);
      }
    });

    const model = gltf.scene;

    // Normalize to unit size, centered.
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    model.position.sub(center);
    const wrap = new THREE.Group();
    wrap.add(model);
    wrap.scale.setScalar(1 / maxDim);

    // Collect morph targets for expression control.
    this.morphTargets = [];
    model.traverse((o) => {
      if (o.isMesh && o.morphTargetDictionary) {
        for (const [name, index] of Object.entries(o.morphTargetDictionary)) {
          this.morphTargets.push({ mesh: o, index, name: name.toLowerCase() });
        }
      }
    });

    this.glb = wrap;
    return { morphCount: this.morphTargets.length };
  }

  setHeadType(type) {
    this.headType = type;
    this.root.clear();
    if (type === "cube") {
      this.root.add(this.cubeGroup);
    } else if (type === "glb" && this.glb) {
      this.root.add(this.glb);
    } else {
      this.root.add(this.cubeGroup);
      this.headType = "cube";
    }
  }

  hasGLB() {
    return !!this.glb;
  }

  // ---------- Drive GLB morph targets from blendshapes ----------
  applyMorphs(blendshapes, strength) {
    if (this.headType !== "glb" || this.morphTargets.length === 0) return;
    // reset
    for (const m of this.morphTargets) {
      m.mesh.morphTargetInfluences[m.index] = 0;
    }
    for (const [name, value] of blendshapes) {
      const lname = name.toLowerCase();
      for (const m of this.morphTargets) {
        if (m.name === lname || m.name.endsWith(lname) || lname.endsWith(m.name)) {
          m.mesh.morphTargetInfluences[m.index] = Math.min(1, value * strength);
        }
      }
    }
  }

  /**
   * Position/scale/rotate the head onto the face.
   * @param {Array} landmarks normalized 0..1 landmarks
   * @param {number[]|null} matrix 4x4 head-pose (column-major) from MediaPipe
   * @param {object} opts {mirror, scaleMul, offsetX, offsetY, rotX, rotY, rotZ}
   */
  align(landmarks, matrix, opts) {
    const W = this.width, H = this.height;
    const mir = opts.mirror;

    const toPx = (lm) => {
      let x = lm.x;
      if (mir) x = 1 - x;
      return { x: x * W, y: lm.y * H };
    };

    const le = toPx(landmarks[L.leftEye]);
    const re = toPx(landmarks[L.rightEye]);

    // Head center = center of the full landmark bounding box (true head center,
    // not the eye line), so the cube sits centered on the head.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const lm of landmarks) {
      const x = (mir ? 1 - lm.x : lm.x) * W;
      const y = lm.y * H;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // Head size from the bounding box.
    const faceW = maxX - minX;
    const faceH = maxY - minY;
    const dim = Math.max(faceW, faceH) * 1.35 * opts.scaleMul;

    // Convert pixel center -> ortho coords (origin center, y up).
    const ox = cx - W / 2 + opts.offsetX;
    const oy = -(cy - H / 2) + opts.offsetY;

    this.root.position.set(ox, oy, 0);
    this.root.scale.setScalar(dim);

    // Rotation: prefer head-pose matrix; fall back to eye-line roll only.
    const q = new THREE.Quaternion();
    if (matrix && matrix.length === 16) {
      const m = new THREE.Matrix4().fromArray(matrix);
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      m.decompose(pos, q, scl);
      if (mir) {
        // mirror rotation across the X axis
        q.y = -q.y;
        q.z = -q.z;
      }
    } else {
      const roll = Math.atan2(re.y - le.y, re.x - le.x);
      q.setFromEuler(new THREE.Euler(0, 0, -roll));
    }

    const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");
    euler.x += THREE.MathUtils.degToRad(opts.rotX);
    euler.y += THREE.MathUtils.degToRad(opts.rotY);
    euler.z += THREE.MathUtils.degToRad(opts.rotZ);
    this.root.quaternion.setFromEuler(euler);

    this.root.visible = true;
  }

  hide() {
    this.root.visible = false;
  }

  resize(w, h) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
