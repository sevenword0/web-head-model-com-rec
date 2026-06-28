// Main orchestrator: camera, tracking, rendering, recording, UI & settings.
// FaceTracker (MediaPipe) and HeadRenderer (Three.js) pull large CDN modules,
// so they are imported dynamically on camera start — the UI, settings and
// pixel-face preview work immediately without waiting on (or being broken by)
// the network.
import { Recorder } from "./recorder.js";
import { analyzeEmotion, synthesizeBlendshapes, EMOTIONS } from "./emotion.js";
import { drawPixelFace } from "./pixelFace.js";
import { drawLayeredStatic, REGIONS } from "./faceRig.js";
import * as Settings from "./settings.js";
import { buildSteveLayers, LAYER_KEYS } from "./settings.js";

const PALETTE = [
  "#f1c27d", "#d9a066", "#8d5524", "#ffffff", "#000000",
  "#2b2b2b", "#b5403a", "#ff5b5b", "#ff9f43", "#feca57",
  "#1dd1a1", "#10ac84", "#54a0ff", "#2e86de", "#5f27cd",
  "#e88f8f", "#ff9ff3", "#c8d6e5", "#576574", "#222f3e",
];

const EMO_LABEL = {
  neutral: "😐 중립",
  happy: "😄 기쁨",
  sad: "😢 슬픔",
  angry: "😠 분노",
  surprised: "😲 놀람",
};

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.video = $("inputVideo");
    this.outCanvas = $("outputCanvas");
    this.outCtx = this.outCanvas.getContext("2d");
    this.statusEl = $("status");

    this.tracker = null; // FaceTracker (lazy on start)
    this.head = null; // HeadRenderer (lazy on start)
    this.recorder = null;

    this.state = Settings.loadSettings() || Settings.freshDefaults();
    this.lastVideoTime = -1;
    this.lastFaces = [null, null]; // per-slot last good detection
    this.lastSeen = [0, 0];        // per-slot timestamp
    this.running = false;

    this._paintColor = this.state.faceColor || PALETTE[0];
    this._erasing = false;
    this._picking = false; // eyedropper mode
    this._selFace = "front"; // which cube face is being painted
    this._selLayer = "base"; // which layer is being painted
    // normalize any stored grids to the current grid size
    this.resampleAllGrids(this.state.gridN);

    this.buildPalette();
    this.bindUI();
    this.bindPaintEditor();
    this.bindRenderControls();
    this.bindSlotsAndHeadPresets();
    this.applyStateToUI();
    this.renderHeadPresetList();
    this.repaintEditor();
    this.renderPreview();
    this.renderPresetList();
  }

  setStatus(msg, hide = false) {
    if (hide) {
      this.statusEl.classList.add("hidden");
    } else {
      this.statusEl.classList.remove("hidden");
      this.statusEl.textContent = msg;
    }
  }

  // ============ Camera + model init ============
  async start() {
    $("startBtn").disabled = true;
    this.setStatus("카메라 권한 요청 중…");
    let stream;
    try {
      const vid = { width: { ideal: 1280 }, height: { ideal: 720 } };
      if (this.state.cameraId) vid.deviceId = { exact: this.state.cameraId };
      else vid.facingMode = "user";
      stream = await navigator.mediaDevices.getUserMedia({ video: vid, audio: false });
    } catch (e) {
      this.setStatus("카메라를 사용할 수 없습니다: " + e.message);
      $("startBtn").disabled = false;
      return;
    }
    this.video.srcObject = stream;
    await this.video.play();
    this.applyVideoSize();
    this.populateCameras();

    // Dynamically load the heavy CDN-backed modules now.
    this.setStatus("3D 엔진 로딩 중…");
    let HeadRenderer, FaceTracker;
    try {
      ({ HeadRenderer } = await import("./headRenderer.js"));
      ({ FaceTracker } = await import("./faceTracker.js"));
    } catch (e) {
      this.setStatus("라이브러리 로딩 실패 (네트워크 확인): " + e.message);
      $("startBtn").disabled = false;
      return;
    }
    this.tracker = new FaceTracker();

    this.head = new HeadRenderer(this.outCanvas.width, this.outCanvas.height);
    this.syncRenderToHead();
    this.syncUnits();
    if (this.state.lightAuto) this.startLightAuto();

    this.recorder = new Recorder(this.outCanvas);

    this.setStatus("AI 모델 로딩 중… (최초 1회, 수십 초 걸릴 수 있어요)");
    try {
      await this.tracker.init();
    } catch (e) {
      this.setStatus("모델 로딩 실패: " + e.message);
      return;
    }

    this.setStatus("", true);
    $("recordBtn").disabled = false;
    this.running = true;
    requestAnimationFrame(() => this.loop());
  }

  // ============ Camera selection ============
  applyVideoSize() {
    const w = this.video.videoWidth || 1280;
    const h = this.video.videoHeight || 720;
    if (this.outCanvas.width !== w || this.outCanvas.height !== h) {
      this.outCanvas.width = w;
      this.outCanvas.height = h;
      if (this.head) this.head.resize(w, h);
    }
    $("stageInner").style.aspectRatio = `${w} / ${h}`;
  }

  async populateCameras() {
    const sel = $("cameraSelect");
    if (!sel) return;
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    const cams = devs.filter((d) => d.kind === "videoinput");
    if (!cams.length) return;
    const track = this.video.srcObject && this.video.srcObject.getVideoTracks()[0];
    const cur = (track && track.getSettings().deviceId) || this.state.cameraId || cams[0].deviceId;
    sel.innerHTML = cams
      .map((c, i) => `<option value="${c.deviceId}"${c.deviceId === cur ? " selected" : ""}>${c.label || "카메라 " + (i + 1)}</option>`)
      .join("");
  }

  async switchCamera(deviceId) {
    this.state.cameraId = deviceId;
    this.autosave();
    this.setStatus("카메라 전환 중…");
    try {
      if (this.video.srcObject) this.video.srcObject.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      this.video.srcObject = stream;
      await this.video.play();
      this.applyVideoSize();
      this.lastVideoTime = -1;
      this.setStatus("", true);
      this.populateCameras();
    } catch (e) {
      this.setStatus("카메라 전환 실패: " + e.message);
    }
  }

  // ============ Render loop ============
  loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      try {
        const faces = this.tracker.detect(v, performance.now()); // array, left→right
        const now = performance.now();
        // Map each detected face to a slot; keep last good per slot (grace).
        for (let i = 0; i < this.lastFaces.length; i++) {
          if (faces[i]) { this.lastFaces[i] = faces[i]; this.lastSeen[i] = now; }
        }
      } catch (e) {
        // detection can throw transiently; ignore one frame
      }
    }

    this.drawFrame();
    requestAnimationFrame(() => this.loop());
  }

  drawFrame() {
    const ctx = this.outCtx;
    const W = this.outCanvas.width;
    const H = this.outCanvas.height;

    // 1) background video (optionally mirrored)
    ctx.save();
    if (this.state.showVideo) {
      if (this.state.mirror) {
        ctx.translate(W, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(this.video, 0, 0, W, H);
    } else {
      ctx.fillStyle = "#101317";
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();

    if (!this.head) return;

    // Drive each head unit from its tracked face (grace period to avoid flicker).
    const GRACE_MS = 600;
    const now = performance.now();
    let anyFresh = false;
    let primary = null;
    for (let i = 0; i < this.head.units.length; i++) {
      const fresh = this.lastSeen[i] && now - this.lastSeen[i] < GRACE_MS;
      const face = fresh ? this.lastFaces[i] : null;
      if (face) {
        this.driveUnit(i, face);
        anyFresh = true;
        if (!primary) primary = face;
      } else {
        this.head.units[i].hide();
      }
    }

    this.head.render();
    ctx.drawImage(this.head.canvas, 0, 0, W, H);

    if (anyFresh && primary) this.updateReadoutFor(primary);
    else this.setStatus("얼굴을 찾는 중…");
  }

  // Compute expression/mouth for one face and apply to the matching head unit.
  driveUnit(i, face) {
    const unit = this.head.units[i];
    const live = face.blendshapes;
    let driving, emotion, intensity;
    if (this.state.emotionMode === "manual") {
      emotion = this.state.manualEmotion;
      intensity = this.state.intensity;
      driving = synthesizeBlendshapes(emotion, intensity);
    } else {
      const a = analyzeEmotion(live);
      emotion = a.top; intensity = a.intensity; driving = live;
      if (i === 0) this.lastAuto = a;
    }
    const liveJaw = live.get("jawOpen") || 0;
    const synthJaw = driving.get("jawOpen") || 0;
    const mouthOpen = this.state.speaking ? Math.max(liveJaw, synthJaw) : synthJaw;
    const mouthWide = 1 - (live.get("mouthPucker") || 0) * 0.7;

    unit.updateFace({
      emotion, intensity, mouthOpen, mouthWide,
      blinkL: live.get("eyeBlinkLeft") || 0,
      blinkR: live.get("eyeBlinkRight") || 0,
    });
    const morphMap = new Map(driving);
    if (this.state.speaking) morphMap.set("jawOpen", mouthOpen);
    unit.applyMorphs(morphMap, this.state.exprStrength);

    unit.align(face.landmarks, face.matrix, {
      mirror: this.state.mirror,
      scaleMul: this.state.scale,
      offsetX: this.state.offsetX,
      offsetY: this.state.offsetY,
      offsetZ: this.state.offsetZ,
      rotX: this.state.rotX,
      rotY: this.state.rotY,
      rotZ: this.state.rotZ,
    });
  }

  updateReadoutFor(face) {
    const live = face.blendshapes;
    let emotion, intensity;
    if (this.state.emotionMode === "manual") {
      emotion = this.state.manualEmotion; intensity = this.state.intensity;
    } else {
      const a = this.lastAuto || analyzeEmotion(live);
      emotion = a.top; intensity = a.intensity;
    }
    this.updateReadout(emotion, intensity, live);
  }

  updateReadout(emotion, intensity, live) {
    if (this.statusEl && !this.statusEl.classList.contains("hidden")) {
      this.setStatus("", true);
    }
    const el = $("emotionReadout");
    if (this.state.emotionMode === "manual") {
      el.innerHTML = `<span class="emo-chip top">${EMO_LABEL[emotion]} (수동 · ${Math.round(
        intensity * 100
      )}%)</span>`;
    } else {
      const a = this.lastAuto;
      if (!a) return;
      el.innerHTML = EMOTIONS.map((e) => {
        const sc = Math.round((a.scores[e] || 0) * 100);
        const cls = e === a.top ? "emo-chip top" : "emo-chip";
        return `<span class="${cls}">${EMO_LABEL[e]} ${sc}%</span>`;
      }).join("");
    }
    // blendshape meters
    this.updateMeters(live);
  }

  updateMeters(live) {
    const wrap = $("bsMeters");
    if (!wrap) return;
    const keys = [
      ["jawOpen", "입 벌림"],
      ["mouthSmileLeft", "미소"],
      ["browInnerUp", "눈썹 올림"],
      ["eyeBlinkLeft", "왼눈 깜빡"],
      ["eyeBlinkRight", "오른눈 깜빡"],
    ];
    if (!wrap._built) {
      wrap.innerHTML = keys
        .map(
          ([k, label]) =>
            `<div class="bs-meter" data-k="${k}">${label}<div class="bar"><i></i></div></div>`
        )
        .join("");
      wrap._built = true;
    }
    for (const [k] of keys) {
      const bar = wrap.querySelector(`[data-k="${k}"] i`);
      if (bar) bar.style.width = Math.round((live.get(k) || 0) * 100) + "%";
    }
  }

  // ============ Recording ============
  async toggleRecord() {
    if (!this.recorder) return;
    if (this.recorder.recording) {
      this.recorder.stop();
      $("recordBtn").classList.remove("recording");
      $("recordBtn").textContent = "● 녹화";
      $("recTimer").classList.add("hidden");
      clearInterval(this._timer);
    } else {
      this.recorder.onStop = (blob) => this.addDownload(blob);
      try {
        await this.recorder.start({ withAudio: this.state.audio, fps: 30 });
      } catch (e) {
        alert("녹화를 시작할 수 없습니다: " + e.message);
        return;
      }
      $("recordBtn").classList.add("recording");
      $("recordBtn").textContent = "■ 정지";
      const timer = $("recTimer");
      timer.classList.remove("hidden");
      this._timer = setInterval(() => {
        const ms = this.recorder.elapsedMs;
        const s = Math.floor(ms / 1000);
        timer.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(
          s % 60
        ).padStart(2, "0")}`;
      }, 250);
    }
  }

  addDownload(blob) {
    const url = URL.createObjectURL(blob);
    const ext = (blob.type.includes("mp4") ? "mp4" : "webm");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `head-studio-${stamp}.${ext}`;
    const item = document.createElement("div");
    item.className = "dl-item";
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    const info = document.createElement("div");
    info.innerHTML = `<a href="${url}" download="${name}">⬇ ${name}</a><div class="meta">${(
      blob.size /
      1024 /
      1024
    ).toFixed(1)} MB · ${blob.type || "video/webm"}</div>`;
    item.appendChild(v);
    item.appendChild(info);
    $("downloads").prepend(item);
  }

  // ============ Settings <-> head units ============
  applyBundleToUnit(u, b) {
    u.setColors({
      face: b.faceColor, cube: b.cubeColor, eye: b.eyeColor,
      brow: b.browColor, mouth: b.mouthColor, cheek: b.cheekColor,
    });
    u.setFaceMode(b.faceMode);
    u.paintOverlayMouth = this.state.paintOverlayMouth;
    u.setPaintData(b.paintFaces, b.gridN);
    u.setHeadType(b.headType === "glb" && u.hasGLB() ? "glb" : "cube");
  }

  // Resolve each person's avatar (editing / builtin / saved preset) onto its unit.
  syncUnits() {
    if (!this.head) return;
    for (let i = 0; i < this.head.units.length; i++) {
      const b = Settings.resolveSlotBundle(this.state.slotPresets[i] || "", this.state);
      this.applyBundleToUnit(this.head.units[i], b);
    }
  }

  // back-compat names used throughout the editor → resync units
  syncColorsToHead() { this.syncUnits(); }
  syncPaintToHead() { this.syncUnits(); }

  // ============ Render (FOV / lights / material) ============
  syncRenderToHead() {
    if (!this.head) return;
    this.head.setFOV(this.state.fov);
    this.head.lightIntensity = this.state.lightIntensity;
    this.head.setLightPreset(this.state.lightPreset);
    this.head.setMaterialProps({ metalness: this.state.metalness, roughness: this.state.roughness });
  }

  applyLightPreset(key, fromAuto) {
    this.state.lightPreset = key;
    if (this.head) this.head.setLightPreset(key);
    document.querySelectorAll("[data-light]").forEach((x) =>
      x.classList.toggle("active", x.dataset.light === key)
    );
    if (!fromAuto) this.autosave();
  }

  startLightAuto() {
    this.stopLightAuto();
    const tick = () => {
      const key = this.analyzeLighting();
      if (key && key !== this.state.lightPreset) this.applyLightPreset(key, true);
    };
    tick();
    this._lightTimer = setInterval(tick, 1500);
  }

  stopLightAuto() {
    if (this._lightTimer) { clearInterval(this._lightTimer); this._lightTimer = null; }
  }

  // Pick the best light preset from the input video's brightness & warmth.
  analyzeLighting() {
    const v = this.video;
    if (!v || v.readyState < 2) return null;
    const c = this._lumCanvas || (this._lumCanvas = document.createElement("canvas"));
    c.width = 32; c.height = 24;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    try { ctx.drawImage(v, 0, 0, 32, 24); } catch { return null; }
    const d = ctx.getImageData(0, 0, 32, 24).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    r /= n; g /= n; b /= n;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const warmth = (r - b) / 255;
    if (lum < 0.28) return "cool";       // dark scene → night
    if (warmth > 0.13) return "warm";    // warm tint → sunset
    if (lum > 0.62) return "studio";     // bright neutral
    return "soft";                        // mid
  }

  renderPreview() {
    const c = $("facePreview");
    const ctx = c.getContext("2d");
    const colors = {
      face: this.state.faceColor,
      eye: this.state.eyeColor,
      brow: this.state.browColor,
      mouth: this.state.mouthColor,
      cheek: this.state.cheekColor,
    };
    const mouthParams = {
      colors,
      emotion: this.state.emotionMode === "manual" ? this.state.manualEmotion : "happy",
      intensity: this.state.intensity,
      mouthOpen: 0.3,
      mouthWide: 1,
    };
    if (this.state.faceMode === "painted") {
      // Preview shows the assembled (static) layers of the current face.
      drawLayeredStatic(ctx, c.width, this.state.paintFaces[this._selFace], this.state.gridN, this.state.faceColor);
    } else {
      drawPixelFace(ctx, c.width, mouthParams);
    }
  }

  // ============ Paint editor (grid pixel painting) ============
  buildPalette() {
    const wrap = $("palette");
    wrap.innerHTML = "";
    for (const col of PALETTE) {
      const sw = document.createElement("div");
      sw.className = "sw";
      sw.style.background = col;
      sw.dataset.col = col;
      sw.addEventListener("click", () => {
        this._erasing = false;
        this._paintColor = col;
        $("paintColor").value = col;
        this.markActiveSwatch(col);
      });
      wrap.appendChild(sw);
    }
    this.markActiveSwatch(this._paintColor);
  }

  markActiveSwatch(col) {
    document.querySelectorAll("#palette .sw").forEach((s) =>
      s.classList.toggle("active", !this._erasing && s.dataset.col === col)
    );
  }

  // Return the grid for a face's layer. If `create`, allocate/store a blank one.
  getLayer(face, layer, create) {
    const N = this.state.gridN;
    const need = N * N;
    const set = (this.state.paintFaces[face] = this.state.paintFaces[face] || {});
    let grid = set[layer];
    if (Array.isArray(grid)) {
      if (grid.length !== need) {
        grid = resampleGrid(grid, Math.round(Math.sqrt(grid.length)), N);
        if (create) set[layer] = grid;
      }
      return grid;
    }
    if (create) {
      grid = new Array(need).fill(null);
      set[layer] = grid;
      return grid;
    }
    return null;
  }

  // Resample every stored layer grid to the current gridN.
  resampleAllGrids(newN) {
    for (const face of Object.keys(this.state.paintFaces)) {
      const set = this.state.paintFaces[face];
      for (const layer of Object.keys(set)) {
        const g = set[layer];
        if (Array.isArray(g) && g.length !== newN * newN) {
          set[layer] = resampleGrid(g, Math.round(Math.sqrt(g.length)), newN);
        }
      }
    }
  }

  repaintEditor() {
    const c = $("paintCanvas");
    if (!c) return;
    const ctx = c.getContext("2d");
    const N = this.state.gridN;
    const u = c.width / N;
    const W = c.width, H = c.height;
    ctx.fillStyle = this.state.faceColor;
    ctx.fillRect(0, 0, W, H);

    const set = this.state.paintFaces[this._selFace] || {};
    const drawGrid = (grid, alpha) => {
      if (!grid) return;
      ctx.globalAlpha = alpha;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const col = grid[y * N + x];
          if (!col) continue;
          ctx.fillStyle = col;
          ctx.fillRect(Math.round(x * u), Math.round(y * u), Math.ceil(u), Math.ceil(u));
        }
      }
      ctx.globalAlpha = 1;
    };
    // onion-skin: other layers faint, current layer full
    for (const layer of LAYER_KEYS) {
      if (layer === this._selLayer) continue;
      drawGrid(set[layer], 0.35);
    }
    drawGrid(set[this._selLayer], 1);

    // thin, faint grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= N; i++) {
      const p = Math.round(i * u) + 0.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
    }

    // region guides for brows / eyes / mouth
    const drawRegion = (r, color, active) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 2 : 1;
      ctx.setLineDash(active ? [] : [6, 5]);
      ctx.strokeRect(r.x0 * W, r.y0 * H, (r.x1 - r.x0) * W, (r.y1 - r.y0) * H);
    };
    drawRegion(REGIONS.brows, "rgba(120,180,255,0.7)", this._selLayer === "brows");
    drawRegion(REGIONS.eyes, "rgba(120,255,170,0.7)", this._selLayer === "eyes");
    drawRegion(REGIONS.mouth, "rgba(255,150,150,0.7)", this._selLayer === "mouth");
    ctx.setLineDash([]);
  }

  paintAt(clientX, clientY) {
    const c = $("paintCanvas");
    const rect = c.getBoundingClientRect();
    const N = this.state.gridN;
    const x = Math.floor(((clientX - rect.left) / rect.width) * N);
    const y = Math.floor(((clientY - rect.top) / rect.height) * N);
    if (x < 0 || y < 0 || x >= N || y >= N) return;

    // Eyedropper: pick the colour under the cursor instead of painting.
    if (this._picking) {
      const g = this.getLayer(this._selFace, this._selLayer, false);
      const col = (g && g[y * N + x]) || this.state.faceColor;
      this._paintColor = col;
      this._erasing = false;
      this._picking = false;
      $("paintColor").value = col;
      $("pickerBtn").classList.remove("primary");
      $("eraserBtn").classList.remove("primary");
      this.markActiveSwatch(col);
      return;
    }

    const grid = this.getLayer(this._selFace, this._selLayer, true);
    grid[y * N + x] = this._erasing ? null : this._paintColor;
    this.repaintEditor();
    this.syncPaintToHead();
    this.renderPreview();
    this.autosave();
  }

  bindPaintEditor() {
    const c = $("paintCanvas");
    let painting = false;
    const down = (e) => { painting = true; this.paintAt(e.clientX ?? e.touches[0].clientX, e.clientY ?? e.touches[0].clientY); e.preventDefault(); };
    const move = (e) => { if (!painting) return; const t = e.touches ? e.touches[0] : e; this.paintAt(t.clientX, t.clientY); e.preventDefault(); };
    const up = () => { painting = false; };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);

    document.querySelectorAll("[data-facemode]").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-facemode]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.state.faceMode = b.dataset.facemode;
        $("paintEditor").classList.toggle("disabled", this.state.faceMode !== "painted");
        this.syncPaintToHead();
        this.repaintEditor();
        this.renderPreview();
        this.autosave();
      })
    );

    // face (cube side) selector
    document.querySelectorAll("[data-face]").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-face]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this._selFace = b.dataset.face;
        this.repaintEditor();
        this.renderPreview();
      })
    );
    // layer selector
    document.querySelectorAll("[data-layer]").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-layer]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this._selLayer = b.dataset.layer;
        this.repaintEditor();
      })
    );

    $("gridN").addEventListener("input", (e) => {
      const N = parseInt(e.target.value, 10);
      this.state.gridN = N;
      $("gridNVal").textContent = N;
      this.resampleAllGrids(N);
      this.repaintEditor();
      this.syncPaintToHead();
      this.renderPreview();
      this.autosave();
    });

    $("paintColor").addEventListener("input", (e) => {
      this._erasing = false;
      this._paintColor = e.target.value;
      this.markActiveSwatch(this._paintColor);
    });
    $("eraserBtn").addEventListener("click", () => {
      this._erasing = !this._erasing;
      this._picking = false;
      $("pickerBtn").classList.remove("primary");
      $("eraserBtn").classList.toggle("primary", this._erasing);
      this.markActiveSwatch(this._paintColor);
    });
    $("pickerBtn").addEventListener("click", () => {
      this._picking = !this._picking;
      this._erasing = false;
      $("eraserBtn").classList.remove("primary");
      $("pickerBtn").classList.toggle("primary", this._picking);
    });
    $("fillBtn").addEventListener("click", () => {
      const N = this.state.gridN;
      this.state.paintFaces[this._selFace][this._selLayer] =
        new Array(N * N).fill(this._erasing ? null : this._paintColor);
      this.repaintEditor();
      this.syncPaintToHead();
      this.renderPreview();
      this.autosave();
    });
    $("clearPaintBtn").addEventListener("click", () => {
      // Clear only the currently selected layer.
      this.state.paintFaces[this._selFace][this._selLayer] = null;
      this.repaintEditor();
      this.syncPaintToHead();
      this.renderPreview();
      this.autosave();
    });
    $("steveBtn").addEventListener("click", () => {
      // Load the built-in Minecraft Steve layered face onto the current face.
      this.state.faceMode = "painted";
      this.state.gridN = 8;
      this.resampleAllGrids(8);
      this.state.paintFaces[this._selFace] = buildSteveLayers();
      this.state.faceColor = Settings.STEVE_SKIN;
      $("faceColor").value = Settings.STEVE_SKIN;
      $("gridN").value = 8;
      $("gridNVal").textContent = 8;
      document.querySelectorAll("[data-facemode]").forEach((x) =>
        x.classList.toggle("active", x.dataset.facemode === "painted")
      );
      $("paintEditor").classList.remove("disabled");
      this.syncColorsToHead();
      this.repaintEditor();
      this.renderPreview();
      this.autosave();
      this.flashSave("스티브 얼굴 적용 ✓");
    });
    $("overlayMouthToggle").addEventListener("change", (e) => {
      this.state.paintOverlayMouth = e.target.checked;
      this.syncPaintToHead();
      this.renderPreview();
      this.autosave();
    });
  }

  bindRenderControls() {
    $("fov").addEventListener("input", (e) => {
      this.state.fov = parseFloat(e.target.value);
      $("fovVal").textContent = Math.round(this.state.fov) + "°";
      if (this.head) this.head.setFOV(this.state.fov);
      this.autosave();
    });
    document.querySelectorAll("[data-light]").forEach((b) =>
      b.addEventListener("click", () => {
        if (this.state.lightAuto) return; // locked while auto
        this.applyLightPreset(b.dataset.light, false);
      })
    );
    $("lightAuto").addEventListener("change", (e) => {
      this.state.lightAuto = e.target.checked;
      $("lightSel").classList.toggle("disabled-soft", this.state.lightAuto);
      if (this.state.lightAuto) this.startLightAuto();
      else this.stopLightAuto();
      this.autosave();
    });
    $("lightIntensity").addEventListener("input", (e) => {
      this.state.lightIntensity = parseFloat(e.target.value);
      $("lightIntensityVal").textContent = this.state.lightIntensity.toFixed(2);
      if (this.head) { this.head.lightIntensity = this.state.lightIntensity; this.head.setLightPreset(this.state.lightPreset); }
      this.autosave();
    });
    $("metalness").addEventListener("input", (e) => {
      this.state.metalness = parseFloat(e.target.value);
      $("metalnessVal").textContent = this.state.metalness.toFixed(2);
      if (this.head) this.head.setMaterialProps({ metalness: this.state.metalness });
      this.autosave();
    });
    $("roughness").addEventListener("input", (e) => {
      this.state.roughness = parseFloat(e.target.value);
      $("roughnessVal").textContent = this.state.roughness.toFixed(2);
      if (this.head) this.head.setMaterialProps({ roughness: this.state.roughness });
      this.autosave();
    });
  }

  // ============ Two-person slots & head presets ============
  slotOptions() {
    const opts = [["", "현재 편집중"]];
    for (const [id, label] of Object.entries(Settings.BUILTIN_HEADS)) opts.push([id, label + " (기본)"]);
    for (const name of Object.keys(Settings.getHeadPresets())) opts.push(["p:" + name, name]);
    return opts;
  }

  populateSlotSelects() {
    const opts = this.slotOptions();
    for (let i = 0; i < 2; i++) {
      const sel = $("slot" + i);
      if (!sel) continue;
      const cur = this.state.slotPresets[i] || "";
      sel.innerHTML = opts
        .map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`)
        .join("");
    }
  }

  bindSlotsAndHeadPresets() {
    for (let i = 0; i < 2; i++) {
      $("slot" + i).addEventListener("change", (e) => {
        this.state.slotPresets[i] = e.target.value;
        this.syncUnits();
        this.autosave();
      });
    }
    $("saveHeadPresetBtn").addEventListener("click", () => {
      const name = $("headPresetName").value.trim();
      if (!name) return this.flashSave("프리셋 이름을 입력하세요");
      Settings.saveHeadPreset(name, Settings.avatarBundle(this.state));
      $("headPresetName").value = "";
      this.renderHeadPresetList();
      this.populateSlotSelects();
      this.flashSave(`헤드 프리셋 "${name}" 저장됨 ✓`);
    });
  }

  renderHeadPresetList() {
    const list = $("headPresetList");
    if (!list) return;
    const presets = Settings.getHeadPresets();
    const names = Object.keys(presets);
    list.innerHTML = names.length ? "" : '<li style="opacity:.6;justify-content:center">저장된 헤드 프리셋 없음</li>';
    for (const name of names) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = name;
      span.title = "현재 편집 얼굴로 불러오기";
      span.addEventListener("click", () => this.loadHeadPresetToEditor(name));
      const del = document.createElement("button");
      del.textContent = "✕";
      del.addEventListener("click", () => {
        Settings.deleteHeadPreset(name);
        // any slot pointing at it falls back to editing avatar
        this.state.slotPresets = this.state.slotPresets.map((s) => (s === "p:" + name ? "" : s));
        this.renderHeadPresetList();
        this.populateSlotSelects();
        this.syncUnits();
      });
      li.appendChild(span);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  loadHeadPresetToEditor(name) {
    const b = Settings.getHeadPresets()[name];
    if (!b) return;
    Object.assign(this.state, {
      headType: b.headType, faceMode: b.faceMode, gridN: b.gridN,
      paintFaces: JSON.parse(JSON.stringify(b.paintFaces)),
      faceColor: b.faceColor, cubeColor: b.cubeColor, eyeColor: b.eyeColor,
      browColor: b.browColor, mouthColor: b.mouthColor, cheekColor: b.cheekColor,
    });
    this.applyStateToUI();
    this.flashSave(`"${name}" 편집 얼굴로 불러옴 ✓`);
  }

  // ============ UI binding ============
  bindUI() {
    $("startBtn").addEventListener("click", () => this.start());
    $("recordBtn").addEventListener("click", () => this.toggleRecord());
    $("cameraSelect").addEventListener("change", (e) => {
      if (this.video.srcObject) this.switchCamera(e.target.value);
      else { this.state.cameraId = e.target.value; this.autosave(); }
    });

    // tabs
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add("active");
      })
    );

    // head type (applies to the editing avatar). GLB is loaded on unit 0.
    document.querySelectorAll("[data-headtype]").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.headtype === "glb" && this.head && !this.head.units[0].hasGLB()) {
          $("glbInfo").textContent = "먼저 GLB 파일을 선택하세요.";
          return;
        }
        document.querySelectorAll("[data-headtype]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.state.headType = b.dataset.headtype;
        this.syncUnits();
        this.autosave();
      })
    );

    // GLB load (editing avatar / person 1)
    $("glbInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!this.head) {
        $("glbInfo").textContent = "먼저 카메라를 시작하세요.";
        return;
      }
      $("glbInfo").textContent = "GLB 로딩 중…";
      try {
        const buf = await file.arrayBuffer();
        const info = await this.head.units[0].loadGLB(buf);
        this.state.headType = "glb";
        this.state.slotPresets[0] = ""; // person 1 = editing avatar (GLB)
        document.querySelectorAll("[data-headtype]").forEach((x) => x.classList.remove("active"));
        document.querySelector('[data-headtype="glb"]').classList.add("active");
        this.syncUnits();
        this.populateSlotSelects();
        $("glbInfo").textContent = `로드 완료: ${file.name} · 모프타깃 ${info.morphCount}개${
          info.morphCount ? " (표정 자동 반영, 사람1)" : " (표정 미지원, 포즈만)"
        }`;
        this.autosave();
      } catch (err) {
        $("glbInfo").textContent = "로드 실패: " + err.message;
      }
    });

    // alignment sliders
    this.bindRange("scale", "scaleVal", (v) => v.toFixed(2));
    this.bindRange("offsetX", "offsetXVal", (v) => Math.round(v));
    this.bindRange("offsetY", "offsetYVal", (v) => Math.round(v));
    this.bindRange("offsetZ", "offsetZVal", (v) => Math.round(v));
    this.bindRangeRaw("rotX");
    this.bindRangeRaw("rotY");
    this.bindRangeRaw("rotZ");
    $("mirrorToggle").addEventListener("change", (e) => {
      this.state.mirror = e.target.checked;
      this.autosave();
    });

    // emotion mode
    document.querySelectorAll("[data-emomode]").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-emomode]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.state.emotionMode = b.dataset.emomode;
        $("manualEmotion").classList.toggle("disabled", this.state.emotionMode !== "manual");
        this.autosave();
      })
    );
    document.querySelectorAll("[data-emotion]").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-emotion]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.state.manualEmotion = b.dataset.emotion;
        this.renderPreview();
        this.autosave();
      })
    );
    this.bindRange("intensity", "intensityVal", (v) => v.toFixed(2), () => this.renderPreview());
    this.bindRange("exprStrength", "exprStrengthVal", (v) => v.toFixed(2));
    $("speakToggle").addEventListener("change", (e) => {
      this.state.speaking = e.target.checked;
      this.autosave();
    });

    // appearance colors
    const colorMap = {
      faceColor: "faceColor",
      cubeColor: "cubeColor",
      eyeColor: "eyeColor",
      browColor: "browColor",
      mouthColor: "mouthColor",
      cheekColor: "cheekColor",
    };
    for (const id of Object.keys(colorMap)) {
      $(id).addEventListener("input", (e) => {
        this.state[id] = e.target.value;
        this.syncColorsToHead();
        this.renderPreview();
        this.autosave();
      });
    }

    // capture toggles
    $("audioToggle").addEventListener("change", (e) => {
      this.state.audio = e.target.checked;
      this.autosave();
    });
    $("showVideoToggle").addEventListener("change", (e) => {
      this.state.showVideo = e.target.checked;
      this.autosave();
    });

    // settings buttons
    $("saveBtn").addEventListener("click", () => {
      Settings.saveSettings(this.state);
      this.flashSave("저장되었습니다 ✓");
    });
    $("loadBtn").addEventListener("click", () => {
      const s = Settings.loadSettings();
      if (s) {
        this.state = s;
        this.resampleAllGrids(this.state.gridN);
        this.applyStateToUI();
        this.flashSave("불러왔습니다 ✓");
      } else {
        this.flashSave("저장된 설정이 없습니다");
      }
    });
    $("exportBtn").addEventListener("click", () => Settings.exportJSON(this.state));
    $("copyBtn").addEventListener("click", () => this.copySettings());
    $("importInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        this.state = await Settings.importJSON(file);
        this.resampleAllGrids(this.state.gridN);
        this.applyStateToUI();
        this.flashSave("가져왔습니다 ✓");
      } catch {
        this.flashSave("가져오기 실패");
      }
    });
    $("resetBtn").addEventListener("click", () => {
      this.state = Settings.freshDefaults();
      Settings.clearSettings();
      this.applyStateToUI();
      this.flashSave("기본값으로 초기화");
    });

    // presets
    $("savePresetBtn").addEventListener("click", () => {
      const name = $("presetName").value.trim();
      if (!name) return this.flashSave("프리셋 이름을 입력하세요");
      Settings.savePreset(name, this.state);
      $("presetName").value = "";
      this.renderPresetList();
      this.flashSave(`프리셋 "${name}" 저장됨 ✓`);
    });
  }

  bindRange(id, valId, fmt, extra) {
    const el = $(id);
    el.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      this.state[id] = v;
      $(valId).textContent = fmt(v);
      if (extra) extra();
      this.autosave();
    });
  }
  bindRangeRaw(id) {
    const el = $(id);
    el.addEventListener("input", (e) => {
      this.state[id] = parseFloat(e.target.value);
      this.autosave();
    });
  }

  applyStateToUI() {
    const s = this.state;
    // head type
    document.querySelectorAll("[data-headtype]").forEach((x) =>
      x.classList.toggle("active", x.dataset.headtype === s.headType)
    );
    // ranges
    const setR = (id, valId, fmt) => {
      $(id).value = s[id];
      if (valId) $(valId).textContent = fmt ? fmt(s[id]) : s[id];
    };
    setR("scale", "scaleVal", (v) => (+v).toFixed(2));
    setR("offsetX", "offsetXVal", (v) => Math.round(v));
    setR("offsetY", "offsetYVal", (v) => Math.round(v));
    setR("offsetZ", "offsetZVal", (v) => Math.round(v));
    setR("rotX");
    setR("rotY");
    setR("rotZ");
    setR("intensity", "intensityVal", (v) => (+v).toFixed(2));
    setR("exprStrength", "exprStrengthVal", (v) => (+v).toFixed(2));
    // checks
    $("mirrorToggle").checked = s.mirror;
    $("speakToggle").checked = s.speaking;
    $("audioToggle").checked = s.audio;
    $("showVideoToggle").checked = s.showVideo;
    // emotion mode
    document.querySelectorAll("[data-emomode]").forEach((x) =>
      x.classList.toggle("active", x.dataset.emomode === s.emotionMode)
    );
    $("manualEmotion").classList.toggle("disabled", s.emotionMode !== "manual");
    document.querySelectorAll("[data-emotion]").forEach((x) =>
      x.classList.toggle("active", x.dataset.emotion === s.manualEmotion)
    );
    // colors
    $("faceColor").value = s.faceColor;
    $("cubeColor").value = s.cubeColor;
    $("eyeColor").value = s.eyeColor;
    $("browColor").value = s.browColor;
    $("mouthColor").value = s.mouthColor;
    $("cheekColor").value = s.cheekColor;

    // paint editor state
    document.querySelectorAll("[data-facemode]").forEach((x) =>
      x.classList.toggle("active", x.dataset.facemode === s.faceMode)
    );
    $("paintEditor").classList.toggle("disabled", s.faceMode !== "painted");
    $("gridN").value = s.gridN;
    $("gridNVal").textContent = s.gridN;
    $("overlayMouthToggle").checked = s.paintOverlayMouth;
    // reset paint selectors to front / base
    this._selFace = "front";
    this._selLayer = "base";
    document.querySelectorAll("[data-face]").forEach((x) =>
      x.classList.toggle("active", x.dataset.face === "front")
    );
    document.querySelectorAll("[data-layer]").forEach((x) =>
      x.classList.toggle("active", x.dataset.layer === "base")
    );

    // render controls
    $("fov").value = s.fov; $("fovVal").textContent = Math.round(s.fov) + "°";
    $("lightAuto").checked = s.lightAuto;
    $("lightSel").classList.toggle("disabled-soft", s.lightAuto);
    document.querySelectorAll("[data-light]").forEach((x) =>
      x.classList.toggle("active", x.dataset.light === s.lightPreset)
    );
    $("lightIntensity").value = s.lightIntensity; $("lightIntensityVal").textContent = (+s.lightIntensity).toFixed(2);
    $("metalness").value = s.metalness; $("metalnessVal").textContent = (+s.metalness).toFixed(2);
    $("roughness").value = s.roughness; $("roughnessVal").textContent = (+s.roughness).toFixed(2);

    this.syncRenderToHead();
    this.syncUnits();
    this.populateSlotSelects();
    if (s.lightAuto) this.startLightAuto(); else this.stopLightAuto();
    this.repaintEditor();
    this.renderPreview();
  }

  renderPresetList() {
    const list = $("presetList");
    const presets = Settings.getPresets();
    const names = Object.keys(presets);
    list.innerHTML = names.length
      ? ""
      : '<li style="opacity:.6;justify-content:center">저장된 프리셋 없음</li>';
    for (const name of names) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = name;
      span.title = "클릭하여 적용";
      span.addEventListener("click", () => {
        this.state = Settings.normalizeSettings({ ...Settings.DEFAULTS, paintFaces: undefined, ...presets[name] });
        this.resampleAllGrids(this.state.gridN);
        this.applyStateToUI();
        this.flashSave(`"${name}" 적용됨 ✓`);
      });
      const del = document.createElement("button");
      del.textContent = "✕";
      del.addEventListener("click", () => {
        Settings.deletePreset(name);
        this.renderPresetList();
      });
      li.appendChild(span);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  async copySettings() {
    const text = JSON.stringify(this.state, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.flashSave("설정값을 클립보드에 복사했습니다 ✓");
    } catch {
      // Fallback for non-secure contexts / older browsers.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        this.flashSave("설정값을 클립보드에 복사했습니다 ✓");
      } catch {
        this.flashSave("복사 실패 — JSON 내보내기를 사용하세요");
      }
    }
  }

  flashSave(msg) {
    const el = $("saveStatus");
    el.textContent = msg;
    clearTimeout(this._flash);
    this._flash = setTimeout(() => (el.textContent = ""), 2500);
  }

  autosave() {
    // lightweight debounce
    clearTimeout(this._auto);
    this._auto = setTimeout(() => Settings.saveSettings(this.state), 400);
  }
}

// Nearest-neighbour resample of a paint grid when the grid resolution changes.
function resampleGrid(old, oldN, newN) {
  const out = new Array(newN * newN).fill(null);
  if (!old || !oldN) return out;
  for (let y = 0; y < newN; y++) {
    for (let x = 0; x < newN; x++) {
      const sx = Math.min(oldN - 1, Math.floor((x * oldN) / newN));
      const sy = Math.min(oldN - 1, Math.floor((y * oldN) / newN));
      out[y * newN + x] = old[sy * oldN + sx] || null;
    }
  }
  return out;
}

window.addEventListener("DOMContentLoaded", () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("status").textContent = "이 브라우저는 카메라 API를 지원하지 않습니다.";
    return;
  }
  new App();
});
