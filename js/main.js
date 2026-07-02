// Main orchestrator: camera, tracking, rendering, recording, UI & settings.
// FaceTracker (MediaPipe) and HeadRenderer (Three.js) pull large CDN modules,
// so they are imported dynamically on camera start — the UI, settings and
// pixel-face preview work immediately without waiting on (or being broken by)
// the network.
import { Recorder } from "./recorder.js";
import { analyzeEmotion, synthesizeBlendshapes, EMOTIONS } from "./emotion.js";
import { drawPixelFace } from "./pixelFace.js";
import { drawLayeredStatic, REGIONS } from "./faceRig.js";
import { imageToGrid, centerSquare } from "./imagePix.js";
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
    this.NUM_SLOTS = 3;
    this.lastVideoTime = -1;
    this.lastFaces = [null, null, null]; // per-slot last good detection
    this.lastSeen = [0, 0, 0];           // per-slot last detection time
    this.firstSeen = [0, 0, 0];          // start of current continuous presence
    this.running = false;
    this.modelReady = false;

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
    this.bindPixelArt();
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
      stream = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraint(this.state.cameraId), audio: false });
    } catch (e) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      } catch (e2) {
        this.setStatus("카메라를 사용할 수 없습니다: " + e2.message);
        $("startBtn").disabled = false;
        return;
      }
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

    // Start rendering (and enable capture) as soon as the camera is on —
    // screenshots/recording don't need the face model, which can load slowly.
    $("recordBtn").disabled = false;
    $("photoBtn").disabled = false;
    this.modelReady = false;
    this.running = true;
    requestAnimationFrame(() => this.loop());

    this.setStatus("AI 모델 로딩 중… (최초 1회, 수십 초 걸릴 수 있어요)");
    try {
      await this.tracker.init();
      this.modelReady = true;
    } catch (e) {
      this.setStatus("모델 로딩 실패(추적만 불가, 촬영은 가능): " + e.message);
    }
  }

  // ============ Capture / fullscreen mode ============
  toggleCaptureMode() {
    this.setCaptureMode(!document.body.classList.contains("capture-mode"));
  }

  setCaptureMode(on) {
    document.body.classList.toggle("capture-mode", on);
    $("fullscreenBtn").textContent = on ? "✕ 편집으로" : "⛶ 전체화면";
    if (on) {
      const el = document.getElementById("stage"); // includes controls so they stay clickable
      if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
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
    const track = this.video.srcObject && this.video.srcObject.getVideoTracks()[0];
    const cur = this.state.cameraId || (track && track.getSettings().deviceId) || "";
    // Always offer front/back via facingMode (works on iPad/iOS where the rear
    // camera often isn't listed by enumerateDevices).
    const opts = [["facing:user", "전면 카메라"], ["facing:environment", "후면 카메라"]];
    cams.forEach((c, i) => opts.push([c.deviceId, c.label || "카메라 " + (i + 1)]));
    sel.innerHTML = opts
      .map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`)
      .join("");
  }

  // Build a getUserMedia video constraint from a camera id (deviceId or facing:*)
  videoConstraint(id) {
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (id && id.startsWith("facing:")) base.facingMode = { ideal: id.slice(7) };
    else if (id) base.deviceId = { exact: id };
    else base.facingMode = "user";
    return base;
  }

  async switchCamera(id) {
    this.state.cameraId = id;
    this.autosave();
    this.setStatus("카메라 전환 중…");
    try {
      if (this.video.srcObject) this.video.srcObject.getTracks().forEach((t) => t.stop());
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraint(id), audio: false });
      } catch (e1) {
        // exact facing/deviceId can fail on some devices → retry relaxed
        const c = this.videoConstraint(id);
        if (c.deviceId) c.deviceId = { ideal: id };
        stream = await navigator.mediaDevices.getUserMedia({ video: c, audio: false });
      }
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
        // Map each detected face to a slot; track continuous presence per slot.
        const MAX_GRACE = 3000;
        for (let i = 0; i < this.lastFaces.length; i++) {
          if (faces[i]) {
            // new presence if the gap exceeded the longest grace window
            if (now - this.lastSeen[i] > MAX_GRACE + 500) this.firstSeen[i] = now;
            this.lastFaces[i] = faces[i];
            this.lastSeen[i] = now;
          }
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

    // Drive each head unit from its tracked face.
    // A face that was held stably for 3s+ keeps its last position for up to 3s
    // after detection drops (search window); a brief presence uses a short grace.
    const SHORT_GRACE = 600, LONG_GRACE = 3000, ESTABLISHED = 3000;
    const now = performance.now();
    let anyFresh = false;
    let primary = null;
    for (let i = 0; i < this.head.units.length; i++) {
      const established = this.lastSeen[i] - this.firstSeen[i] >= ESTABLISHED;
      const grace = established ? LONG_GRACE : SHORT_GRACE;
      const fresh = this.lastSeen[i] && now - this.lastSeen[i] < grace;
      const face = fresh ? this.lastFaces[i] : null;
      if (face) {
        this.driveUnit(i, face);
        anyFresh = true;
        if (!primary) primary = face;
      } else {
        this.head.units[i].hide();
        if (this._smoothBS) this._smoothBS[i] = null; // reset so it snaps on return
        this.lastSeen[i] = 0; this.firstSeen[i] = 0; // forget; next presence is fresh
      }
    }

    this.head.render();
    ctx.drawImage(this.head.canvas, 0, 0, W, H);

    if (anyFresh && primary) this.updateReadoutFor(primary);
    else this.setStatus(this.modelReady ? "얼굴을 찾는 중…" : "AI 모델 로딩 중…");
  }

  // Exponential moving average of a blendshape map (per slot) to de-jitter.
  smoothBlendshapes(i, raw) {
    const s = this.state.smoothing ?? 0.65;
    const a = Math.max(0.12, 1 - s * 0.9); // expression a bit more responsive than pose
    if (!this._smoothBS) this._smoothBS = [];
    let prev = this._smoothBS[i];
    if (!prev) { prev = new Map(raw); this._smoothBS[i] = prev; return prev; }
    for (const [k, v] of raw) prev.set(k, (prev.get(k) || 0) + (v - (prev.get(k) || 0)) * a);
    return prev;
  }

  // Compute expression/mouth for one face and apply to the matching head unit.
  driveUnit(i, face) {
    const unit = this.head.units[i];
    const live = this.smoothBlendshapes(i, face.blendshapes);
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

    const s = this.state.smoothing ?? 0.65;
    unit.align(face.landmarks, face.matrix, {
      mirror: this.state.mirror,
      scaleMul: this.state.scale,
      offsetX: this.state.offsetX,
      offsetY: this.state.offsetY,
      offsetZ: this.state.offsetZ,
      rotX: this.state.rotX,
      rotY: this.state.rotY,
      rotZ: this.state.rotZ,
      poseAlpha: Math.max(0.05, 1 - s),
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

  // ============ Photo / shutter timer ============
  async takePhoto() {
    if (!this.outCanvas) return;
    const btn = $("photoBtn");
    btn.disabled = true;
    const t = this.state.shutterTimer || 0;
    if (t > 0) await this.runCountdown(t);
    this.captureScreenshot();
    btn.disabled = false;
  }

  runCountdown(sec) {
    return new Promise((resolve) => {
      const el = $("countdown");
      let n = sec;
      el.textContent = n;
      el.classList.remove("hidden");
      this._cdTimer = setInterval(() => {
        n -= 1;
        if (n <= 0) {
          clearInterval(this._cdTimer);
          el.classList.add("hidden");
          resolve();
        } else {
          el.textContent = n;
        }
      }, 1000);
    });
  }

  captureScreenshot() {
    const flash = $("flash");
    flash.classList.remove("fire");
    void flash.offsetWidth; // restart animation
    flash.classList.add("fire");
    const png = (this.state.imageFormat || "jpg") === "png";
    const type = png ? "image/png" : "image/jpeg";
    this.outCanvas.toBlob((blob) => { if (blob) this.addPhoto(blob); }, type, png ? undefined : 0.92);
  }

  addPhoto(blob) {
    const url = URL.createObjectURL(blob);
    const ext = (blob.type || "").includes("png") ? "png" : "jpg";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `head-studio-${stamp}.${ext}`;
    const item = document.createElement("div");
    item.className = "dl-item";
    const img = document.createElement("img");
    img.src = url;
    const info = document.createElement("div");
    const a = document.createElement("a");
    a.href = url; a.download = name; a.textContent = `⬇ ${name}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${(blob.size / 1024).toFixed(0)} KB · ${ext.toUpperCase()}`;
    info.appendChild(a); info.appendChild(meta);
    item.appendChild(img); item.appendChild(info);
    $("downloads").prepend(item);
    // auto-download so it works even in fullscreen capture mode
    a.click();
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
    const isMp4 = (blob.type || "").includes("mp4");
    const ext = isMp4 ? "mp4" : "webm";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `head-studio-${stamp}.${ext}`;
    const item = document.createElement("div");
    item.className = "dl-item";
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    const info = document.createElement("div");
    const a = document.createElement("a");
    a.href = url; a.download = name; a.textContent = `⬇ ${name}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${(blob.size / 1024 / 1024).toFixed(1)} MB · ${blob.type || "video/webm"}`;
    info.appendChild(a);
    info.appendChild(meta);
    if (!isMp4) {
      const conv = document.createElement("button");
      conv.className = "btn small";
      conv.textContent = "🎞 MP4로 변환";
      conv.addEventListener("click", () => this.transcodeToMp4(blob, conv));
      info.appendChild(conv);
    }
    item.appendChild(v);
    item.appendChild(info);
    $("downloads").prepend(item);
  }

  // ---- MP4 transcode via ffmpeg.wasm (lazy, optional) ----
  async ensureFFmpeg() {
    if (this._ffmpeg) return this._ffmpeg;
    const { FFmpeg } = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js");
    const { toBlobURL } = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js");
    const ff = new FFmpeg();
    const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
    });
    this._ffmpeg = ff;
    return ff;
  }

  async transcodeToMp4(blob, btn) {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "변환 중… (최초 로딩 김)";
    try {
      const ff = await this.ensureFFmpeg();
      const { fetchFile } = await import("https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js");
      await ff.writeFile("in.webm", await fetchFile(blob));
      await ff.exec(["-i", "in.webm", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "out.mp4"]);
      const data = await ff.readFile("out.mp4");
      const mp4 = new Blob([data.buffer], { type: "video/mp4" });
      this.addDownload(mp4);
      btn.textContent = "MP4 생성됨 ✓";
    } catch (e) {
      btn.disabled = false;
      btn.textContent = orig;
      alert("MP4 변환에 실패했습니다: " + (e?.message || e) +
        "\n\nWebM 파일은 그대로 저장할 수 있어요. (아이패드/사파리에서는 녹화가 자동으로 MP4로 저장됩니다)");
    }
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
    this.head.setBevel(this.state.bevel || 0);
    this.head.setBlockOptions({
      blockMode: !!this.state.blockFace,
      blockThickness: this.state.blockThickness,
      blockOffset: this.state.blockOffset,
    });
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
    $("bevel").addEventListener("input", (e) => {
      this.state.bevel = parseFloat(e.target.value);
      $("bevelVal").textContent = this.state.bevel.toFixed(2);
      if (this.head) this.head.setBevel(this.state.bevel);
      this.autosave();
    });
    $("blockFace").addEventListener("change", (e) => {
      this.state.blockFace = e.target.checked;
      if (this.head) this.head.setBlockOptions({ blockMode: this.state.blockFace });
      this.autosave();
    });
    $("blockThickness").addEventListener("input", (e) => {
      this.state.blockThickness = parseFloat(e.target.value);
      $("blockThicknessVal").textContent = this.state.blockThickness.toFixed(2);
      if (this.head) this.head.setBlockOptions({ blockThickness: this.state.blockThickness });
      this.autosave();
    });
    $("blockOffset").addEventListener("input", (e) => {
      this.state.blockOffset = parseFloat(e.target.value);
      $("blockOffsetVal").textContent = this.state.blockOffset.toFixed(2);
      if (this.head) this.head.setBlockOptions({ blockOffset: this.state.blockOffset });
      this.autosave();
    });
  }

  // ============ Photo → pixel-art mapping ============
  bindPixelArt() {
    $("selfieBtn").addEventListener("click", () => this.captureSelfiePixel());
    $("pixImageInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) this.loadImagePixel(file);
      e.target.value = "";
    });
  }

  pixOpts() {
    const mode = $("pixPalette").value;
    return {
      N: parseInt($("pixRes").value, 10) || 24,
      colorCount: parseInt($("pixColors").value, 10) || 8,
      paletteMode: mode,
      palette: mode === "palette" ? PALETTE : null,
    };
  }

  applyPixelGridToFace(source, crop) {
    const o = this.pixOpts();
    const grid = imageToGrid(source, crop, o.N, o);
    this.state.gridN = o.N;
    this.resampleAllGrids(o.N);
    // put the photo on the base layer of the selected face; clear overlays
    this.state.paintFaces[this._selFace] = { base: grid, brows: null, eyes: null, mouth: null };
    this.state.faceMode = "painted";
    $("pixInfo").textContent = `${o.N}×${o.N} · ${o.colorCount}색(${o.paletteMode === "palette" ? "지정" : "자동"}) → "${this._selFace}"면에 매핑됨`;
    this.applyStateToUI();
    this.flashSave("사진을 픽셀아트로 매핑했습니다 ✓");
  }

  captureSelfiePixel() {
    const v = this.video;
    if (!v || !v.videoWidth) { $("pixInfo").textContent = "먼저 카메라를 시작하세요."; return; }
    const W = v.videoWidth, H = v.videoHeight, mir = this.state.mirror;
    // draw full frame (mirrored to match the view) then crop the face square
    const full = document.createElement("canvas");
    full.width = W; full.height = H;
    const fx = full.getContext("2d");
    if (mir) { fx.translate(W, 0); fx.scale(-1, 1); }
    fx.drawImage(v, 0, 0);

    let crop;
    const f = this.lastFaces[0];
    if (f && f.landmarks) {
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const lm of f.landmarks) {
        const x = mir ? 1 - lm.x : lm.x;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (lm.y < minY) minY = lm.y; if (lm.y > maxY) maxY = lm.y;
      }
      const cx = (minX + maxX) / 2 * W, cy = (minY + maxY) / 2 * H;
      const s = Math.max(maxX - minX, maxY - minY) * Math.max(W, H) * 1.25;
      crop = { sx: cx - s / 2, sy: cy - s / 2, sw: s, sh: s };
    } else {
      crop = centerSquare(W, H);
    }
    this.applyPixelGridToFace(full, crop);
  }

  loadImagePixel(file) {
    const img = new Image();
    img.onload = () => {
      this.applyPixelGridToFace(img, centerSquare(img.naturalWidth, img.naturalHeight));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => { $("pixInfo").textContent = "이미지를 불러오지 못했습니다."; };
    img.src = URL.createObjectURL(file);
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
    for (let i = 0; i < this.NUM_SLOTS; i++) {
      const sel = $("slot" + i);
      if (!sel) continue;
      const cur = this.state.slotPresets[i] || "";
      sel.innerHTML = opts
        .map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`)
        .join("");
    }
  }

  bindSlotsAndHeadPresets() {
    for (let i = 0; i < this.NUM_SLOTS; i++) {
      const sel = $("slot" + i);
      if (!sel) continue;
      sel.addEventListener("change", (e) => {
        this.state.slotPresets[i] = e.target.value;
        this.syncUnits();
        this.autosave();
      });
    }
    $("copyAvatarBtn").addEventListener("click", () => this.copyCurrentAvatar());
    $("pasteAvatarBtn").addEventListener("click", () => this.pasteAvatar());
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
      const copy = document.createElement("button");
      copy.textContent = "📋";
      copy.title = "클립보드에 복사";
      copy.style.color = "var(--accent)";
      copy.addEventListener("click", () => this.copyHeadPreset(name));
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
      li.appendChild(copy);
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
    $("photoBtn").addEventListener("click", () => this.takePhoto());
    $("shutterTimer").addEventListener("change", (e) => { this.state.shutterTimer = parseInt(e.target.value, 10) || 0; this.autosave(); });
    $("imgFormat").addEventListener("change", (e) => { this.state.imageFormat = e.target.value; this.autosave(); });
    $("fullscreenBtn").addEventListener("click", () => this.toggleCaptureMode());
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) this.setCaptureMode(false);
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
    this.bindRange("smoothing", "smoothingVal", (v) => v.toFixed(2));
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
    setR("smoothing", "smoothingVal", (v) => (+v).toFixed(2));
    setR("intensity", "intensityVal", (v) => (+v).toFixed(2));
    setR("exprStrength", "exprStrengthVal", (v) => (+v).toFixed(2));
    // checks
    $("mirrorToggle").checked = s.mirror;
    $("speakToggle").checked = s.speaking;
    $("audioToggle").checked = s.audio;
    $("showVideoToggle").checked = s.showVideo;
    $("shutterTimer").value = String(s.shutterTimer || 0);
    $("imgFormat").value = s.imageFormat || "jpg";
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
    $("bevel").value = s.bevel || 0; $("bevelVal").textContent = (+(s.bevel || 0)).toFixed(2);
    $("blockFace").checked = !!s.blockFace;
    $("blockThickness").value = s.blockThickness ?? 0.12; $("blockThicknessVal").textContent = (+(s.blockThickness ?? 0.12)).toFixed(2);
    $("blockOffset").value = s.blockOffset ?? 0.02; $("blockOffsetVal").textContent = (+(s.blockOffset ?? 0.02)).toFixed(2);

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

  async copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      this.flashSave(okMsg);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        this.flashSave(okMsg);
        return true;
      } catch {
        this.flashSave("복사 실패 — JSON 내보내기를 사용하세요");
        return false;
      }
    }
  }

  copySettings() {
    this.copyText(JSON.stringify(this.state, null, 2), "설정값을 클립보드에 복사했습니다 ✓");
  }

  copyHeadPreset(name) {
    const b = Settings.getHeadPresets()[name];
    if (!b) return;
    this.copyText(JSON.stringify({ headPreset: name, bundle: b }, null, 2), `프리셋 "${name}"을 클립보드에 복사했습니다 ✓`);
  }

  copyCurrentAvatar() {
    const name = $("headPresetName").value.trim() || "외형";
    this.copyText(JSON.stringify({ headPreset: name, bundle: Settings.avatarBundle(this.state) }, null, 2),
      "현재 외형을 클립보드에 복사했습니다 ✓");
  }

  // Read a copied avatar/preset from the clipboard, apply to the editor (+save).
  async pasteAvatar() {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch {}
    if (!text) text = prompt("붙여넣을 외형 JSON을 입력하세요") || "";
    if (!text.trim()) return;
    let obj;
    try { obj = JSON.parse(text); } catch { return this.flashSave("붙여넣기 실패 — JSON 형식이 아닙니다"); }
    const bundle = obj && obj.bundle ? obj.bundle : obj;
    if (!bundle || !bundle.paintFaces) return this.flashSave("붙여넣기 실패 — 외형 데이터가 아닙니다");
    Object.assign(this.state, {
      headType: bundle.headType || "cube",
      faceMode: bundle.faceMode || "painted",
      gridN: bundle.gridN || 8,
      paintFaces: JSON.parse(JSON.stringify(bundle.paintFaces)),
      faceColor: bundle.faceColor, cubeColor: bundle.cubeColor, eyeColor: bundle.eyeColor,
      browColor: bundle.browColor, mouthColor: bundle.mouthColor, cheekColor: bundle.cheekColor,
    });
    const name = (obj && obj.headPreset) || "";
    if (name) { Settings.saveHeadPreset(name, Settings.avatarBundle(this.state)); this.renderHeadPresetList(); this.populateSlotSelects(); }
    this.applyStateToUI();
    this.flashSave(name ? `"${name}" 외형을 붙여넣고 프리셋 저장 ✓` : "외형을 붙여넣었습니다 ✓");
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
