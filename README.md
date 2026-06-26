# 🎭 Head Model Studio

웹캠 영상의 **머리 위치에 3D 모델을 합성**하고, 감정 정도에 따라 **표정을 적용**하며, **녹화·녹음 후 다운로드**까지 가능한 100% 클라이언트 사이드 웹앱입니다.

MediaPipe FaceLandmarker로 얼굴/머리 포즈와 52종 표정 블렌드셰이프를 추적하고, Three.js로 머리에 모델을 렌더링합니다. 모든 처리는 브라우저 안에서만 일어나며 카메라/마이크 데이터는 외부로 전송되지 않습니다.

## ▶️ 바로 실행 (설치 불필요)

> 카메라·마이크 사용을 위해 HTTPS 환경에서 실행됩니다. 브라우저에서 권한을 허용해 주세요.

- **GitHub Pages**: <https://sevenword0.github.io/web-head-model-com-rec/>
  - (저장소 Settings → Pages 의 소스가 *GitHub Actions* 로 설정되면 push 시 자동 배포됩니다.)
- **즉시 실행 링크 (Pages 설정 없이 바로 동작)**:
  <https://raw.githack.com/sevenword0/web-head-model-com-rec/claude/web-avatar-emotion-speech-vpr2ny/index.html>

### 로컬 실행

ES 모듈과 카메라 권한 때문에 `file://` 로는 동작하지 않습니다. 간단한 정적 서버를 띄우세요.

```bash
# Python
python3 -m http.server 8080
# 또는 Node
npx serve .
```

브라우저에서 `http://localhost:8080` 접속.

## ✨ 주요 기능

| 기능 | 설명 |
| --- | --- |
| **머리 추적 & 합성** | MediaPipe FaceLandmarker의 478 랜드마크 + 4×4 헤드 포즈로 모델을 얼굴에 정렬 |
| **기본 큐브 머리** | 눈·코·입·눈썹·볼터치를 **픽셀 아트**로 그려 큐브 정면에 매핑 |
| **GLB/GLTF 로드** | 내 모델을 불러와 머리에 합성. ARKit 모프타깃이 있으면 표정 자동 반영 |
| **감정 표정** | 자동 감지(기쁨/슬픔/분노/놀람/중립) 또는 수동 지정 + **감정 정도(강도) 슬라이더** |
| **말하는 입모양** | 실시간 입 벌림(jawOpen)을 입모양/모프에 반영 (비언어 발화 시각화) |
| **녹화 & 녹음** | 합성 화면 + 마이크 음성을 WebM으로 녹화 후 다운로드 |
| **설정 저장** | 정렬·외형·감정 옵션을 브라우저 저장 / JSON 내보내기·가져오기 / 이름 있는 프리셋 |

## 🕹 사용법

1. **카메라 시작** 버튼 → 권한 허용 (최초 1회 AI 모델 다운로드에 수십 초 소요).
2. **머리** 탭에서 큐브/GLB 선택, 크기·오프셋·회전으로 얼굴에 맞게 정렬.
3. **감정** 탭에서 자동 감지 또는 수동 감정 + 강도 조절.
4. **외형** 탭에서 큐브 픽셀 페이스 색상 변경.
5. **● 녹화** → **■ 정지** 후 하단 목록에서 영상 다운로드.
6. **설정** 탭에서 저장/프리셋 관리.

## 🧩 기술 구성

```
index.html            UI 레이아웃 + importmap
css/style.css         스타일
js/main.js            오케스트레이션 (카메라·루프·녹화·UI·설정)
js/faceTracker.js     MediaPipe FaceLandmarker 래퍼
js/headRenderer.js    Three.js (큐브 + GLB + 포즈 정렬 + 모프)
js/pixelFace.js       눈·코·입 픽셀 페이스 (감정/입모양)
js/emotion.js         블렌드셰이프 → 감정 분석/합성
js/recorder.js        MediaRecorder (캔버스 + 오디오)
js/settings.js        localStorage 저장 / 프리셋 / JSON I/O
```

- [Three.js](https://threejs.org/) `0.169` (CDN, importmap)
- [@mediapipe/tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) `0.10.18` (CDN)
- 빌드 도구 없음 — 순수 정적 파일.

## ⚠️ 참고

- 권장 브라우저: 최신 Chrome / Edge (WebGL2 + MediaRecorder + WebGPU/WASM).
- GLB 표정 자동 반영은 모델에 ARKit 호환 모프타깃(`jawOpen`, `mouthSmileLeft` 등)이 있을 때 동작합니다. 없으면 포즈만 따라갑니다.
- iOS Safari는 `captureStream`/`MediaRecorder` 지원이 제한적일 수 있습니다.
