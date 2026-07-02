// HeadUnit: one head (pixel-face cube or loaded GLB) in a shared scene.
// Aligned onto one tracked face; carries its own avatar look (colors + layers).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { drawPixelFace } from "./pixelFace.js";
import { drawRiggedFace, drawLayeredStatic } from "./faceRig.js";

// Landmark indices (MediaPipe FaceMesh)
const L = { leftEye: 33, rightEye: 263, chin: 152, foreheadTop: 10, leftCheek: 234, rightCheek: 454 };

export class HeadUnit {
  constructor(scene) {
    this.scene = scene;
    this.width = 1;
    this.height = 1;

    this.headType = "cube";
    this.faceMode = "painted";
    this.paintFaces = null;
    this.paintGridN = 8;
    this.paintOverlayMouth = true;
    this.morphTargets = [];
    this.glb = null;
    this.matProps = { metalness: 0, roughness: 0.85 };

    this._faceDirty = true;
    this._frontDirty = true;
    this._lastEmotion = null;
    this._frontHash = "";

    this.colors = {
      face: "#b58868", cube: "#9b7253", eye: "#2b2b2b",
      brow: "#46352b", mouth: "#6c4f33", cheek: "#e88f8f",
    };

    this._buildCube();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.setHeadType("cube");
  }

  setSize(w, h) { this.width = w; this.height = h; }

  _buildCube() {
    // BoxGeometry material order: +x(right), -x(left), +y(top), -y(bottom), +z(front), -z(back)
    this.FACE_INDEX = { right: 0, left: 1, top: 2, bottom: 3, front: 4, back: 5 };
    this.faces = {};
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
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.cube = new THREE.Mesh(geo, mats);
    this.cubeGroup = new THREE.Group();
    this.cubeGroup.add(this.cube);
  }

  refreshCubeColors() { this._faceDirty = true; }

  _drawFaceStatic(key) {
    const f = this.faces[key];
    const size = f.canvas.width;
    if (this.faceMode === "painted" && this.paintFaces) {
      const layers = this.paintFaces[key];
      const has = layers && (layers.base || layers.brows || layers.eyes || layers.mouth);
      if (has) drawLayeredStatic(f.ctx, size, layers, this.paintGridN, this.colors.face);
      else { f.ctx.fillStyle = this.colors.cube; f.ctx.fillRect(0, 0, size, size); }
    } else {
      f.ctx.fillStyle = this.colors.cube;
      f.ctx.fillRect(0, 0, size, size);
    }
    f.texture.needsUpdate = true;
  }

  _colors() {
    return { face: this.colors.face, eye: this.colors.eye, brow: this.colors.brow, mouth: this.colors.mouth, cheek: this.colors.cheek };
  }

  updateFace(params) {
    const emotion = params.emotion || "neutral";
    if (emotion !== this._lastEmotion) { this._lastEmotion = emotion; this._faceDirty = true; }

    if (this._faceDirty) {
      for (const key of Object.keys(this.faces)) if (key !== "front") this._drawFaceStatic(key);
      this._faceDirty = false;
      this._frontDirty = true;
    }

    const f = this.faces.front;
    const size = f.canvas.width;
    const colors = this._colors();

    if (this.faceMode === "painted" && this.paintFaces) {
      const hash = emotion +
        "|" + Math.round((params.blinkL ?? 0) * 8) +
        "|" + Math.round((params.blinkR ?? 0) * 8) +
        "|" + Math.round((params.mouthOpen ?? 0) * 8) +
        "|" + Math.round((params.intensity ?? 0) * 8);
      if (this._frontDirty || hash !== this._frontHash) {
        const layers = this.paintFaces.front;
        const has = layers && (layers.base || layers.brows || layers.eyes || layers.mouth);
        if (has) drawRiggedFace(f.ctx, size, layers, this.paintGridN, params, this.colors.face);
        else { f.ctx.fillStyle = this.colors.cube; f.ctx.fillRect(0, 0, size, size); }
        f.texture.needsUpdate = true;
        this._frontDirty = false;
        this._frontHash = hash;
      }
    } else {
      drawPixelFace(f.ctx, size, { colors, ...params });
      f.texture.needsUpdate = true;
    }
  }

  setFaceMode(mode) { if (mode !== this.faceMode) this._faceDirty = true; this.faceMode = mode; }
  setPaintData(paintFaces, gridN) { this.paintFaces = paintFaces; if (gridN) this.paintGridN = gridN; this._faceDirty = true; }
  setColors(c) { Object.assign(this.colors, c); this.refreshCubeColors(); }

  // Rounded-corner (bevel) cube. Keeps the 6 per-face material groups; falls
  // back to a plain box if the rounded geometry loses them.
  setBevel(r) {
    this.bevel = r;
    const old = this.cube.geometry;
    let geo;
    if (r > 0.005) {
      geo = new RoundedBoxGeometry(1, 1, 1, 4, Math.min(0.49, r));
      if (!geo.groups || geo.groups.length < 6) { geo.dispose(); geo = new THREE.BoxGeometry(1, 1, 1); }
    } else {
      geo = new THREE.BoxGeometry(1, 1, 1);
    }
    this.cube.geometry = geo;
    if (old) old.dispose();
  }

  applyMaterialProps(props) {
    if (props) Object.assign(this.matProps, props);
    const { metalness, roughness } = this.matProps;
    for (const mat of this.cubeMaterials) { mat.metalness = metalness; mat.roughness = roughness; mat.needsUpdate = true; }
    if (this.glb) {
      this.glb.traverse((o) => {
        if (o.isMesh && o.material) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const mat of ms) {
            if ("metalness" in mat) mat.metalness = metalness;
            if ("roughness" in mat) mat.roughness = roughness;
            mat.needsUpdate = true;
          }
        }
      });
    }
  }

  async loadGLB(urlOrBuffer) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      if (typeof urlOrBuffer === "string") loader.load(urlOrBuffer, resolve, undefined, reject);
      else loader.parse(urlOrBuffer, "", resolve, reject);
    });
    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(), center = new THREE.Vector3();
    box.getSize(size); box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    model.position.sub(center);
    const wrap = new THREE.Group();
    wrap.add(model);
    wrap.scale.setScalar(1 / maxDim);
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
    if (type === "glb" && this.glb) this.root.add(this.glb);
    else { this.root.add(this.cubeGroup); this.headType = "cube"; }
  }

  hasGLB() { return !!this.glb; }

  applyMorphs(blendshapes, strength) {
    if (this.headType !== "glb" || this.morphTargets.length === 0) return;
    for (const m of this.morphTargets) m.mesh.morphTargetInfluences[m.index] = 0;
    for (const [name, value] of blendshapes) {
      const lname = name.toLowerCase();
      for (const m of this.morphTargets) {
        if (m.name === lname || m.name.endsWith(lname) || lname.endsWith(m.name)) {
          m.mesh.morphTargetInfluences[m.index] = Math.min(1, value * strength);
        }
      }
    }
  }

  align(landmarks, matrix, opts) {
    const W = this.width, H = this.height;
    const mir = opts.mirror;
    const toPx = (lm) => ({ x: (mir ? 1 - lm.x : lm.x) * W, y: lm.y * H });
    const le = toPx(landmarks[L.leftEye]);
    const re = toPx(landmarks[L.rightEye]);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const lm of landmarks) {
      const x = (mir ? 1 - lm.x : lm.x) * W, y = lm.y * H;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const dim = Math.max(maxX - minX, maxY - minY) * 1.35 * opts.scaleMul;

    // Target transform
    const tPos = new THREE.Vector3(cx - W / 2 + opts.offsetX, -(cy - H / 2) + opts.offsetY, opts.offsetZ || 0);
    const tScl = dim;
    const q = new THREE.Quaternion();
    if (matrix && matrix.length === 16) {
      const m = new THREE.Matrix4().fromArray(matrix);
      const pos = new THREE.Vector3(), scl = new THREE.Vector3();
      m.decompose(pos, q, scl);
      if (mir) { q.y = -q.y; q.z = -q.z; }
    } else {
      const roll = Math.atan2(re.y - le.y, re.x - le.x);
      q.setFromEuler(new THREE.Euler(0, 0, -roll));
    }
    const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");
    euler.x += THREE.MathUtils.degToRad(opts.rotX);
    euler.y += THREE.MathUtils.degToRad(opts.rotY);
    euler.z += THREE.MathUtils.degToRad(opts.rotZ);
    const tQuat = new THREE.Quaternion().setFromEuler(euler);

    // Temporal smoothing (EMA / slerp) to reduce jitter. alpha small = smoother.
    const a = Math.max(0.05, Math.min(1, opts.poseAlpha ?? 1));
    if (!this._sm || this._wasHidden) {
      this._sm = { pos: tPos.clone(), scl: tScl, quat: tQuat.clone() };
      this._wasHidden = false;
    } else {
      this._sm.pos.lerp(tPos, a);
      this._sm.scl += (tScl - this._sm.scl) * a;
      this._sm.quat.slerp(tQuat, a);
    }
    this.root.position.copy(this._sm.pos);
    this.root.scale.setScalar(this._sm.scl);
    this.root.quaternion.copy(this._sm.quat);
    this.root.visible = true;
  }

  hide() { this.root.visible = false; this._wasHidden = true; }
}
