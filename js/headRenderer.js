// HeadRenderer: Three.js scene that draws either a pixel-face cube or a loaded
// GLB model, aligned onto the tracked face using landmarks + head-pose matrix.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { drawPixelFace } from "./pixelFace.js";
import { drawRiggedFace, drawLayeredStatic } from "./faceRig.js";
import { LIGHT_PRESETS } from "./settings.js";

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

    // Perspective camera. Distance is derived from FOV so that the z=0 plane
    // maps 1:1 to pixels (like ortho), while the cube depth gets perspective.
    this.fov = 30;
    this.camera = new THREE.PerspectiveCamera(this.fov, width / height, 1, 6000);
    this._updateCamera();

    // Configurable light rig (driven by presets).
    this.lights = {
      ambient: new THREE.AmbientLight(0xffffff, 0.85),
      hemi: new THREE.HemisphereLight(0xffffff, 0x444444, 0.3),
      key: new THREE.DirectionalLight(0xffffff, 1.0),
      fill: new THREE.DirectionalLight(0xffffff, 0.4),
      rim: new THREE.DirectionalLight(0xffffff, 0.25),
    };
    this.lights.key.position.set(0.3, 0.6, 1);
    this.lights.fill.position.set(-0.6, 0.2, 0.7);
    this.lights.rim.position.set(0, 0.4, -1);
    for (const l of Object.values(this.lights)) this.scene.add(l);
    this.lightIntensity = 1;
    this.matProps = { metalness: 0, roughness: 0.85 };

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
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0 });
      this.faces[key] = { canvas, ctx, texture, material };
      mats[idx] = material;
    }
    this.cubeMaterials = mats.slice();
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

  // Draw a single cube face's static (non-animated) content.
  _drawFaceStatic(key) {
    const f = this.faces[key];
    const size = f.canvas.width;
    if (this.faceMode === "painted" && this.paintFaces) {
      const layers = this.paintFaces[key];
      const has = layers && (layers.base || layers.brows || layers.eyes || layers.mouth);
      if (has) {
        drawLayeredStatic(f.ctx, size, layers, this.paintGridN, this.colors.face);
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

  /** Redraw the cube face textures. To save GPU texture uploads (and frame
   *  rate), sides redraw only when dirty, and in painted mode the front redraws
   *  only on change or while speaking; procedural mode animates every frame. */
  updateFace(params) {
    const emotion = params.emotion || "neutral";
    if (emotion !== this._lastEmotion) {
      this._lastEmotion = emotion;
      this._faceDirty = true;
    }

    if (this._faceDirty) {
      for (const key of Object.keys(this.faces)) {
        if (key !== "front") this._drawFaceStatic(key);
      }
      this._faceDirty = false;
      this._frontDirty = true;
    }

    const f = this.faces.front;
    const size = f.canvas.width;
    const colors = this._colors();

    if (this.faceMode === "painted" && this.paintFaces) {
      // Redraw the rigged front face only when the animation state changes
      // (emotion, blink, mouth open) — keeps idle frame rate high.
      const hash =
        emotion +
        "|" + Math.round((params.blinkL ?? 0) * 8) +
        "|" + Math.round((params.blinkR ?? 0) * 8) +
        "|" + Math.round((params.mouthOpen ?? 0) * 8) +
        "|" + Math.round((params.intensity ?? 0) * 8);
      if (this._frontDirty || hash !== this._frontHash) {
        const layers = this.paintFaces.front;
        const has = layers && (layers.base || layers.brows || layers.eyes || layers.mouth);
        if (has) {
          drawRiggedFace(f.ctx, size, layers, this.paintGridN, params, this.colors.face);
        } else {
          f.ctx.fillStyle = this.colors.cube;
          f.ctx.fillRect(0, 0, size, size);
        }
        f.texture.needsUpdate = true;
        this._frontDirty = false;
        this._frontHash = hash;
      }
    } else {
      // procedural face animates continuously
      drawPixelFace(f.ctx, size, { colors, ...params });
      f.texture.needsUpdate = true;
    }
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

  // ---------- Camera (field of view) ----------
  _updateCamera() {
    const f = THREE.MathUtils.degToRad(this.fov);
    const dist = (this.height / 2) / Math.tan(f / 2);
    this.camera.fov = this.fov;
    this.camera.aspect = this.width / this.height;
    this.camera.position.set(0, 0, dist);
    this.camera.near = Math.max(1, dist - this.height);
    this.camera.far = dist + this.height * 2 + 2000;
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  setFOV(deg) {
    this.fov = Math.max(5, Math.min(120, deg));
    this._updateCamera();
  }

  // ---------- Lighting ----------
  setLightIntensity(mult) {
    this.lightIntensity = mult;
    this.setLightPreset(this._presetKey || "studio");
  }

  setLightPreset(key) {
    const p = LIGHT_PRESETS[key] || LIGHT_PRESETS.studio;
    this._presetKey = key;
    const m = this.lightIntensity;
    const L = this.lights;
    L.ambient.color.set(p.ambient[0]); L.ambient.intensity = p.ambient[1] * m;
    L.key.color.set(p.key[0]); L.key.intensity = p.key[1] * m; L.key.position.set(...p.key[2]);
    L.fill.color.set(p.fill[0]); L.fill.intensity = p.fill[1] * m; L.fill.position.set(...p.fill[2]);
    L.rim.color.set(p.rim[0]); L.rim.intensity = p.rim[1] * m; L.rim.position.set(...p.rim[2]);
    L.hemi.color.set(p.hemi[0]); L.hemi.groundColor.set(p.hemi[1]); L.hemi.intensity = p.hemi[2] * m;
  }

  // ---------- Material (reflectivity / roughness) ----------
  setMaterialProps(props) {
    Object.assign(this.matProps, props);
    this.applyMaterialProps();
  }

  applyMaterialProps() {
    const { metalness, roughness } = this.matProps;
    for (const mat of this.cubeMaterials) {
      mat.metalness = metalness; mat.roughness = roughness; mat.needsUpdate = true;
    }
    if (this.glb) {
      this.glb.traverse((o) => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const mat of mats) {
            if ("metalness" in mat) mat.metalness = metalness;
            if ("roughness" in mat) mat.roughness = roughness;
            mat.needsUpdate = true;
          }
        }
      });
    }
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
    this.applyMaterialProps();
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

    // Convert pixel center -> camera coords (origin center, y up). z = depth.
    const ox = cx - W / 2 + opts.offsetX;
    const oy = -(cy - H / 2) + opts.offsetY;
    const oz = opts.offsetZ || 0;

    this.root.position.set(ox, oy, oz);
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
    this._updateCamera();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
