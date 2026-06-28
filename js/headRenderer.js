// HeadRenderer: shared Three.js scene/camera/lights hosting up to 2 HeadUnits
// (one per tracked face), so two people can have independent cube avatars.
import * as THREE from "three";
import { HeadUnit } from "./headUnit.js";
import { LIGHT_PRESETS } from "./settings.js";

export const MAX_HEADS = 3;

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

    // Perspective camera; distance from FOV so z=0 maps 1:1 to pixels.
    this.fov = 30;
    this.camera = new THREE.PerspectiveCamera(this.fov, width / height, 1, 6000);
    this._updateCamera();

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
    this._presetKey = "studio";
    this.matProps = { metalness: 0, roughness: 0.85 };

    // One head unit per supported face.
    this.units = [];
    for (let i = 0; i < MAX_HEADS; i++) {
      const u = new HeadUnit(this.scene);
      u.setSize(width, height);
      u.hide();
      this.units.push(u);
    }
  }

  unit(i) { return this.units[i]; }

  // ---------- Camera ----------
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

  // ---------- Material (applies to all units) ----------
  setMaterialProps(props) {
    Object.assign(this.matProps, props);
    for (const u of this.units) u.applyMaterialProps(this.matProps);
  }

  resize(w, h) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    for (const u of this.units) u.setSize(w, h);
    this._updateCamera();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
