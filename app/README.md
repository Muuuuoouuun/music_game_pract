# KeyStage 앱 (MVP)

실제 전자피아노·MIDI 건반으로 하는 피아노 리듬게임. 시안 D(`../mockups/d-neon-score.html`)를 실제 앱으로 옮긴 것입니다.

## 실행

```bash
cd app
npm install
npm run dev        # http://localhost:5173 을 Chrome 또는 Edge로 열기
```

- 전자피아노를 USB 케이블로 컴퓨터에 연결하고(피아노의 "USB to Host" 단자), 처음 뜨는 "MIDI 기기 허용" 창에서 허용하세요.
- 상단 **건반 연결** 탭에서 기기 인식, 입력 모니터(88건반·세기·페달), 지연 보정을 확인할 수 있습니다.
- 건반이 없으면 PC 키보드(`A S D F G H J K L ;` = 도~미, `W E T Y U O P` = 검은건반, `Z~M` = 왼손 옥타브)나 화면 건반으로도 됩니다.

| 브라우저 | MIDI |
|---|---|
| Chrome / Edge (Windows, macOS) | 지원 |
| Firefox 108+ | 사이트 권한 허용 후 지원 |
| Safari, iPhone/iPad의 모든 브라우저 | 미지원 (WebKit에 Web MIDI 없음) |

MIDI는 보안 컨텍스트(https 또는 localhost)에서만 동작합니다. claude.ai 미리보기 링크 안에서는 막혀 있습니다.

## 명령

```bash
npm test           # Vitest (엔진, MIDI, 가져오기, UI 로직)
npm run typecheck
npm run build      # dist/ — 정적 호스팅(https) 가능
```

## 구조

| 경로 | 내용 |
|---|---|
| `src/core` | 차트 타입, 판정 엔진 `Session` (DOM 없음) |
| `src/input` | Web MIDI(`MidiInput`), PC 키보드·화면 건반을 합치는 `InputHub` |
| `src/import` | MusicXML(.musicxml/.mxl)·MIDI → 차트, 차트 → MusicXML |
| `src/songs` | 기본 곡 (퍼블릭 도메인 MusicXML) |
| `src/render` | 원근 하이웨이(Canvas), 악보(OpenSheetMusicDisplay) |
| `src/ui` | 화면별 모듈, 시계, AI 코치 문구, 지연 보정 |
| `src/audio` | 간단한 신스·메트로놈, 녹음 재생(`AudioTrack`) |
| `src/transcribe` | 오디오 → 음표(basic-pitch, TF.js) → 템포·첫 박 → 차트 |
| `src/state` | 설정·최고 점수·가져온 곡 (localStorage) |

## 오디오 채보 (새 곡 → 오디오)

피아노(또는 한 악기) 녹음 mp3·wav·m4a·ogg를 올리면 브라우저 안에서 [Spotify basic-pitch](https://github.com/spotify/basic-pitch-ts)(Apache-2.0, TF.js)로 음표를 뽑고, 온셋 자기상관으로 BPM(40–220, 70–160 선호)과 첫 박을 추정해 차트를 만듭니다. 녹음은 IndexedDB에 함께 저장되어 플레이 화면의 **더보기 → 원곡 소리**로 연주에 맞춰 재생됩니다(템포 50/75%면 녹음도 느려짐, 대기 모드에서는 멈춤).

- 모델 파일은 `npm run dev/build/test` 전에 `scripts/copy-model.mjs`가 `node_modules`에서 `public/basic-pitch/`로 복사합니다(git 제외). TF.js는 동적 import라 첫 변환 때만 내려받습니다.
- WebGL이 없으면 CPU 백엔드로 떨어집니다(훨씬 느림). 10분 초과 파일은 거부, 4분 초과는 경고합니다.
- 리뷰 카드에서 BPM·첫 박·박자를 고치고(×½ ×2, 탭 템포, ±1박) **원곡 미리듣기**로 확인한 뒤 곡 목록에 추가하거나 `#edit/<id>` 편집기로 넘어갑니다.
- 브라우저 e2e: `npx vite --port 5202` 후 `node scripts/e2e-transcribe.mjs` (Playwright 경로는 `PLAYWRIGHT_PATH`, `CHROME_PATH`).

## 알려진 한계

- YouTube 링크 변환은 로컬 변환 워커가 없어 비활성화.
- 오디오 채보는 솔로 악기 녹음 기준이에요. 밴드·반주가 섞인 음원은 basic-pitch의 다악기 F1이 0.4대라 편집기 손질이 많이 필요하고, 루바토가 심하면 마디선이 어긋날 수 있어요(판정은 실제 온셋 시각 기준이라 연주 자체는 가능). 템포가 2배/절반으로 잡히면 ×½ ×2 버튼으로 고치세요.
- 악보의 반복 기호(도돌이표, D.C.)는 펼치지 않고 쓰인 대로 한 번 연주.
- MIDI 파일에서 만든 악보는 16분음표 격자로 맞춰져 셋잇단음표가 근사됨.
- 실제 MIDI 하드웨어로는 아직 테스트하지 않음 (가짜 MIDIAccess로 자동 테스트).
