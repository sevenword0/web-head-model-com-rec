// Main orchestrator: camera, tracking, rendering, recording, UI & settings.
// FaceTracker (MediaPipe) and HeadRenderer (Three.js) pull large CDN modules,
// so they are imported dynamically on camera start — the UI, settings and
// pixel-face preview work immediately without waiting on (or being broken by)
// the network.
import { Recorder } from "./recorder.js";
import { analyzeEmotion, synthesizeBlendshapes, EMOTIONS } from "./emotion.js";
import { drawPixelFace, drawPaintedFace, drawMouthLayer } from "./pixelFace.js";
import * as Settings from "./settings.js";
import { buildSteveGrid } from "./settings.js";

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
    this.lastResult = null;
    this.running = false;

    this._paintColor = this.state.faceColor || PALETTE[0];
    this._erasing = false;
    this._selFace = "front"; // which cube face is being painted
    this._selEmo = "neutral"; // which expression is being painted
    // normalize any stored grids to the current grid size
    this.resampleAllGrids(this.state.gridN);

    this.buildPalette();
    this.bindUI();
    this.bindPaintEditor();
    this.applyStateToUI();
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
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });
    } catch (e) {
      this.setStatus("카메라를 사용할 수 없습니다: " + e.message);
      $("startBtn").disabled = false;
      return;
    }
    this.video.srcObject = stream;
    await this.video.play();

    const w = this.video.videoWidth || 1280;
    const h = this.video.videoHeight || 720;
    this.outCanvas.width = w;
    this.outCanvas.height = h;
    // Match the stage (output) aspect ratio to the actual webcam input.
    $("stageInner").style.aspectRatio = `${w} / ${h}`;

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

    this.head = new HeadRenderer(w, h);
    this.syncColorsToHead();
    this.head.setHeadType(this.state.headType === "glb" && this.head.hasGLB() ? "glb" : "cube");

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

  // ============ Render loop ============
  loop() {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime;
      try {
        this.lastResult = this.tracker.detect(v, performance.now());
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

    const res = this.lastResult;
    if (res && this.head) {
      // Determine blendshapes driving the face/morphs.
      const live = res.blendshapes;
      let driving;
      let emotion, intensity;

      if (this.state.emotionMode === "manual") {
        emotion = this.state.manualEmotion;
        intensity = this.state.intensity;
        driving = synthesizeBlendshapes(emotion, intensity);
      } else {
        const a = analyzeEmotion(live);
        emotion = a.top;
        intensity = a.intensity;
        driving = live;
        this.lastAuto = a;
      }

      // Speaking mouth: live jaw open always blended in (if enabled).
      const liveJaw = live.get("jawOpen") || 0;
      const synthJaw = driving.get("jawOpen") || 0;
      const mouthOpen = this.state.speaking ? Math.max(liveJaw, synthJaw) : synthJaw;
      const mouthWide = 1 - (live.get("mouthPucker") || 0) * 0.7;

      // Update cube pixel face
      this.head.updateFace({
        emotion,
        intensity,
        mouthOpen,
        mouthWide,
        blinkL: live.get("eyeBlinkLeft") || 0,
        blinkR: live.get("eyeBlinkRight") || 0,
      });

      // Drive GLB morph targets (mix synthetic emotion + live speaking)
      const morphMap = new Map(driving);
      if (this.state.speaking) morphMap.set("jawOpen", mouthOpen);
      this.head.applyMorphs(morphMap, this.state.exprStrength);

      // Align + render head
      this.head.align(res.landmarks, res.matrix, {
        mirror: this.state.mirror,
        scaleMul: this.state.scale,
        offsetX: this.state.offsetX,
        offsetY: this.state.offsetY,
        rotX: this.state.rotX,
        rotY: this.state.rotY,
        rotZ: this.state.rotZ,
      });
      this.head.render();
      ctx.drawImage(this.head.canvas, 0, 0, W, H);

      this.updateReadout(emotion, intensity, live);
    } else if (this.head) {
      this.head.hide();
      this.setStatus("얼굴을 찾는 중…");
    }
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

  // ============ Settings <-> head ============
  syncColorsToHead() {
    if (!this.head) return;
    this.head.setColors({
      face: this.state.faceColor,
      cube: this.state.cubeColor,
      eye: this.state.eyeColor,
      brow: this.state.browColor,
      mouth: this.state.mouthColor,
      cheek: this.state.cheekColor,
    });
    this.syncPaintToHead();
  }

  syncPaintToHead() {
    if (!this.head) return;
    this.head.setFaceMode(this.state.faceMode);
    this.head.paintOverlayMouth = this.state.paintOverlayMouth;
    this.head.setPaintData(this.state.paintFaces, this.state.gridN);
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
      // Preview shows the currently selected face+expression art.
      const grid = this.getGrid(this._selFace, this._selEmo, false);
      drawPaintedFace(ctx, c.width, grid, this.state.gridN, this.state.faceColor);
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

  // Return the grid for face+emotion. If `create`, allocate a blank grid of the
  // right size (and resample any existing one) and store it back.
  getGrid(face, emo, create) {
    const N = this.state.gridN;
    const need = N * N;
    const set = (this.state.paintFaces[face] = this.state.paintFaces[face] || {});
    let grid = set[emo];
    if (Array.isArray(grid) && grid.length === need) return grid;
    if (!create && (!Array.isArray(grid) || grid.length !== need)) {
      // resample for display only (don't mutate) if size mismatched
      if (Array.isArray(grid)) {
        return resampleGrid(grid, Math.round(Math.sqrt(grid.length)), N);
      }
      return null;
    }
    const oldN = Array.isArray(grid) ? Math.round(Math.sqrt(grid.length)) : 0;
    grid = resampleGrid(grid, oldN, N);
    set[emo] = grid;
    return grid;
  }

  // Resample every stored grid to the current gridN (called when gridN changes).
  resampleAllGrids(newN) {
    for (const face of Object.keys(this.state.paintFaces)) {
      const set = this.state.paintFaces[face];
      for (const emo of Object.keys(set)) {
        const g = set[emo];
        if (Array.isArray(g) && g.length !== newN * newN) {
          set[emo] = resampleGrid(g, Math.round(Math.sqrt(g.length)), newN);
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
    ctx.fillStyle = this.state.faceColor;
    ctx.fillRect(0, 0, c.width, c.height);
    const grid = this.getGrid(this._selFace, this._selEmo, false);
    if (grid) {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const col = grid[y * N + x];
          if (!col) continue;
          ctx.fillStyle = col;
          ctx.fillRect(Math.round(x * u), Math.round(y * u), Math.ceil(u), Math.ceil(u));
        }
      }
    }
    // thin, faint grid lines so the art reads clearly
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= N; i++) {
      const p = Math.round(i * u) + 0.5;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, c.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(c.width, p); ctx.stroke();
    }
  }

  paintAt(clientX, clientY) {
    const c = $("paintCanvas");
    const rect = c.getBoundingClientRect();
    const N = this.state.gridN;
    const x = Math.floor(((clientX - rect.left) / rect.width) * N);
    const y = Math.floor(((clientY - rect.top) / rect.height) * N);
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const grid = this.getGrid(this._selFace, this._selEmo, true);
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
    // expression selector
    document.querySelectorAll("[data-emo]").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-emo]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this._selEmo = b.dataset.emo;
        this.repaintEditor();
        this.renderPreview();
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
      $("eraserBtn").classList.toggle("primary", this._erasing);
      this.markActiveSwatch(this._paintColor);
    });
    $("fillBtn").addEventListener("click", () => {
      const N = this.state.gridN;
      this.state.paintFaces[this._selFace][this._selEmo] =
        new Array(N * N).fill(this._erasing ? null : this._paintColor);
      this.repaintEditor();
      this.syncPaintToHead();
      this.renderPreview();
      this.autosave();
    });
    $("clearPaintBtn").addEventListener("click", () => {
      const N = this.state.gridN;
      this.state.paintFaces[this._selFace][this._selEmo] = new Array(N * N).fill(null);
      this.repaintEditor();
      this.syncPaintToHead();
      this.renderPreview();
      this.autosave();
    });
    $("steveBtn").addEventListener("click", () => {
      // Load the built-in Minecraft Steve face onto the current face+expression.
      this.state.faceMode = "painted";
      this.state.gridN = 8;
      this.resampleAllGrids(8);
      this.state.paintFaces[this._selFace][this._selEmo] = buildSteveGrid();
      this.state.faceColor = Settings.STEVE_SKIN;
      $("faceColor").value = Settings.STEVE_SKIN;
      document.querySelectorAll("[data-facemode]").forEach((x) =>
        x.classList.toggle("active", x.dataset.facemode === "painted")
      );
      $("paintEditor").classList.remove("disabled");
      $("gridN").value = 8;
      $("gridNVal").textContent = 8;
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

  // ============ UI binding ============
  bindUI() {
    $("startBtn").addEventListener("click", () => this.start());
    $("recordBtn").addEventListener("click", () => this.toggleRecord());

    // tabs
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add("active");
      })
    );

    // head type
    document.querySelectorAll("[data-headtype]").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.headtype === "glb" && this.head && !this.head.hasGLB()) {
          $("glbInfo").textContent = "먼저 GLB 파일을 선택하세요.";
          return;
        }
        document.querySelectorAll("[data-headtype]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.state.headType = b.dataset.headtype;
        if (this.head) this.head.setHeadType(this.state.headType);
        this.autosave();
      })
    );

    // GLB load
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
        const info = await this.head.loadGLB(buf);
        this.head.setHeadType("glb");
        this.state.headType = "glb";
        document.querySelectorAll("[data-headtype]").forEach((x) => x.classList.remove("active"));
        document.querySelector('[data-headtype="glb"]').classList.add("active");
        $("glbInfo").textContent = `로드 완료: ${file.name} · 모프타깃 ${info.morphCount}개${
          info.morphCount ? " (표정 자동 반영)" : " (표정 미지원, 포즈만)"
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
    // reset paint selectors to front / neutral
    this._selFace = "front";
    this._selEmo = "neutral";
    document.querySelectorAll("[data-face]").forEach((x) =>
      x.classList.toggle("active", x.dataset.face === "front")
    );
    document.querySelectorAll("[data-emo]").forEach((x) =>
      x.classList.toggle("active", x.dataset.emo === "neutral")
    );

    this.syncColorsToHead();
    if (this.head) this.head.setHeadType(s.headType === "glb" && this.head.hasGLB() ? "glb" : "cube");
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
