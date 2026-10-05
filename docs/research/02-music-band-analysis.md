# 02. Music_band (band2sheet) 분석: 리듬게임에 재사용할 수 있는 것

- 조사일: 2026-10-05 · 대상: `Muuuuoouuun/Music_band` (shallow clone, 브랜치마다 커밋 1개) · 원본 repo는 수정하지 않음
- **라인 번호 기준**: 따로 표시가 없으면 기본 브랜치 `claude/youtube-audio-to-sheet-music-zrwo2c`의 `band2sheet/*.py`입니다.
  최신 통합 브랜치 `festive-mayer`에서는 같은 파일이 `apps/band2sheet/band2sheet/*.py`에 있습니다. default의 Python 파일 27개 중 21개는 내용이 같고, 다른 6개는 `transcribe.py`(+7줄), `pipeline.py`(+9줄), `audio_io.py`, `cli.py`, `app/*`뿐입니다.

## TL;DR

1. band2sheet는 **"오디오/YouTube → 악기별 분리 → 채보 → 박·마디·키 → MusicXML/MIDI/JSON"** 흐름이 끝까지 동작하는 Python 패키지입니다. 기능 범위로는 게임의 "audio → chart" 백엔드와 거의 겹칩니다.
2. 가장 완성도 높은 브랜치는 `claude/festive-mayer-6eu9mh`입니다. 나머지 브랜치를 모두 합친 상위 집합이고, URL job API, 구간 다운로드, pYIN 가속, 실패에 강한 엔진 처리가 들어 있습니다.
3. 그대로 가져다 쓸 수 있는 핵심 모듈: `audio_io`(yt-dlp+ffmpeg), `separate`(Demucs/RoFormer), `transcribe`(**ByteDance piano_hr**, Basic Pitch, CREPE), `rhythm`(Beat This!, 템포 2배 오류 보정, 박자표 추정), `project.TimeMap`(초↔박), `score.Grid`(셋잇단을 포함한 양자화), `importer`(MIDI/MusicXML 입력).
4. 게임 차트에 필요한데 **없는 것**: 음표 단위 ms 차트 export, 음표마다 손(L/R) 지정(지금은 악보를 그릴 때만 손을 나눔), 난이도 축소, 건반 범위(lane)에 맞추기, 싱크 오프셋/캘리브레이션, 음표 id·신뢰도, PDF OMR, score-following.
5. 가장 큰 위험은 **밴드 믹스에서 피아노를 채보할 때의 품질**입니다. Demucs의 piano stem은 실험 단계라 블리딩이 큽니다. 또 하나는 **YouTube 다운로드와 저작권**입니다. 첫 타깃은 "솔로 피아노 커버 영상"(분리를 건너뛰고 piano_hr 사용)으로 잡는 것을 권장합니다.

---

## 1. 레포 개요와 브랜치 비교

| 브랜치 | 최종 커밋 (UTC) | 구조 | 내용 | Py LOC / test LOC |
|---|---|---|---|---|
| `claude/youtube-audio-to-sheet-music-zrwo2c` (default, checkout됨) | 66af818, 10-05 04:30 | 루트에 `band2sheet/` | band2sheet 본체 + **MIDI/MusicXML import**, 곡 나누기(`segment.py`), 박자표 추정, 조옮김 재생/MR(`playback.py`), 악보 소리(`synth.py`). YouTube URL은 **CLI 전용** | 7,042 / 1,832 |
| `claude/compassionate-darwin-z4jsjz` | 26d414c, 10-04 21:09 | 루트 | 무반주 노래 분석(`harmonize.py`), 내 영상 후보정(`remix.py`, `vocalfx.py`, `backing.py`), 구간만 받기. `importer/segment/playback`은 **없음** | 7,711 / 1,703 |
| `claude/funny-bardeen-p9viq0` | e8bdf36, 10-03 16:40 | 루트 + `air-choir/` | 예전 band2sheet(`view.py`/`views.js` 없음) + AirChoir Phase 0–2 (손동작 합창, 브라우저) | 4,847 / 814 |
| `codex/two-apps` | 154cc72, 10-04 10:49 | `apps/band2sheet`, `apps/airchoir` | 두 앱 모노레포로 재배치, URL 받기·fetch-only. `importer/segment` **없음**. AirChoir 집중 화면/녹화 | 5,930 / 1,396 |
| **`claude/festive-mayer-6eu9mh`** | ccf0487, 10-05 10:48 | `apps/…` | **전체 통합본**(`docs/INTEGRATION.md`): default + compassionate + two-apps + AirChoir. 추가: `fastviterbi.py`(pYIN 5.6배 빠름), `sound.py`, `MissingEngine` 폴백, `POST /api/jobs/url` | **10,050 / 3,045** |

- default ↔ festive diffstat: 144 files, +23,295/−1,094 (대부분 AirChoir와 remix 계열). 채보 코어는 사실상 같습니다.
- **결론**: 참조 기준은 `festive-mayer`의 `apps/band2sheet/`입니다. 게임에 필요한 코어(분리·채보·리듬·import)는 default와 같으므로 어느 쪽에서 가져와도 됩니다. AirChoir(MediaPipe 손동작과 WebAudio 합창)는 게임과 관련이 적습니다. 다만 `apps/airchoir/src/audio.js:366-370`의 `baseLatency + outputLatency` 지연 계산은 참고할 만합니다.

## 2. 파이프라인 end-to-end

```
YouTube URL / 파일 / 스템 ZIP / MIDI·MusicXML
  ├─(symbolic)→ importer.import_symbolic ─────────────────────────────┐
  ① audio_io.prepare_input  : yt-dlp(bestaudio) → ffmpeg → mix.wav 44.1k stereo
  ② separate.separate_detailed : [BS-RoFormer 보컬] → Demucs htdemucs_6s → [Karaoke 메인/코러스] → [DrumSep 6조각]
  ②' cleanup.SeparationAnalyzer : 스템별 연주 구간·블리딩 dB
  ③ transcribe.transcribe_stem : piano=piano_hr | vocals/bass=CREPE(pYIN) | guitar/keys=Basic Pitch | drums
  ③' pipeline.clean_notes : 블리딩·옥타브 유령음·unstruck 음 제거
  ④ (옵션) lyrics : faster-whisper/WhisperX
  ⑤ rhythm : Beat This!/librosa 비트 → 템포 2배/절반 보정 → 박자표·downbeat → 키(KS)·전조
  └→ Project(project.json) ─→ ⑥ render: score.Grid 양자화 → music21 MusicXML·PDF, pretty_midi MIDI, 코드표/ChordPro
                            └→ view.build_view → 앱용 JSON (마디 시간·코드·섹션·음표)
```

| 단계 | 구현 (path:line) | 도구/엔진 | 메모 |
|---|---|---|---|
| YouTube 다운로드 | `audio_io.py:29` `download_youtube` (default); festive `audio_io.py:138` `download_audio`, `:239` `fetch`, `:52` `_ytdlp_opts` | **yt-dlp** Python API, `bestaudio/best`, `FFmpegExtractAudio→wav` | festive는 `download_ranges`로 **구간만** 받고(`:63-66`) cookies와 progress hook을 지원하며, 실패하면 전체 다운로드로 재시도 |
| 전처리 | `audio_io.py:60` `to_wav` | **ffmpeg** subprocess `-ac 2 -ar 44100 pcm_s16le` (+`-ss/-t`) | 정규화·리샘플은 엔진별로 따로(librosa load) |
| 분리 | `separate.py:143` `separate_detailed`, `:66` `separate` (Demucs `apply_model`, `shifts`), `:110` `run_separator` | Demucs v4 `htdemucs_6s`(기본), `htdemucs`(fast); audio-separator: BS-RoFormer / Mel-RoFormer Karaoke / MDX23C DrumSep (`:37-49`) | 품질 프리셋 `QUALITY` (`:42`). 모델이 없으면 그 단계만 건너뜀 |
| 분리 정리 | `cleanup.py:104` `SeparationAnalyzer`, `:180` `verify_notes`, `:228` `remove_ghosts`, `:274` `remove_unstruck`, `:311` `remove_harmonic_ghosts` | numpy STFT | 합성 곡 기준 피아노 F1 0.54→0.94 (README) |
| 채보 | `transcribe.py:499` `transcribe_stem`, `:487` `resolve_engine`, `:67` `piano_hr_notes`, `:37` `basic_pitch_notes`, `:126` `notes_from_f0`, `:102` `crepe_f0` | **piano-transcription-inference**(ByteDance HR, 페달 포함), **basic-pitch**, **torchcrepe**, librosa pYIN | `piano`는 `piano_hr`, 설치돼 있지 않으면 Basic Pitch (`:492-493`) |
| 비트/템포 | `rhythm.py:52` `track_beats`, `:40` `beat_this_beats`, `:198` `fix_tempo_octave`, `:292` `estimate_meter`, `:91` `estimate_downbeat` | **Beat This!**(CPJKU) 또는 librosa `beat_track` | 템포 2배 오류를 킥·스네어와 보컬 음절 간격으로 바로잡음 |
| 양자화 | `score.py:33` `Grid` (`:52` `beat`, `:57` `with_triplets`, `:87` `for_project`의 phase 보정), `score.py:112/130` `mono_events/poly_events`, `rhythm.py:147` `quantize` | 자체 구현 | 박마다 16분과 셋잇단 중 더 맞는 쪽을 자동 선택, 비트 위상 오차 ±0.2박 보정 |
| 키 | `theory.py:185` `detect_key` (Krumhansl-Kessler), `:243` `key_segments`, `pipeline.py:220` `detect_modulations` | 자체 구현 | 마디별 전조 탐지 |
| 손 나누기 | `notation.py:207` `split_hands` | 자체 구현(비용 최소화 + 손 중심 이동) | **악보를 그릴 때 Event에만** 적용되고 Note에는 저장되지 않음 |
| 구조/곡 분할 | `sections.py:118` `detect_sections`, `segment.py:140` `find_songs` | 자체 구현 | Intro/Verse/Chorus…를 learn mode 섹션에 재사용할 수 있음 |
| 출력 | `pipeline.py:363` `render`, `:684` `write_midi`, `:587` `export_pdf`(MuseScore→Verovio), `:760/807` ChordPro/코드표, `project.py:99` `Project.save`, `view.py:136` `build_view` | music21, pretty_midi, verovio+cairosvg | MusicXML, MIDI(악기별+all), PDF, txt, ChordPro, project.json, view JSON |
| Web | `app/server.py:77` `create_app` (FastAPI), `app/jobs.py` (ThreadPool job queue); festive `server.py:205` `POST /api/jobs/url`, `:213` `/analyze` | FastAPI + uvicorn, vanilla JS + OSMD | `GET /api/jobs/{id}/view`, `PUT /notes/{track}`(음표 편집), `GET /project` |

핵심 코드 발췌:

```python
# transcribe.py:487-496 — 엔진 자동 선택
if spec.stem == "piano":
    return "piano_hr" if available("piano_hr") else "basic_pitch"
if spec.mono:
    return "crepe" if available("crepe") else "pyin"
return "basic_pitch"

# pipeline.py:173-192 — 비트: 모델이 있으면 믹스 전체로, 없으면 드럼 스템으로 → 2배/절반 보정 → 박자표
beat_src = mix_path if use_model or "drums" not in tracks else Path(stem_paths["drums"])
beat_info = rhythm.track_beats(beat_src, opts.bpm, opts.beat_engine, opts.device, log)
fixed, how = rhythm.fix_tempo_octave(beats, {k: t.notes for k, t in tracks.items()})
```

## 3. 데이터 모델

```python
# project.py:20-46
@dataclass
class Note:
    start: float      # 초 (원본 오디오 기준, 양자화 전)
    end: float        # 초
    pitch: int        # MIDI (드럼은 GM 드럼 번호)
    velocity: int = 80
@dataclass
class Track:
    name: str                      # 스템 이름 = "악기" (vocals, piano, bass, guitar, other, drums …)
    notes: list[Note]; lyrics: list[Word]; pedals: list[tuple[float, float]]; engine: str
# project.py:49 Project: title, source, beat_times[s], key, time_signature, downbeat(비트 index),
#   tracks{name: Track}, key_changes[(beat, Key)], chords, separation{…}, engines{…}
# project.py:162 TimeMap: to_beats(t) / to_seconds(b) — beat_times 선형보간, 템포 흔들림 흡수
```

`project.json` (`project.py:99-129`) 예:

```json
{"version":1,"title":"…","beat_times":[0.512,1.118,…],"key":{"tonic":7,"mode":"major","fifths":1},
 "time_signature":"4/4","downbeat":1,"key_changes":[{"beat":128.0,"key":{…}}],
 "tracks":{"piano":{"notes":[[1.1203,1.6011,67,84],…],"pedals":[[1.0,3.2]],"engine":"piano_hr"}}}
```

- 악보 단계의 중간 표현은 `score.py:22` `Event(offset, dur, pitches[], velocity, lyric, sources[])`입니다(4분음표 단위, 화음 묶음).
- 앱용 `view.build_view`(`view.py:218-239`)는 `measures`(마디 시작 초), `bars[{start,end,chords,lyrics}]`, `sections`, `tracks{notes:[[s,e,pitch,vel]]}`, `beat_times`를 반환합니다. **우리 차트의 원형으로 가장 가깝습니다.**
- 없는 필드: 음표 id, hand/staff, voice, finger, confidence/onset 확률, pitch bend. "악기"는 Track key로만 표현됩니다.

## 4. 의존성, 라이선스, 런타임, 테스트

`pyproject.toml`: 기본 `numpy, scipy, soundfile, librosa>=0.10, music21>=9, pretty_midi, yt-dlp`, extras `ml=[torch, demucs>=4, basic-pitch]`, `detail=[audio-separator, torchcrepe, piano-transcription-inference, beat-this]`, `lyrics=[faster-whisper]`, `app=[fastapi, uvicorn, python-multipart]`, `pdf=[verovio, cairosvg, pypdf]`.

| 의존성 | 용도 | 라이선스 (코드 / 가중치) |
|---|---|---|
| yt-dlp | YouTube 다운로드 | Unlicense |
| ffmpeg (외부 바이너리, **필수**) | 디코딩/변환, rubberband 피치시프트 | LGPL/GPL(빌드에 따라 다름. rubberband 필터는 GPL 빌드) |
| Demucs v4 | 6-stem 분리 | MIT / MIT |
| audio-separator + UVR 모델 | RoFormer, Karaoke, DrumSep | MIT / **커뮤니티 가중치, 라이선스 불명확** |
| basic-pitch | 다성 채보 | Apache-2.0 (패키지에 모델 포함) |
| piano-transcription-inference | 피아노 채보 + 페달 | MIT(추론 패키지) / ByteDance 원 repo Apache-2.0. 체크포인트 조건은 확인 필요 |
| torchcrepe | 단선율 f0 | MIT |
| beat-this | 비트·다운비트 | MIT(코드). 체크포인트 조건은 확인 필요 |
| librosa / music21 / pretty_midi | DSP / 악보 / MIDI | ISC / BSD-3 / MIT |
| faster-whisper | 가사 | MIT |
| verovio, cairosvg | PDF 조판 | **LGPL-3.0** |
| OSMD (vendored JS) | 브라우저 악보 표시 | BSD-3 |
| FastAPI / uvicorn | 서버 | MIT / BSD-3 |

- **band2sheet repo 자체에 LICENSE 파일이 없습니다.** 같은 소유자(Muuuuoouuun)라면 문제없지만, 다른 사람이 쓰려면 명시가 필요합니다.
- 런타임: Python 3.10/3.11(README), **ffmpeg 필수**(`audio_io.require_ffmpeg`). GPU는 선택 사항이며 CUDA/MPS를 자동으로 고릅니다(`engines.py:71` `torch_device`). CREPE는 GPU에서 full, CPU에서 tiny 모델을 씁니다. 첫 실행 때 모델 수백 MB~1 GB를 내려받습니다(`~/.cache/band2sheet/models`, `BAND2SHEET_MODEL_DIR`). CPU로 5분 곡을 처리하면 **수 분~십수 분**이 걸립니다(README). job 큐는 worker 1개입니다(`jobs.py`).
- 테스트(default 10개, festive 17개 파일 + Node frontend 2개): **합성 오디오**(`tests/synth.py`, `song_live.py`: 템포 흔들림·비브라토·슬래시 코드)로 E2E, 양자화, 셋잇단, 손 나누기(`test_split_hands_follows_position`), MIDI import, 키, 뷰 편집을 검증합니다. `tests/evaluate.py`에는 **note F1(onset ±70 ms)과 beat F1 채점기**가 있어 우리 품질 측정에도 쓸 수 있습니다. 다만 ML 엔진(Demucs, Basic Pitch, piano_hr, Beat This!)은 CI에서 돌지 않습니다(VALIDATION: 모델 없이 77 pass/2 skip). **실제 음원 품질은 검증된 적이 없습니다.**

## 5. 리듬게임 재사용 계획

### 5.1 모듈별 처리 방식

| 모듈 | 처리 | 이유/수정 사항 |
|---|---|---|
| `audio_io` (festive) | **import** | `fetch(url, start, duration)`로 구간 다운로드. 캐시 key는 videoId+구간 |
| `separate`, `cleanup` | **import** (band 모드에서만) | 솔로 피아노 모드에서는 쓰지 않음(분리가 오히려 품질을 떨어뜨림) |
| `transcribe.transcribe_stem`, `piano_hr_notes`, `mono_notes`, `merge_fragments`, `make_monophonic` | **import** | 피아노는 `piano_hr`(페달 포함), 멜로디 차트는 vocals+CREPE |
| `rhythm.*`, `project.TimeMap`, `score.Grid` | **import** | 박 그리드와 ms 변환의 핵심. 양자화된 박을 ms로 되돌리는 공식은 `view.py:35`에 이미 있음 |
| `theory.detect_key`, `sections.detect_sections` | **import** | 메타의 key, learn mode의 섹션 |
| `notation.split_hands` | **port** | Event→Note 단위로 바꾸고, 시간 연속성(DP)과 hand 출력을 추가 |
| `importer.project_from_midi/musicxml` | **port** | 트랙/staff 정보를 지우지 않도록 수정(§5.6) |
| `score` music21 렌더, `notation` TAB/페달 표기, `remix/backing/vocalfx`, `segment` | 불필요 | 악보 PDF가 필요해지면 그때 재사용 |
| `app/server.py`, `jobs.py` | **패턴만 참고** | 비동기 job과 progress 콜백, `PUT notes` 편집 API 구조 |
| `app/static/views.js:316-651` (canvas piano roll 편집), `app.js:856-858` (stem drift를 `playbackRate ±0.4%`로 보정) | **참고** | 차트 편집기와 오디오/비주얼 싱크 |

권장 방식: `chartgen` Python 서비스(FastAPI)가 band2sheet를 **특정 커밋(ccf0487)에 고정한 git 의존성**으로 import합니다. 게임 클라이언트(브라우저, Web MIDI)는 차트 JSON만 받습니다.

### 5.2 audio → chart 흐름 (제안)

1. `fetch(url)` 다음 `to_wav`. 메타에 videoId, clipStart, duration을 기록합니다.
2. **모드 선택**(사용자 선택 + 자동 판정): `solo_piano`(믹스에 바로 `piano_hr_notes`) / `band`(`separate_detailed` → piano stem → `transcribe_stem` + `clean_notes`) / `melody`(vocals stem → CREPE → 단선율).
3. `track_beats(mix)` → `fix_tempo_octave` → `guess_meter`/`estimate_meter` → `downbeat`. 이 과정은 `pipeline.analyze:167-213`과 같습니다.
4. Project → 차트 notes. 아래 스케치처럼 양자화된 박을 기준으로 마디·박을 정하고, ms는 오디오에 맞춥니다.
5. hand 지정 → 난이도 파생 → 검증(같은 음 겹침 제거, 최소 길이) → JSON 저장.

```python
# 스케치: band2sheet Project → chart notes (ms는 오디오 기준, 그리드에 가까울 때만 snap)
from band2sheet.score import Grid
def to_chart_notes(p, track="piano", subdiv=4, snap_tol=0.030):
    g = Grid.for_project(p, subdiv).with_triplets(p.tracks[track].notes)   # score.py:87,57
    bpb, shift_bars = p.beats_per_bar, g.shift_beats // p.beats_per_bar
    for i, n in enumerate(sorted(p.tracks[track].notes, key=lambda n: (n.start, n.pitch))):
        qb = g.beat(n.start)                                                # 양자화된 악보 박
        t_snap = float(g.timemap.to_seconds(qb + p.downbeat - g.shift_beats + g.phase))  # view.py:35과 같은 역변환
        t = t_snap if abs(t_snap - n.start) <= snap_tol else n.start
        bar, b = divmod(qb, bpb)
        yield dict(id=f"n{i:05d}", midi=n.pitch, startMs=round(t * 1000), durationMs=round(n.duration * 1000),
                   velocity=n.velocity, measure=int(bar) - shift_bars + 1, beat=round(b + 1, 4))
```

### 5.3 게임 차트에 부족한 것 (gap)

| 필요 | band2sheet 현황 | 할 일 |
|---|---|---|
| ms 단위 박 그리드와 마디선 | `beat_times`(초), `TimeMap`, `view.measure_times`(`view.py:25`) | `beatsMs`, `measures[].startMs`로 export |
| 음표 ms(판정 기준) | 원시 onset(초). 양자화 결과는 악보 단위(ql) | 위 스케치처럼 snap/raw를 섞어 씀. `offGrid` 플래그 |
| hand | `split_hands`가 Event에만 적용 | Note 단위로 port하고 시간 연속성 추가. MusicXML/MIDI는 staff/track에서 가져옴 |
| 난이도 | 없음 (반주를 8분 격자로 단순화하는 기능만 있음: `pipeline.py:403-406`) | Easy: RH skyline(`make_monophonic` 변형, 최고음), 8분 격자, 최소 IOI. Normal: +LH 강박 근음. Hard: 화음 ≤3음. Full: 전부. NPS·최대 화음 수·손 폭으로 레벨 산정 |
| lane 매핑 | 없음 (`InstrumentSpec.low/high` 개념만 있음) | lane=MIDI 번호(88건반 화면). 25/49/61건반 장치에는 난이도별 `range`와 옥타브 접기/`transpose`(`theory.transpose_target`) 적용 |
| 싱크 오프셋 | `Grid.phase`(비트 위상 보정)만 있음 | `meta.offsetMs`(첫 downbeat), `audioOffsetMs`(AAC/MP3 priming, 클립 시작 보정). 사용자 단 `input/outputLatencyMs` 캘리브레이션(AirChoir `audio.js:369` 참고) |
| 음표 id·confidence | 없음 | 생성 시 부여. piano_hr/basic-pitch의 onset 확률을 confidence로 보존 |
| learn mode 섹션 | `detect_sections` | `sections[]`에 ms와 마디 범위를 넣어 export (구간 반복, 느리게 연습) |

### 5.4 제안 차트 JSON 스키마 (v1)

```json
{
  "schema": "pianorhythm.chart/v1",
  "meta": {
    "id": "yt_abc123_piano_v1", "title": "Song", "artist": null,
    "source": { "kind": "youtube|audio|midi|musicxml|pdf", "url": "https://youtu.be/abc123",
                "videoId": "abc123", "clipStartSec": 0, "clipDurationSec": null },
    "generator": { "pipeline": "audio|symbolic", "mode": "solo_piano|band|melody",
                   "engines": { "separation": null, "transcription": "piano_hr", "beats": "beat_this" },
                   "band2sheetCommit": "ccf0487", "createdAt": "2026-10-05T00:00:00Z" },
    "durationMs": 214500, "bpm": 92.4, "timeSignature": [4, 4], "key": "G",
    "offsetMs": 1830, "audioOffsetMs": 0, "pickupBeats": 0,
    "judgeWindowsMs": null
  },
  "timing": {
    "ppq": 480,
    "beatsMs": [1830, 2479, 3128],
    "tempoChanges": [{ "beat": 0, "bpm": 92.4 }],
    "meterChanges": [{ "measure": 1, "timeSignature": [4, 4] }],
    "keyChanges": [{ "measure": 1, "key": "G" }]
  },
  "measures": [{ "number": 1, "startMs": 1830, "beats": 4 }],
  "sections": [{ "id": "s1", "name": "Verse 1", "kind": "Verse", "startMeasure": 1, "endMeasure": 8,
                 "startMs": 1830, "endMs": 22600 }],
  "notes": [
    { "id": "n00001", "midi": 67, "startMs": 1830, "durationMs": 640, "hand": "R", "velocity": 84,
      "measure": 1, "beat": 1.0, "tick": 0, "voice": 1, "finger": null, "confidence": 0.92, "offGrid": false }
  ],
  "chords": [{ "measure": 1, "beat": 1.0, "startMs": 1830, "name": "G" }],
  "pedals": [{ "startMs": 1800, "endMs": 4100 }],
  "difficulties": [
    { "id": "easy",   "level": 2, "hands": ["R"],      "range": { "low": 60, "high": 84 }, "transpose": 0,
      "noteIds": ["n00001"], "overrides": { "n00007": { "midi": 72 } }, "stats": { "nps": 1.4, "maxChord": 1 } },
    { "id": "normal", "level": 4, "hands": ["L", "R"], "noteIds": ["…"] },
    { "id": "hard",   "level": 7, "hands": ["L", "R"], "noteIds": ["…"] },
    { "id": "full",   "level": 9, "hands": ["L", "R"], "noteIds": "*" }
  ]
}
```

- `startMs`: 차트 시간 0(= 클립 시작 + `audioOffsetMs`) 기준으로 건반을 눌러야 하는 시각이며 **판정 기준값**입니다. `measure/beat/tick`은 표시·learn mode용 음악적 위치입니다. 마디는 1부터 시작하고 못갖춘마디는 0, `beat`은 1부터 시작하는 소수, `tick`은 PPQ 480 기준 곡 전체의 절대 위치입니다.
- `hand`: `"L" | "R" | null`. `finger`: 1–5. MusicXML `<fingering>`에서 가져오거나 비워 둡니다.
- 난이도는 기본 `notes`의 **부분집합(noteIds)과 `overrides`**(옥타브 접기 등)로 정의합니다. 음표가 중복 저장되지 않고, 편집하면 모든 난이도에 반영됩니다.
- 판정창(Perfect/Great/Good)은 게임 설정 기본값으로 두고, 차트별 오버라이드만 `meta.judgeWindowsMs`에 둡니다. 기기 지연은 차트가 아니라 사용자 로컬 설정에 저장합니다.

### 5.5 sheet → chart

- **MIDI**: `importer.project_from_midi`(`importer.py:90`)의 tempo/박자표/조표/`get_beats`/`get_downbeats` 처리와 `fix_text`(CP949 가사)를 재사용합니다. 단, `groups.setdefault(stem, []).extend(notes)`(`importer.py:108`)가 **같은 스템의 트랙을 합쳐 손 정보를 잃으므로** port할 때 트랙 index와 channel을 보존해야 합니다. 피아노 트랙이 2개면 위쪽을 R로, 1개면 port한 `split_hands`를 씁니다. ms는 pretty_midi tempo map에서 그대로 계산하므로 snap이 필요 없습니다.
- **MusicXML**: band2sheet는 `project_from_musicxml`(`importer.py:167`)에서 music21으로 **MIDI로 바꾼 뒤** import합니다. 이때 staff, voice, fingering이 사라집니다. 게임용으로는 music21에서 직접 파싱해야 합니다. 쓸 기능은 `PartStaff`/`<staff>` 1=R, 2=L, `stripTies()`, `expandRepeats()`(반복 기호 펼치기, band2sheet는 처리하지 않음, 확인 필요), `MetronomeMark`에서 ms 계산입니다. 코드 기호 추출과 slash notehead 제거(`importer.py:172-180, 210-232`)는 그대로 재사용합니다.
- **PDF**: band2sheet에는 **OMR이 없습니다.** 후보는 Audiveris(Java, 인쇄 악보에서 가장 정확, **AGPL-3.0**: 서버로 제공하면 소스 공개 의무), oemer(Python 딥러닝, MIT, 느리고 정확도가 낮음), homr(Python, 라이선스 확인 필요)입니다. 흐름은 PDF → MusicXML → 위 경로이며, **사용자 교정 UI가 반드시 필요합니다**(`views.js` piano roll과 `PUT /notes/{track}` 패턴 참고).
- **악보 기반 연주 추적**: 오디오가 없는 차트는 박자를 악보 tempo에서 가져오고, 반주는 브라우저 soundfont로 합성합니다(band2sheet `synth.py`는 서버 fluidsynth). 모드는 (a) 일반 판정 모드, (b) Synthesia식 wait mode(맞는 건반을 누를 때까지 진행), (c) 사용자 템포를 따라가는 **score following**(online DTW/HMM) 세 가지를 둡니다. (c)는 band2sheet에 없으므로 새로 만들어야 합니다.

## 6. 위험과 부족한 점

- **밴드 믹스 채보 품질**: Demucs `htdemucs_6s`의 piano 소스는 공식 README에서도 "블리딩과 artifact가 많음"이라고 한 실험 모델입니다. band2sheet의 cleanup 수치(피아노 F1 0.94)는 **합성 곡, 블리딩 −28 dB** 조건의 결과라 실제 곡에서는 크게 떨어질 것입니다. Basic Pitch의 다악기 F1은 약 0.43입니다(`docs/OPEN_SOURCE.md`). 반면 **솔로 피아노 녹음 + piano_hr**는 MAESTRO 기준 onset F1이 약 96.7%라 실용 수준입니다. 그래서 MVP는 "피아노 커버 영상"으로 잡고, band 모드는 "베타, 편집 필요"로 표시하는 것을 권장합니다. 다음 후보 엔진은 YourMT3+, Transkun/hFT-Transformer입니다(라이선스 확인 필요).
- **비트 추적**: 루바토가 강한 솔로 피아노에서 Beat This!와 librosa가 흔들리면 마디·박 번호가 틀립니다. 판정은 `startMs`(오디오 기준)로 하므로 게임 진행에는 문제가 없지만, 마디선과 섹션은 어긋날 수 있습니다. 사용자 BPM/downbeat 입력 UI가 필요합니다(band2sheet에도 `--bpm/--downbeat`이 있음).
- **싱크**: AAC/MP3 encoder priming(수십 ms), YouTube IFrame 재생 지연, Web MIDI 입력 지연, 오디오 출력 지연이 겹칩니다. 분석은 WAV 기준이므로 재생 소스가 다르면 `audioOffsetMs`를 따로 측정해야 하고, 기기별 캘리브레이션 화면이 필수입니다.
- **처리 시간과 인프라**: torch, Demucs, 모델 가중치로 수 GB입니다. CPU에서는 곡당 수~십수 분이고 GPU를 권장합니다. 실시간은 불가능하므로 비동기 job, progress, videoId 캐시가 필요합니다. Python 3.10/3.11로 고정해야 합니다.
- **저작권과 ToS**: yt-dlp 다운로드는 YouTube ToS에 걸리고, 생성한 차트는 원곡 작곡의 2차적 저작물입니다. 오디오를 재호스팅하지 말고, 재생은 YouTube IFrame Player API를 쓰고, 차트는 개인 로컬 사용을 기본으로, 공개 공유는 제한할 것을 권장합니다. band2sheet README(`README.md:270`)에도 같은 경고가 있습니다.
- **라이선스**: band2sheet에 LICENSE가 없습니다. UVR 커뮤니티 가중치는 조건이 불명확하고, Audiveris는 AGPL, verovio/cairosvg는 LGPL입니다. 상용화 전에 모델 카드를 하나씩 확인해야 합니다.
