// Main orchestrator: camera, tracking, rendering, recording, UI & settings.
// FaceTracker (MediaPipe) and HeadRenderer (Three.js) pull large CDN modules,
// so they are imported dynamically on camera start — the UI, settings and
// pixel-face preview work immediately without waiting on (or being broken by)
// the network.
import { Recorder } from "./recorder.js";
import { analyzeEmotion, synthesizeBlendshapes, EMOTIONS } from "./emotion.js";
import { drawPixelFace } from "./pixelFace.js";
import * as Settings from "./settings.js";

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

    this.state = Settings.loadSettings() || { ...Settings.DEFAULTS };
    this.lastVideoTime = -1;
    this.lastResult = null;
    this.running = false;

    this.bindUI();
    this.applyStateToUI();
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
  }

  renderPreview() {
    const c = $("facePreview");
    const ctx = c.getContext("2d");
    drawPixelFace(ctx, c.width, {
      colors: {
        face: this.state.faceColor,
        eye: this.state.eyeColor,
        brow: this.state.browColor,
        mouth: this.state.mouthColor,
        cheek: this.state.cheekColor,
      },
      emotion: this.state.emotionMode === "manual" ? this.state.manualEmotion : "happy",
      intensity: this.state.intensity,
      mouthOpen: 0.3,
      mouthWide: 1,
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
        this.applyStateToUI();
        this.flashSave("가져왔습니다 ✓");
      } catch {
        this.flashSave("가져오기 실패");
      }
    });
    $("resetBtn").addEventListener("click", () => {
      this.state = { ...Settings.DEFAULTS };
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

    this.syncColorsToHead();
    if (this.head) this.head.setHeadType(s.headType === "glb" && this.head.hasGLB() ? "glb" : "cube");
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
        this.state = { ...Settings.DEFAULTS, ...presets[name] };
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

window.addEventListener("DOMContentLoaded", () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("status").textContent = "이 브라우저는 카메라 API를 지원하지 않습니다.";
    return;
  }
  new App();
});
