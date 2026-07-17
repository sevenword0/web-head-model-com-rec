// HeadUnit: one head (pixel-face cube or loaded GLB) in a shared scene.
// Aligned onto one tracked face; carries its own avatar look (colors + layers).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { drawPixelFace } from "./pixelFace.js";
import { drawRiggedFace, drawLayeredStatic, computeBlocks } from "./faceRig.js";

const MAX_BLOCKS = 800;

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

    // 3D extruded blocks for eyes/brows/mouth (optional stereoscopic mode)
    this.blockMode = false;
    this.blockThickness = 0.12;
    this.blockOffset = 0.02;

    this._buildCube();
    this._buildBlocks();
    // reusable scratch objects for align() (avoid per-frame allocations)
    this._tPos = new THREE.Vector3();
    this._tQuat = new THREE.Quaternion();
    this._aMat = new THREE.Matrix4();
    this._aPos = new THREE.Vector3();
    this._aScl = new THREE.Vector3();
    this._aEuler = new THREE.Euler();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.setHeadType("cube");
  }

  _buildBlocks() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    this.blockMat = mat;
    this.blockMesh = new THREE.InstancedMesh(geo, mat, MAX_BLOCKS);
    this.blockMesh.count = 0;
    this.blockMesh.frustumCulled = false;
    this.blockMesh.visible = false;
    this.cubeGroup.add(this.blockMesh);
    this._m4 = new THREE.Matrix4();
    this._col = new THREE.Color();
    this._q = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._zAxis = new THREE.Vector3(0, 0, 1);
  }

  _updateBlocks(params) {
    const N = this.paintGridN;
    const layers = this.paintFaces && this.paintFaces.front;
    if (!layers) { this.blockMesh.visible = false; return; }
    const cell = 1 / N;
    const t = this.blockThickness;
    const z = 0.5 + this.blockOffset + t / 2;
    const blocks = computeBlocks(layers, N, params);
    let i = 0;
    for (const b of blocks) {
      if (i >= MAX_BLOCKS) break;
      const lx = b.cx / N - 0.5;
      const ly = 0.5 - b.cy / N;
      // Match each block's size + orientation to the shape transform so blocks
      // exactly one cell (no overlap) so blocks don't extend the feature area;
      // the flat rig drawn underneath fills any hairline gaps.
      this._pos.set(lx, ly, z);
      this._q.setFromAxisAngle(this._zAxis, -(b.rot || 0)); // grid y-down → local y-up
      this._scl.set(cell * b.sx, cell * b.sy, t);
      this._m4.compose(this._pos, this._q, this._scl);
      this.blockMesh.setMatrixAt(i, this._m4);
      this.blockMesh.setColorAt(i, this._col.set(b.color));
      i++;
    }
    this.blockMesh.count = i;
    this.blockMesh.instanceMatrix.needsUpdate = true;
    if (this.blockMesh.instanceColor) this.blockMesh.instanceColor.needsUpdate = true;
    this.blockMesh.visible = true;
  }

  setBlockOptions(o) {
    if (o.blockMode !== undefined) this.blockMode = o.blockMode;
    if (o.blockThickness !== undefined) this.blockThickness = o.blockThickness;
    if (o.blockOffset !== undefined) this.blockOffset = o.blockOffset;
    this._frontDirty = true;
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
        if (this.blockMode && has) {
          // Draw the full flat rig underneath so any inter-block gaps show the
          // matching feature colour (blocks read as connected relief, not
          // separated cubes), then raise eyes/brows/mouth as 3D blocks on top.
          drawRiggedFace(f.ctx, size, layers, this.paintGridN, params, this.colors.face);
          this._updateBlocks(params);
        } else if (has) {
          drawRiggedFace(f.ctx, size, layers, this.paintGridN, params, this.colors.face);
          this.blockMesh.visible = false;
        } else {
          f.ctx.fillStyle = this.colors.cube; f.ctx.fillRect(0, 0, size, size);
          this.blockMesh.visible = false;
        }
        f.texture.needsUpdate = true;
        this._frontDirty = false;
        this._frontHash = hash;
      }
    } else {
      drawPixelFace(f.ctx, size, { colors, ...params });
      f.texture.needsUpdate = true;
      this.blockMesh.visible = false;
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
    if (this.blockMat) { this.blockMat.metalness = metalness; this.blockMat.roughness = roughness; this.blockMat.needsUpdate = true; }
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

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const lm of landmarks) {
      const x = (mir ? 1 - lm.x : lm.x) * W, y = lm.y * H;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const tScl = Math.max(maxX - minX, maxY - minY) * 1.35 * opts.scaleMul;
    const tPos = this._tPos.set(cx - W / 2 + opts.offsetX, -(cy - H / 2) + opts.offsetY, opts.offsetZ || 0);

    const q = this._tQuat;
    if (matrix && matrix.length === 16) {
      this._aMat.fromArray(matrix).decompose(this._aPos, q, this._aScl);
      if (mir) { q.y = -q.y; q.z = -q.z; }
    } else {
      const le = landmarks[L.leftEye], re = landmarks[L.rightEye];
      const lex = (mir ? 1 - le.x : le.x) * W, ley = le.y * H;
      const rex = (mir ? 1 - re.x : re.x) * W, rey = re.y * H;
      q.setFromEuler(this._aEuler.set(0, 0, -Math.atan2(rey - ley, rex - lex)));
    }
    if (opts.rotX || opts.rotY || opts.rotZ) {
      this._aEuler.setFromQuaternion(q, "XYZ");
      this._aEuler.x += THREE.MathUtils.degToRad(opts.rotX);
      this._aEuler.y += THREE.MathUtils.degToRad(opts.rotY);
      this._aEuler.z += THREE.MathUtils.degToRad(opts.rotZ);
      q.setFromEuler(this._aEuler);
    }

    // Temporal smoothing (EMA / slerp) to reduce jitter. alpha small = smoother.
    const a = Math.max(0.05, Math.min(1, opts.poseAlpha ?? 1));
    if (!this._sm || this._wasHidden) {
      this._sm = { pos: tPos.clone(), scl: tScl, quat: q.clone() };
      this._wasHidden = false;
    } else {
      this._sm.pos.lerp(tPos, a);
      this._sm.scl += (tScl - this._sm.scl) * a;
      this._sm.quat.slerp(q, a);
    }
    this.root.position.copy(this._sm.pos);
    this.root.scale.setScalar(this._sm.scl);
    this.root.quaternion.copy(this._sm.quat);
    this.root.visible = true;
  }

  hide() { this.root.visible = false; this._wasHidden = true; }
}
