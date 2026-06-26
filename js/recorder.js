// Recorder: captures the output canvas stream (+ optional mic audio) to a webm.
export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.mediaRecorder = null;
    this.chunks = [];
    this.audioStream = null;
    this.startTime = 0;
    this.onStop = null;
  }

  static pickMimeType() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=h264,opus",
      "video/webm",
      "video/mp4",
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  }

  async start({ withAudio = true, fps = 30 } = {}) {
    this.chunks = [];
    const canvasStream = this.canvas.captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks()];

    if (withAudio) {
      try {
        this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tracks.push(...this.audioStream.getAudioTracks());
      } catch (e) {
        console.warn("마이크 접근 실패, 영상만 녹화합니다.", e);
      }
    }

    const stream = new MediaStream(tracks);
    const mimeType = Recorder.pickMimeType();
    this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.mimeType = mimeType || "video/webm";

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType });
      if (this.audioStream) {
        this.audioStream.getTracks().forEach((t) => t.stop());
        this.audioStream = null;
      }
      if (this.onStop) this.onStop(blob);
    };

    this.mediaRecorder.start(100);
    this.startTime = performance.now();
  }

  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
  }

  get recording() {
    return this.mediaRecorder && this.mediaRecorder.state === "recording";
  }

  get elapsedMs() {
    return this.recording ? performance.now() - this.startTime : 0;
  }
}
