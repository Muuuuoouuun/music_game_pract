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
| `src/audio` | 간단한 신스·메트로놈 |
| `src/state` | 설정·최고 점수·가져온 곡 (localStorage) |

## 알려진 한계

- YouTube 링크·오디오 변환은 서버 파이프라인(band2sheet) 연결 전이라 비활성화.
- 악보의 반복 기호(도돌이표, D.C.)는 펼치지 않고 쓰인 대로 한 번 연주.
- MIDI 파일에서 만든 악보는 16분음표 격자로 맞춰져 셋잇단음표가 근사됨.
- 실제 MIDI 하드웨어로는 아직 테스트하지 않음 (가짜 MIDIAccess로 자동 테스트).
