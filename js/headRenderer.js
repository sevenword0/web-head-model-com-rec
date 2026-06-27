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
    this.paintGrid = null; // Array<string|null>
    this.paintGridN = 16;
    this.paintOverlayMouth = true;

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

  // ---------- Cube head with pixel-face canvas texture ----------
  _buildCube() {
    const tex = document.createElement("canvas");
    tex.width = 256;
    tex.height = 256;
    this.faceCanvas = tex;
    this.faceCtx = tex.getContext("2d");
    this.faceTexture = new THREE.CanvasTexture(tex);
    this.faceTexture.colorSpace = THREE.SRGBColorSpace;
    this.faceTexture.magFilter = THREE.NearestFilter;
    this.faceTexture.minFilter = THREE.LinearFilter;

    const side = new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.9 });
    this.sideMat = side;
    const faceMat = new THREE.MeshStandardMaterial({ map: this.faceTexture, roughness: 0.85 });

    // BoxGeometry material order: +x, -x, +y, -y, +z(front), -z
    const mats = [side, side, side, side, faceMat, side];
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.cube = new THREE.Mesh(geo, mats);
    this.cubeGroup = new THREE.Group();
    this.cubeGroup.add(this.cube);
  }

  refreshCubeColors() {
    if (this.sideMat) this.sideMat.color.set(this.colors.cube);
  }

  /** Redraw the pixel face texture (procedural emotion face or painted grid). */
  updateFace(params) {
    const size = this.faceCanvas.width;
    const colors = {
      face: this.colors.face,
      eye: this.colors.eye,
      brow: this.colors.brow,
      mouth: this.colors.mouth,
      cheek: this.colors.cheek,
    };
    if (this.faceMode === "painted" && this.paintGrid) {
      drawPaintedFace(this.faceCtx, size, this.paintGrid, this.paintGridN, this.colors.face);
      // Keep the static painted mouth at rest; only overlay an animated mouth
      // when actually speaking (mouth open), so custom art stays clean.
      if (this.paintOverlayMouth && (params.mouthOpen ?? 0) > 0.12) {
        drawMouthLayer(this.faceCtx, size, { colors, ...params });
      }
    } else {
      drawPixelFace(this.faceCtx, size, { colors, ...params });
    }
    this.faceTexture.needsUpdate = true;
  }

  setFaceMode(mode) {
    this.faceMode = mode;
  }

  setPaintGrid(grid, gridN) {
    this.paintGrid = grid;
    if (gridN) this.paintGridN = gridN;
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
