# 01. 시장 레퍼런스 & 오픈소스 조사 — 피아노 리듬게임

> 작성일: 2026-10-05 · 범위: 상용 앱, 오픈소스, 핵심 기술 사실, MVP 스택, 차별화 방안
> 방법: 웹 검색 + GitHub API 메타데이터(라이선스, `pushed_at`, 스타 수, 2026-10-05 조회).
> 가격은 미국 기준 정가 또는 공시 할인가이며 지역/프로모션에 따라 달라짐. "확인 필요"로 표시한 항목은 1차 출처로 재검증해야 함.

---

## 0. TL;DR

- **시장 구도**: 학습 앱(Simply Piano, flowkey, Skoove, Yousician)은 **마이크와 MIDI를 모두 지원하고 연 $100~180 구독**이 표준이다. 게임형 앱(Synthesia, Melodics, Playground Sessions)은 **MIDI 중심이며 일회성 결제 또는 평생 이용권**을 쓴다. "아무 곡이나 넣으면 플레이 가능한 차트로 만들어 주는" 제품은 아직 공백이다. Yamaha Smart Pianist는 코드 반주보까지만 만들고, Klangio/Songscription은 악보만 출력하며 게임 요소가 없다.
- **2026년 트렌드**: AI 코치가 등장했다. ROLI는 적외선 카메라로 손 추적과 대화형 코칭을, 국내 mymusic5는 음성 피드백을 제공한다. Simply Piano는 XR(Vision Pro/Android XR)로 확장했다.
- **Web MIDI**: Chrome/Edge/Firefox(108+)는 지원하고 **Safari와 모든 iOS 브라우저는 미지원**이다. WebKit은 핑거프린팅을 이유로 반대 입장이다. 따라서 데스크톱은 **Electron**(Chromium 내장)으로 macOS 공백을 메우고, iOS는 네이티브 래퍼가 필요하다.
- **판정 윈도우**: 리듬게임 Perfect 구간은 ±16~23ms다(osu!mania ±16, Etterna J4 ±22.5). 피아노는 화음 타건 시차(멜로디 리드 약 30ms)와 BLE MIDI 지터를 감안해 **Perfect ±35 / Great ±70 / Good ±120 / Miss >±180ms**를 초기값으로 제안한다.
- **라이선스 지뢰**: GPL 계열(Neothesia, PianoBooster, sightread, WebAudioFont, aubio)과 AGPL 계열(Audiveris, homr, Essentia.js)이 있다. 학습 데이터와 가중치도 비상업 라이선스인 경우가 있다(MAESTRO, madmom 모델은 CC BY-NC-SA). 반면 **basic-pitch, Demucs, Tone.js, OSMD, music21, oemer, Beat This!는 permissive 라이선스**다.
- **YouTube 링크 입력**: YouTube 약관상 허가 없는 다운로드가 금지되고, 채보물은 2차적저작물이다. 2025~26년 PO Token/SABR 도입으로 서버측 다운로드도 불안정하다. 따라서 **사용자 업로드(개인용, 비공개) + 퍼블릭 도메인/라이선스 카탈로그**로 시작할 것을 권장한다.

---

## 1. 상용 레퍼런스

| 제품 | 입력 | 핵심 UX | 게이미피케이션 | 가격 모델 | 차용할 점 | 공략할 약점 |
|---|---|---|---|---|---|---|
| **Synthesia** (Win/Mac/iOS/Android) | MIDI, PC 키보드, 터치 (마이크 없음) | 떨어지는 노트 + 선택형 악보, 대기(wait) 모드, 양손 분리, 구간 반복, 템포 조절 | 점수/정확도 위주로 가벼움 | 무료 체험 + **Learning Pack $39 일회성** ([pianoers](https://pianoers.com/synthesia-piano-review/)) | **임의 MIDI 파일 가져오기**, 단순하고 강력한 연습 도구 세트 | 커리큘럼·소셜·진행 시스템 없음, 마이크 미지원, UI가 낡음 |
| **Simply Piano** (Hello Simply, 구 JoyTunes) | 마이크, USB MIDI, BT MIDI(iOS 전용, Android 미지원) ([help](https://piano-help.hellosimply.com/en/articles/3987010-bluetooth-headphones-and-bluetooth-midi)) | 악보형 스크롤(가로 진행) + 반주 트랙, 짧은 단계형 코스 | 곡별 별점, 연속 학습(streak), 일일 운동 | 개인 $17.90/월, $169.90/년, 가족 플랜 ([pianostartguide](https://www.pianostartguide.com/simply-piano-pricing/)) | 첫 5분 온보딩, 반주가 붙는 "바로 곡 연주" 경험 | 비싼 구독, 고급 단계가 얕음, 원하는 곡을 가져올 수 없음 |
| **flowkey** | 마이크, MIDI | **실제 연주 영상 + 악보 동기화**, 대기 모드, 루프, 감속, 한 손 연습 | 약함 | Classic $99.99/년, Premium $149.99/년 ([help.flowkey](https://help.flowkey.com/en/articles/4466337-which-subscription-plans-are-available)) | 영상과 악보 동기화, 곡별 난이도 편곡 | 게임성 부족, 판정이 관대하고 피드백이 모호함 |
| **Yousician (Piano)** | 마이크(다성 엔진), MIDI | 건반 위로 떨어지는 색 블록 / 가로 스크롤 / 악보 3종 표기 ([Play](https://play.google.com/store/apps/details?id=com.yousician.piano&hl=en-US)) | 별점, 스트릭, **주간 리더보드·챌린지** | Premium $119.99/년, Premium+ $179.99/년(아티스트 곡) ([subger](https://subger.com/en/service/yousician)) | 표기법 전환(초보→악보)과 주간 경쟁 | 피아노는 기타 대비 콘텐츠·완성도가 약하다는 평가 ([pract.is](https://pract.is/blog/yousician-review-guitar-vs-piano-2026)) |
| **Piano Marvel** | MIDI 중심(USB/BT), 마이크 평가는 iOS 전용(2023~) ([support](https://pianomarvel.com/en/article/how-to-use-piano-marvel-with-an-acoustic-piano)) | 악보 기반, 교재식 커리큘럼 | **SASR 초견 평가**(100~1900점, 90레벨) | $17.99/월, $129.99/년, 교사용 10석 $765/년 ([store](https://store.pianomarvel.com/product/piano-marvel-premium-12-month-25-accounts/)) | 객관적 실력 지표, 교사 대시보드 | UI가 낡았고 팝 곡이 부족, 교사 라이선스가 비쌈 |
| **Skoove** | 마이크, USB/BT MIDI | 악보 우선, 구조화된 레슨 | 진행도 중심 | $29.99/월, $149.99/년 ([pianostartguide](https://www.pianostartguide.com/skoove-review/)) | 이론과 연주를 연결하는 커리큘럼 | 게임성 약함, 가격 대비 곡 수 |
| **Playground Sessions** | **MIDI 전용**(마이크 없음) | 악보 + 가로 스크롤, 영상 레슨 | 점수·레벨 기반 게임형 | **평생 $219.99**, 단 저작권 곡은 2년만 포함 ([pract.is](https://pract.is/blog/playground-sessions-review-2026)) | 평생 이용권 가격 모델 | 저작권 곡 기간 제한, 어쿠스틱 피아노 불가 |
| **Rocksmith+** (Ubisoft) | 마이크, 유선 MIDI(BT MIDI 미지원) ([Ubisoft](https://www.ubisoft.com/en-au/help/rocksmith-plus/gameplay)) | **3D 떨어지는 노트 또는 악보** 선택 ([Engadget](https://www.engadget.com/ubisofts-rocksmith-guitar-learning-app-now-teaches-piano-184530282.html)) | 게임 연출, 곡 숙련도 | $19.99/월, $139.99/년 ([WindowsCentral](https://www.windowscentral.com/gaming/is-rocksmith-worth-the-subscription-cost)) | AAA급 하이웨이 연출, 25~88건반 대응 | 피아노는 부가 기능 수준, BT MIDI 없음 |
| **Roland Piano App** (Piano Every Day 후속) | 롤랜드 피아노 BT | 원격 제어, 내장곡 악보, 메트로놈, 녹음 | "One Week Master" 7일 과제 | 무료, 악보 500곡 이상은 Roland Cloud 멤버십 필요 ([Roland](https://www.roland.com/us/products/roland_piano_app/)) | 7일 단위 곡 정복 퀘스트 | 자사 하드웨어에 종속 |
| **Casio Music Space** (Chordana Play 통합) | 카시오 악기 USB/BT | **손별 피아노롤**, Step Lesson(맞을 때까지 대기) | 약함 | 무료 ([gear4music](https://www.gear4music.com/blog/casio-music-space/)) | 손별 피아노롤과 대기 레슨 | 자사 악기 종속, 곡 수 제한 |
| **Yamaha Smart Pianist / Rec'n'Share** | 야마하 악기 USB/BT | **Audio to Score**: 오디오 파일에서 코드를 분석해 피아노 반주 악보 자동 생성 / 연주 녹화·공유 ([Yamaha](https://usa.yamaha.com/products/musical_instruments/pianos/apps/smart_pianist/features.html)) | 없음 | 무료(하드웨어 번들) | **오디오→연주 가능한 악보** 콘셉트 검증 사례 | 코드 반주 수준이라 원곡 멜로디 재현 불가, 하드웨어 종속 |
| **The ONE Smart Piano** | 자사 LED 건반(MIDI) | **건반 LED 점등** + 떨어지는 노트, 대기 모드, A-B 반복 | 리듬게임, 점수 | 무료 티어 + 프리미엄 구독 ([theonemusic](https://theonemusic.com/blogs/knowledge/is-the-one-smart-piano-app-subscription-really-worth-it)) | 실제 건반 위 시각 가이드(향후 LED 스트립 연동 아이디어) | 하드웨어 필수, 중국 중심 콘텐츠 |
| **PianoRhythm** (웹) | MIDI, PC 키보드 | 3D 멀티플레이 방, 실시간 합주 ([app](https://app.pianorhythm.io/)) | 소셜, 채팅, 캐주얼 게임 | 무료(베타) | **웹 기반 실시간 멀티플레이 피아노** | 학습·판정 시스템 약함 |
| **Melodics** | **MIDI 전용**(키·드럼·패드) | 레슨형 리듬 트레이너 | 레벨, 스트릭, 일일 목표 | 무료 티어 + 구독 ([itechguides](https://www.itechguides.com/best/music-learning-apps/melodics/)) | 정밀한 MIDI 타이밍 피드백 | 피아노 레퍼토리가 얕음 |
| **ROLI Learn + AI Music Coach** (2026-02 발표) | ROLI Piano/Piano M + **Airwave 적외선 카메라** | 손 관절 27개를 90fps로 추적, 대화형 코칭 ([New Atlas](https://newatlas.com/music/roli-ai-music-coach-piano/)) | 코스 중심 | Learn £13/월(£70/년), Airwave £299 ([MusicTech](https://musictech.com/news/gear/roli-ai-music-coach-airwave-first-look/)) | 자세·운지 피드백이라는 새 축 | 고가 하드웨어 필수 |
| **mymusic5** (엠피에이지, 한국) | 마이크 | 사운드 인식으로 악보 자동 넘김, 계이름 가이드, **AI 음성 피드백**(2026-08), 악보 마켓 ([와우테일](https://wowtale.net/2026/08/21/263260/), [머니투데이](https://www.mt.co.kr/future/2026/03/02/2026030211350848855)) | 입문 50곡 코스 | 악보 판매 + 앱 | 국내 인기곡(지브리·OST) 큐레이션, 악보 유통망 | 리듬게임성 없음, 정밀 판정 없음 |
| *(인접)* **Klangio Piano2Notes / Songscription** | 오디오, YouTube 링크 | 오디오를 악보/MIDI/MusicXML로 변환 ([Klangio](https://klang.io/piano2notes/), [Songscription](https://www.songscription.ai/blog/best-ai-piano-transcription-software)) | 없음 | 구독/크레딧 | 채보 품질 기준점 | 연주 판정·게임 없음, YouTube 링크 입력의 법적 리스크 |

**관찰**
1. **입력**: "마이크 + MIDI" 이원화가 업계 표준이다. MIDI 전용 제품(Synthesia, Melodics, Playground)은 판정 정밀도를 강점으로 내세운다. 어쿠스틱 피아노 사용자를 놓치지 않으려면 2단계에 마이크 지원이 필요하다.
2. **UX 축**: 떨어지는 노트(Synthesia, ONE, Rocksmith+, Yousician)와 악보 스크롤(Simply, Skoove, Piano Marvel)로 나뉜다. **두 표기 사이 전환**(Yousician 3종 표기)이 초보에서 악보 독해로 넘어가는 다리 역할을 한다.
3. **콘텐츠 라이선스가 해자**다. 저작권 곡은 별도 상위 티어(Yousician Premium+)로 묶거나 기간 제한(Playground 2년)을 둔다.
4. **"내 곡 가져오기"는 반쪽만 해결**돼 있다. MIDI 가져오기(Synthesia), 오디오→코드 반주(Yamaha), 오디오→악보(Klangio)는 있지만, **오디오에서 난이도별 플레이 차트까지 이어지는 일관 흐름은 없다.**

---

## 2. 오픈소스

"활동"은 GitHub `pushed_at` 기준(2026-10-05 조회), 스타 수는 대략치.
라이선스 표기: **[허용]** permissive / **[주의]** LGPL·약한 카피레프트 / **[격리]** GPL·AGPL(코드 차용 금지, 별도 프로세스 또는 참고만) / **[NC]** 비상업.

### 2.1 떨어지는 노트 게임 / 플레이어

| 프로젝트 | 라이선스 | 스택 | 활동 | 재사용 포인트 |
|---|---|---|---|---|
| [Neothesia](https://github.com/PolyMeilex/Neothesia) | [격리] GPL-3.0 | Rust, wgpu | 2026-10, 1.6k★ | 플레이어롱·대기 모드·점수 UX, wgpu 노트 렌더링 기법 참고 |
| [PianoBooster](https://github.com/pianobooster/PianoBooster) | [격리] GPL-3.0+ | C++/Qt | 2024-06, 0.6k★ | **"Follow You" 모드**(연주자 속도에 반주 맞춤), 박자 앞섬/늦음 마커 |
| [Linthesia](https://github.com/linthesia/linthesia) | [격리] GPL-2.0 | C++ | 2025-04 | 고전 Synthesia 클론 구조 |
| [sightread](https://github.com/sightread/sightread) | [격리] GPL-3.0 | TS, React, Vite | 556★, **2026-03부터 비공개 개발 전환** | 웹 기반 피아노 학습 UX(떨어지는 노트·악보 모드), Web MIDI 연동 레퍼런스 |
| [MIDIano](https://github.com/Bewelge/MIDIano) | 라이선스 없음(=전권 유보) | JS, Canvas | 2021-08 | 웹 렌더링 아이디어만 참고, 코드 사용 불가 |
| [Piano-LED-Visualizer](https://github.com/onlaj/Piano-LED-Visualizer) | [허용] MIT | Python, Raspberry Pi | 2026-10, 0.8k★ | 실제 건반 위 LED 가이드 하드웨어 연동(향후 옵션) |

### 2.2 악보 렌더링 / 심볼릭 처리

| 프로젝트 | 라이선스 | 스택 | 활동 | 재사용 포인트 |
|---|---|---|---|---|
| [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay) | [허용] BSD-3 | TS, VexFlow 기반 | 2026-10, 2.0k★ | **MusicXML 렌더링 + 커서 API**로 악보 모드와 플레이 위치 동기화. 공식 오디오 플레이어는 후원자 전용([info](https://opensheetmusicdisplay.org/music-xml-audio-player/)) |
| [VexFlow](https://github.com/vexflow/vexflow) | [허용] MIT | TS | 2026-09 | 저수준 악보 그리기(커스텀 하이웨이 위 오선 오버레이) |
| [Verovio](https://github.com/rism-digital/verovio) | [주의] LGPL-3.0 | C++ → WASM/Python | 2026-10, 0.9k★ | MEI/MusicXML/Humdrum 렌더링, **timemap(음표↔시간) 출력**. 별도 모듈로 로드해 LGPL 준수 |
| [abcjs](https://github.com/paulrosen/abcjs) | [허용] MIT | JS | 2026-09, 2.4k★ | ABC 표기 렌더·재생(연습곡 저작용) |
| [music21](https://github.com/cuthbertLab/music21) | [허용] BSD-3 | Python | 2026-10, 2.6k★ | **화음 분석·축소(코어 노트 추출)**, 조성/박자 분석, MusicXML 입출력(서버측) |
| [@tonejs/midi](https://github.com/Tonejs/Midi) | [허용] MIT | TS | 2023-07(안정) | 브라우저에서 MIDI를 JSON으로 파싱해 차트 생성 |
| [mido](https://github.com/mido/mido) / [pretty_midi](https://github.com/craffel/pretty-midi) | [허용] MIT | Python | 2026-09 / 2026-02 | 서버측 MIDI 편집, 양자화, 트랙/손 분리 |

### 2.3 웹 오디오 / MIDI

| 프로젝트 | 라이선스 | 활동 | 재사용 포인트 |
|---|---|---|---|
| [Tone.js](https://github.com/Tonejs/Tone.js) | [허용] MIT | 2026-10, 14.8k★ | Transport(템포 변경/루프), Sampler, 반주 재생 |
| [webmidi.js](https://github.com/djipco/webmidi) | [허용] Apache-2.0 | 2026-10, 1.7k★ | Web MIDI 래퍼(이벤트, 장치 핫플러그) |
| [WebAudioFont](https://github.com/surikov/webaudiofont) | [격리] GPL-3.0 | 2026-09 | GM 음색 전체. **상용 클라이언트 번들에는 부적합** |
| [MIDI.js](https://github.com/mudcube/MIDI.js) | [허용] MIT | **아카이브됨** | 사용하지 않음(레거시) |
| Salamander Grand Piano 샘플 | CC BY 3.0 ([archive](https://archive.org/details/SalamanderGrandPianoV3)) | — | 무료 고품질 피아노 샘플. 출처 표기 필수 |

### 2.4 오디오 → MIDI 채보

| 프로젝트 | 라이선스 | 스택 | 활동 | 재사용 포인트 / 메모 |
|---|---|---|---|---|
| [Spotify basic-pitch](https://github.com/spotify/basic-pitch) | [허용] Apache-2.0 | Python, TF/CoreML/TFLite/ONNX | 2025-11, 5.7k★ | 악기 무관 경량 다성 모델, 피치벤드 지원. **"한 번에 악기 하나"일 때 가장 좋음**. 멜로디나 기타 악기 채보용 |
| [basic-pitch-ts](https://github.com/spotify/basic-pitch-ts) | [허용] Apache-2.0 | TS, tfjs (`@spotify/basic-pitch`) | 2023-05 | **브라우저 내 채보**(짧은 클립, 오프라인 처리). 서버 부하 없는 체험판 |
| [Magenta Onsets & Frames](https://github.com/magenta/magenta) / [magenta-js](https://github.com/magenta/magenta-js) | [허용] Apache-2.0 | TF / TS | magenta 본체 **아카이브됨**, js 2026-06 | 피아노 전용 원조 모델(MAESTRO onset F1 약 94.8%). 웹 데모 참고 |
| [MT3](https://github.com/magenta/mt3) | [허용] Apache-2.0 | JAX/T5X | 2026-09, 1.8k★ | 다악기 동시 채보(밴드 음원). 무겁고 학습 설정이 까다로움 |
| [ByteDance piano_transcription](https://github.com/bytedance/piano_transcription) (Kong et al.) | [허용] Apache-2.0(README) | PyTorch | **2025-12 아카이브** | **고해상도 피아노 채보 + 페달**, onset F1 96.72% ([arXiv 2010.01815](https://arxiv.org/pdf/2010.01815)) |
| [piano_transcription_inference](https://github.com/qiuqiangkong/piano_transcription_inference) | LICENSE 파일 미확인(확인 필요) | `pip install piano_transcription_inference` | 2025-01 | 위 모델의 추론 패키지(Zenodo 체크포인트). **솔로 피아노 음원에서 1순위** |
| [Omnizart](https://github.com/Music-and-Culture-Technology-Lab/omnizart) | [허용] MIT | Python/TF | 2026-05, 2.0k★ | 보컬 멜로디·코드·비트 채보(멜로디 라인 추출 보조) |
| [Pop2Piano](https://github.com/sweetcocoa/pop2piano) | **라이선스 파일 없음** | PyTorch, HF transformers 통합 | 2023-07 | **팝 음원을 피아노 커버로 직접 생성**(서울대 연구). YouTube 커버 데이터로 학습해 상용 사용은 불가로 간주. 연구 참고용 |

> 참고: 피아노 채보 SOTA는 MAESTRO 기준 note F1 약 97%(Transformer 계열) ([ISMIR 2023 hFT](https://archives.ismir.net/ismir2023/paper/000024.pdf)). **MAESTRO는 CC BY-NC-SA 4.0**([Magenta](https://magenta.tensorflow.org/maestro-wave2midi2wave))이므로, 이 데이터로 학습한 가중치(O&F, Kong, MT3 piano)를 상업적으로 쓰는 것은 법적 회색지대다. 법무 검토가 필요하다.

### 2.5 음원 분리

| 프로젝트 | 라이선스 | 활동 | 메모 |
|---|---|---|---|
| [Demucs](https://github.com/facebookresearch/demucs) (htdemucs) | [허용] MIT | 원 저장소 **아카이브(2024-04)**, 저자 포크 [adefossez/demucs](https://github.com/adefossez/demucs)에서 저속 유지보수 | 4스템 표준. `htdemucs_6s`에 piano 스템이 있으나 저자 스스로 **"piano source is not working great"**라고 밝힘 |
| [Spleeter](https://github.com/deezer/spleeter) | [허용] MIT | 2026-06, 28.5k★ | 5stems에 piano 포함, 빠르지만 품질은 구세대 |
| [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) / [MSST](https://github.com/ZFTurbo/Music-Source-Separation-Training) | [허용] MIT(코드) | 2026-10 / 2026-09 | **BS-RoFormer/MelBand-RoFormer** 등 최신 모델 실행기. 6스템 BS-RoFormer로 피아노 분리 가능. **가중치 라이선스는 모델별로 개별 확인** |

### 2.6 OMR (PDF/이미지 → MusicXML)

| 프로젝트 | 라이선스 | 활동 | 메모 |
|---|---|---|---|
| [Audiveris](https://github.com/Audiveris/audiveris) | [격리] AGPL-3.0 | 2026-10, 2.9k★ | 인쇄 악보 PDF에 가장 성숙한 OMR(Java). **격리된 서비스로 실행**하고 수정 시 소스 공개 |
| [oemer](https://github.com/BreezeWhite/oemer) | [허용] MIT | v0.1.7(2023) 이후 정체 | 휴대폰 사진 → MusicXML, GPU에서 3~5분 소요. 수기 악보 불가 |
| [homr](https://github.com/liebharc/homr) | [격리] AGPL-3.0 | 2026-10 | oemer 후속, 더 견고함. 셈여림·아티큘레이션은 제외하고 음높이·리듬에 집중 |

### 2.7 마이크 피치 인식

| 프로젝트 | 라이선스 | 메모 |
|---|---|---|
| [pitchy](https://github.com/ianprime0509/pitchy) | [허용] 0BSD | McLeod Pitch Method, **단음 전용**, 브라우저 경량 |
| [CREPE](https://github.com/marl/crepe) | [허용] MIT | 신경망 단음 피치(고정확), TF.js/ONNX로 포팅 가능 |
| [Essentia.js](https://github.com/MTG/essentia.js) / [Essentia](https://github.com/MTG/essentia) | [격리] AGPL-3.0 (**UPF 상용 라이선스 별도**, [UPF](https://www.upf.edu/web/mtg/tech-transfer/-/asset_publisher/pYHc0mUhUQ0G/content/technologies-essentia/maximized)) | 크로마, 온셋, 멜로디 추출 WASM. 상용 시 라이선스 구매 필요 |
| [aubio](https://github.com/aubio/aubio) | [격리] GPL-3.0 | 온셋/피치/템포(C). 서버측 별도 프로세스로만 사용 |

### 2.8 리듬게임 판정 레퍼런스 및 기타

| 프로젝트 | 라이선스 | 참고 포인트 |
|---|---|---|
| [osu!](https://github.com/ppy/osu) (lazer) | [허용] MIT(코드), 리소스는 별도 비상업 | 판정 테이블, **히트 에러 바**, 전역 오프셋 보정 UX, 정확도 가중치 |
| [StepMania](https://github.com/stepmania/stepmania) | [허용] MIT(소스) | 차트 포맷(.sm/.ssc), 타이밍 윈도우 설정 |
| [Etterna](https://github.com/etternagame/etterna) | [허용] MIT | Judge 1~9 스케일, **Wife3 연속 점수 곡선**(경계 근처 점수 단절 제거) |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | [허용] Unlicense | 도구 자체는 합법이나 **사용 방식이 법적 리스크**(3.5절) |
| [Beat This!](https://github.com/CPJKU/beat_this) | [허용] MIT(코드와 가중치) | 비트/다운비트 추적. **madmom 모델은 CC BY-NC-SA라 회피** ([madmom_models](https://github.com/CPJKU/madmom_models)) |
| [PDMX](https://github.com/pnlong/PDMX/) | PD/CC0 곡만 선별 | MuseScore 기반 **퍼블릭 도메인 MusicXML 25만 곡** ([arXiv](https://arxiv.org/abs/2409.10831)). 초기 카탈로그와 난이도 모델 학습 데이터 |

---

## 3. 핵심 기술 사실

### 3.1 Web MIDI 브라우저 지원 (2026-10)

| 환경 | 상태 | 비고 |
|---|---|---|
| Chrome / Edge / Opera (데스크톱), Chrome Android | 지원 | **Chrome 124~125부터 모든 MIDI 접근에 권한 프롬프트**(SysEx 외 일반 접근 포함) ([Chrome blog](https://developer.chrome.com/blog/web-midi-permission-prompt)). HTTPS 필수 |
| Firefox (Win/Mac/Linux) | 지원(108+) | 최초 접근 시 **사이트 권한 애드온** 설치 프롬프트(자동 생성) ([Bugzilla](https://bugzilla.mozilla.org/show_bug.cgi?id=1795025)) |
| Safari macOS | **미지원** | WebKit이 핑거프린팅 우려로 반대, 로드맵 없음 ([WebKit positions](https://github.com/WebKit/standards-positions)). 서드파티 확장([Safari-WebMIDI](https://github.com/triglav-modular/Safari-WebMIDI))만 존재 |
| iOS/iPadOS (모든 브라우저) | **미지원** | 모든 브라우저가 WebKit을 강제로 사용. EU는 BrowserEngineKit으로 대체 엔진을 허용했으나 보급은 미미. 우회책: [Web MIDI Browser](https://apps.apple.com/us/app/web-midi-browser/id953846217) 앱 또는 네이티브 래퍼 |

**대응**: 웹 MVP는 Chrome/Edge를 기준으로 하고, macOS Safari 사용자에게는 Chrome 또는 **Electron 데스크톱 앱**을 안내한다. Tauri는 macOS에서 WKWebView를 쓰므로 Web MIDI가 없다. Tauri를 택하면 [tauri-plugin-midi](https://github.com/specta-rs/tauri-plugin-midi)(midir 기반 WebMIDI 폴리필)가 필요하다. iOS는 Capacitor + CoreMIDI 플러그인 또는 네이티브 앱으로 대응한다.

### 3.2 지연(latency)과 보정

| 구간 | 전형값 | 근거 |
|---|---|---|
| USB MIDI 입력 | 약 1~3ms | [CME](https://www.cme-pro.com/the-truth-about-bluetooth-midi/) |
| **BLE MIDI 입력** | 연결 간격 7.5~15ms, 실측 **10~20ms + 지터** | [BLE-MIDI spec](https://www.hangar42.nl/wp-content/uploads/2017/10/BLE-MIDI-spec.pdf), [ResearchGate](https://www.researchgate.net/publication/335054972_Practical_Considerations_for_MIDI_over_Bluetooth_Low_Energy_as_a_Wireless_Interface) |
| 오디오 출력(유선, Web Audio) | `baseLatency + outputLatency`, 대개 10~40ms | [W3C Web Audio 1.1](https://www.w3.org/TR/webaudio-1.1/) |
| **블루투스 헤드폰(A2DP SBC/AAC)** | **150~300ms**. aptX LL 약 40ms, LE Audio LC3 약 20ms | [blaze4k 실측](https://github.com/laanhema/blaze4k/pull/73) |
| 화면 | 60Hz 1프레임 16.7ms + 디스플레이 처리 지연 | — |

**클럭 설계 원칙**
- `MIDIMessageEvent.timeStamp`는 `performance.now()`와 같은 클럭 도메인이다. 판정은 rAF 프레임 시각이 아니라 **이벤트 타임스탬프로** 한다(프레임 양자화 오차 제거).
- 반주 오디오의 마스터 클럭은 `AudioContext.currentTime`이다. 두 클럭은 `getOutputTimestamp()`의 `{contextTime, performanceTime}` 쌍으로 매핑한다(미지원 브라우저는 `outputLatency`로 근사).
- `songTimeAtInput = audioTime(evt.timeStamp) - audioOffset`. 이 값을 차트 노트 시각과 비교해 판정한다.
- 보정은 세 가지로 나눠 저장한다. (a) **오디오 오프셋**: 메트로놈을 따라 치는 탭 테스트의 중앙값, 이상치 제거. (b) **비주얼 오프셋**: 노트가 판정선에 닿는 순간을 보고 치는 osu!식 전역 오프셋. (c) **입력 장치 프로필**: USB와 BLE 구분, 장치명 단위로 저장.
- 사용자가 치는 소리는 디지털 피아노 자체 스피커에서 바로 나오므로 지연이 없다. **앱이 재생하는 반주나 앱 신스 음에만 출력 지연 보정**이 필요하다. BT 헤드폰이 감지되면 경고를 띄우고 보정 마법사를 실행한다.

### 3.3 판정 윈도우(±ms, 판정 중심 기준 편측 값)

| 게임 | 최상 | 2단계 | 3단계 | 4단계 | 미스 경계 | 출처 |
|---|---|---|---|---|---|---|
| osu!mania (OD 8 예) | PERFECT ±16 | GREAT ±40 (64−3·OD) | GOOD ±73 | OK ±103 / MEH ±127 | ±164 (188−3·OD) | [osu-wiki](https://github.com/ppy/osu-wiki/blob/master/wiki/Gameplay/Judgement/osu!mania/en.md) |
| Etterna J4 | Marvelous ±22.5 | Perfect ±45 | Great ±90 | Good ±135 | Boo ±180 | [etterna judge.rs](https://docs.rs/etterna/latest/src/etterna/judge.rs.html) |
| DDR | Marvelous ±16.7 | Perfect ±33 | Great ±92 | Good ±142 | — | [StepMania forum](https://www.stepmania.com/forums/general-questions/show/586) |
| **제안(피아노 기본)** | **Perfect ±35** | **Great ±70** | **Good ±120** | — | **Miss > ±180** | 아래 근거 |

**피아노 특화 규칙(제안)**
- **화음**: 숙련자도 멜로디 음이 약 30ms 먼저 울린다(멜로디 리드, [Goebl 2001](https://pubmed.ncbi.nlm.nih.gov/11508980)). 따라서 화음은 구성음마다 판정하되, **구성음 간 시차가 60~80ms 이내면 "화음 성공"**으로 묶고 콤보를 유지한다.
- **지속음과 릴리즈**: osu!mania처럼 릴리즈를 엄격히 판정하면 피아노 실연과 맞지 않는다(페달, 레가토). 노트 길이의 50% 이상 유지 여부만 보너스로 반영하고 기본 판정에는 넣지 않는다.
- **오답 키**: 기대하지 않은 음은 콤보를 끊지 않고 "잡음표" 카운트와 정확도 감점으로만 처리한다(초보 이탈 방지). 숙련 모드에서는 콤보를 끊는다.
- **난이도 스케일**: Etterna Judge처럼 배율을 둔다. 학습 모드 ×1.5~2, 하드 ×0.75. BLE 입력이면 자동으로 +10ms 여유를 준다.
- **점수**: 판정별 가중치(1.0/0.7/0.4/0)로 정확도를 계산한다. Etterna Wife3처럼 **연속 곡선**을 쓰면 경계 근처의 불공정감이 줄어든다. 등급은 S≥95, A≥90, B≥80, C≥70%처럼 조정 가능하게 둔다.

### 3.4 마이크 다성 인식의 타당성

- **단음**(멜로디 한 줄): YIN/MPM(pitchy)이나 CREPE로 충분히 실용적이다. 지연의 하한은 분석 윈도우 크기다(예: 2048샘플 @48kHz ≈ 43ms).
- **다성 오프라인**: 깨끗한 녹음에서 onset F1이 95~97% 수준이다(Onsets&Frames 94.8%, Kong 96.7%, Transformer 약 97%). 업로드 음원 채보에는 충분하다.
- **다성 실시간**: 스트리밍 모델은 **64~380ms 지연, F1 90~93%** 수준이다([arXiv 2509.07586](https://arxiv.org/pdf/2509.07586), [arXiv 2503.01362](https://arxiv.org/pdf/2503.01362)). 모바일 실시간 모델도 있다([Mobile-AMT](https://eurasip.org/Proceedings/Eusipco/Eusipco2024/pdfs/0000036.pdf)). 실제 방 환경(잔향, 소음, 조율 상태)에서는 더 떨어진다. 특히 **저음역 블록 코드와 배음이 겹치는 음**이 약점이다.
- **결론**: 블라인드 채보 대신 **악보를 아는 상태에서 검증하는 방식**(score-informed)을 쓴다. 기대 음표 집합이 해당 시간창에 존재하는지만 확인하는 방식이다([score following + RT transcription](https://arxiv.org/html/2505.05078v1)). 마이크 모드에서는 판정을 Good급(±120ms 이상)으로 완화하고 고정 지연을 보정한다. 오답 키 판정은 "누락 여부" 중심으로 축소한다. **MVP는 MIDI 전용으로 하고 마이크는 2단계**로 미룬다.

### 3.5 YouTube 오디오 추출: 법적·약관 리스크

- **YouTube 약관**은 서비스가 명시적으로 허가한 경우(Premium 오프라인 등)가 아니면 콘텐츠 다운로드를 금지한다([TLDRLegal 요약](https://www.tldrlegal.com/license/youtube-terms-of-service)). yt-dlp(Unlicense)는 중립적 도구지만, **서비스가 서버에서 대신 받는 구조는 약관 위반이자 저작권 침해 방조 리스크**다.
- **기술적 불안정**: 2025~26년 PO Token과 SABR 스트리밍 도입으로 서버측 다운로드가 자주 깨진다([yt-dlp #16082](https://github.com/yt-dlp/yt-dlp/issues/16082)). 데이터센터 IP 차단 이슈도 있다.
- **채보와 편곡은 2차적저작물**이다(저작권법 제5조, 제22조). 생성 차트를 **공유하거나 배포하면 권리자 허락이 필요**하다. 출판사도 기존 판매 편곡과 유사한 편곡 허가는 거절할 수 있다([Hal Leonard FAQ](https://halleonard.com/permissions/faq.jsp)).
- **권장 설계**
  1. **사용자 업로드 오디오**(본인이 보유한 파일)를 받는다. 권리 확인 체크박스를 두고, 생성 차트는 **기본 비공개·개인 학습용**으로 한다. 원본 오디오는 처리 후 단기간 내 삭제한다.
  2. YouTube 링크는 MVP에서 **다운로드 기능 없이** 제공한다. 메타데이터 참조와 IFrame 임베드 재생까지만 허용하고, 차트는 사용자가 올린 오디오나 MIDI로 만든다.
  3. 공개 카탈로그는 **퍼블릭 도메인**(PDMX, 클래식)과 **라이선스 곡**으로 구성한다. 제휴 후보는 Hal Leonard/[ArrangeMe](https://www.arrangeme.com/) 같은 해외 퍼블리셔와 mymusic5 같은 국내 악보 플랫폼이다.
  4. 신고 시 삭제(notice-and-takedown) 절차와 반복 침해자 정책을 마련한다.

---

## 4. MVP 권장 스택 (웹 우선)

| 레이어 | 선택 | 이유 | 대안/비고 |
|---|---|---|---|
| 언어/빌드 | **TypeScript + Vite** (UI 셸은 React) | 생태계, 빠른 HMR, OSMD·Tone.js·basic-pitch-ts 모두 TS | Svelte |
| 게임 렌더링 | **PixiJS v8**(WebGL, WebGPU 옵션, MIT) | 수천 개 노트 스프라이트를 60~120fps로, 파티클과 이펙트 | 프로토타입은 Canvas2D, 3D 연출은 Three.js |
| 입력 | **Web MIDI API 직접 사용**(+ webmidi.js 선택) | 타임스탬프 직접 활용, 장치 핫플러그 | PC 키보드 폴백, 2단계에 마이크 |
| 오디오 | **Tone.js** Transport와 Sampler, Salamander 샘플(CC BY) | 템포 감속, 구간 루프, 메트로놈, 반주 | WebAudioFont는 GPL이라 제외 |
| 차트 포맷 | 자체 JSON(`{t_ms, tick, midi, dur, hand, finger, vel, section, layer}`) | MIDI(@tonejs/midi)와 MusicXML(OSMD/music21) 공통 중간 표현. `layer`로 난이도 단계 표현 | StepMania .ssc 구조 참고 |
| 악보 모드 | **OSMD**(BSD-3) + 커서 | MusicXML을 그대로 렌더링, 플레이 위치 동기화 | Verovio(LGPL, timemap) |
| 백엔드 API | **Python FastAPI** + Redis 큐(Arq/RQ/Celery) + **GPU 워커** | 음향 처리와 ML 생태계가 Python | 결과물은 S3 호환 스토리지 |
| 채보 파이프라인 | ffmpeg 정규화 → (솔로 피아노가 아니면) **htdemucs 또는 BS-RoFormer** 분리 → 피아노는 **Kong 추론기**, 멜로디/기타는 **basic-pitch**, 밴드는 MT3 → **Beat This!** 비트/마디 → music21/pretty_midi로 양자화, 손 분리, 난이도 3단계 축소 → 차트 + MusicXML | 각 단계 모두 permissive 라이선스(가중치의 데이터 라이선스는 별도 검토) | 짧은 클립은 브라우저 basic-pitch-ts로 즉시 미리보기 |
| OMR | **oemer**(MIT)로 MVP → 품질이 부족하면 **Audiveris를 격리 컨테이너**(AGPL)로 | PDF/사진을 MusicXML로 변환 후 OSMD 렌더링, 사용자 교정 UI | homr(AGPL) |
| 데스크톱 | **Electron** 우선 | Chromium 내장이라 **macOS에서도 Web MIDI가 그대로 동작**. 권한 핸들러만 설정 | Tauri는 경량이지만 macOS는 tauri-plugin-midi 필요 |
| 모바일 | 3단계에 Capacitor + 네이티브 MIDI 플러그인(iOS CoreMIDI, Android MidiManager) | iOS WebKit은 Web MIDI가 없음 | React Native/네이티브 |
| AI 코치 | 서버측 LLM에 **노트 단위 판정 로그**(마디, 손, 평균 early/late ms, 오답 패턴) 요약을 전달 | 근거 있는 피드백("12~16마디 왼손 평균 +42ms 늦음") | 음성 TTS 피드백은 2단계 |

**근거 요약**
- 웹 우선이면 설치 마찰이 가장 적다. 데스크톱 Chrome/Edge 사용자는 즉시 MIDI로 플레이할 수 있다. Safari와 iOS 공백은 Electron과 추후 네이티브로 메운다.
- 무거운 처리(분리, 채보, OMR)는 서버 GPU에서 비동기로 돌린다. 클라이언트는 **실시간 판정과 렌더링에만 집중**한다(지연 민감 경로는 모두 로컬).
- 라이선스 위생을 위해 클라이언트 번들에는 MIT/BSD/Apache만 넣는다. GPL과 AGPL은 서버측 격리 프로세스나 참고 용도로만 쓴다.

---

## 5. 차별화 기회

1. **"아무 곡 → 수 분 내 플레이 가능한 차트(난이도 3단계)"**: 분리, 채보, 비트, 난이도 축소를 하나의 흐름으로 묶는다. Yamaha는 코드 반주보, Klangio/Songscription은 악보까지만 만든다. 우리는 **바로 게임으로** 이어진다.
2. **적응형 편곡**: 화음을 근음과 멜로디 같은 코어 노트로 축소했다가, 구간 정확도가 90%를 넘으면 원래 음을 단계적으로 복원한다(`layer` 기반). 기존 앱은 고정 편곡(easy/hard)만 제공한다.
3. **내 악보 가져오기 → 즉시 추적**: MusicXML/MIDI/PDF OMR을 지원한다. OMR 오류는 **플레이 중 "여기 틀렸어요" 탭으로 교정**하고, 교정 데이터는 품질 개선에 다시 쓴다.
4. **리듬게임급 판정의 투명성**: ms 단위 히트 에러 바, early/late 통계, 장치별 보정을 제공한다. 학습 앱의 모호한 "좋아요"와 대비되며, osu!/리듬게임 유저층을 피아노로 끌어올 수 있다.
5. **학습 모드의 게임화**: 구간 분할, 한 손 연습, 템포 50→100% 단계 상승을 퀘스트와 XP로 연결한다(Roland "One Week Master"와 Yousician 주간 챌린지 결합). 연속 학습(streak)은 "보호권"을 둬 부담을 줄인다.
6. **저렴한 교사 대시보드와 한국 학원 시장**: Piano Marvel 교사 10석이 $765/년인 데 비해 무료 또는 저가 교사 티어를 둔다. 숙제 배정, 판정 로그 리포트, 학부모 공유를 제공해 B2B2C 채널로 활용한다.
7. **하드웨어 없는 AI 코치**: ROLI는 £299 카메라가 필요하다. 우리는 **판정 로그 기반 구조화 코칭**(약점 마디 자동 추출 → 맞춤 연습 루프 생성)을 소프트웨어만으로 제공한다. 웹캠 손 추적은 옵션 실험으로 둔다.
8. **웹 소셜과 비동기 대결**: 고스트 리플레이(같은 차트의 타인 판정 타임라인)와 주간 랭킹을 둔다. PianoRhythm의 소셜성과 리듬게임 랭킹 문화를 결합한다.

---

## 6. 열린 검증 과제

- MAESTRO(NC) 학습 가중치와 BS-RoFormer 커뮤니티 가중치의 상업적 사용 가능 여부(법무 검토). 필요하면 자체 재학습이나 상용 라이선스를 확보한다.
- piano_transcription_inference의 LICENSE 원문 확인. Kong 모델과 basic-pitch의 피아노 정확도·속도 사내 벤치(CPU와 GPU 비교).
- oemer, homr, Audiveris의 실제 국내 악보(PDF, 사진) OMR 정확도 비교.
- BLE MIDI 지터를 실측하고(주요 디지털 피아노 3종), 판정 윈도우를 플레이테스트로 확정한다.
- 타깃 사용자 중 Safari와 iOS 비중에 따라 Electron/네이티브 우선순위를 정한다.
