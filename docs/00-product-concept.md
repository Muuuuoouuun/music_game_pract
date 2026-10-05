# 제품 컨셉 정리 — 실제 피아노로 하는 리듬게임

> 가칭: **KeyBeat** (후보: Piano Quest / PlayKey / NoteRush)
>
> 한 줄 정의: 실제 피아노·전자피아노를 연결해, 리듬게임처럼 곡을 플레이하면서 자연스럽게 연주를 배우는 앱/웹 서비스.
>
> 제품 철학: **"연습을 게임으로 바꾸는 것이 아니라, 게임 자체가 실제 연습이 되게 만든다."**
> 일반 리듬게임은 `A S D F`를 누르지만, 여기서는 `C D E F G` 실제 음을 연주한다. 게임에서 익힌 것이 그대로 현실 스킬로 남는다.

---

## 1. 핵심 경험 (Core Loop)

```
곡 선택 → 게임 시작 → 떨어지는 노트에 맞춰 실제 건반 연주 → 즉시 판정 → 점수/콤보/랭크 → 성장(XP·퀘스트) → 다음 곡/다음 단계
```

포지셔닝: **Synthesia + 리듬게임 + Duolingo식 학습 설계 + 실제 피아노**

## 2. 곡이 들어오는 세 가지 경로

| 경로 | 입력 | 처리 | 결과 |
|---|---|---|---|
| 기본 카탈로그 | 운영팀이 만든 차트 | — | 바로 플레이 |
| **오디오 → 차트** | YouTube 링크 / mp3·wav 업로드 | 오디오 가져오기 → 음원 분리(Demucs) → 채보(Basic Pitch 등) → 템포·박자 분석 → 양손 분리 → 난이도 생성 | 플레이 가능한 차트 (Easy / Normal / Original) |
| **악보 → 차트** | MusicXML / MIDI / PDF·사진 | (PDF·사진이면 OMR) → 파싱 → 박자 그리드 정렬 | 악보와 1:1로 대응하는 차트 + **악보 기준 채점** |

- 오디오 → 차트 로직은 형제 프로젝트 **Music_band / band2sheet**의 음원 추출·채보 파이프라인을 재사용 대상으로 본다 → [`research/02-music-band-analysis.md`](research/02-music-band-analysis.md)
- 악보를 넣으면 "그 악보대로 제대로 쳤는지"를 음 단위로 추적: 맞은 음 / 틀린 음 / 빠름·느림(ms) / 마디별 정확도.
- YouTube 링크 기능은 저작권·약관 이슈가 있으므로, MVP에서는 "본인이 권리를 가진 음원" 업로드 + 퍼블릭 도메인/라이선스 카탈로그 중심으로 설계하고 링크 기능은 실험 기능으로 둔다.

## 3. 게임 모드

### A. Rhythm Play (메인)
- 노트가 내려오고 실제 건반을 누름 → `Perfect / Great / Good / Miss` (+ 틀린 건반 `Wrong`)
- Combo, Score, Accuracy, Grade(S/A/B/C/D), Full Combo, Perfect Play
- 판정 기준(목업 공통): Perfect ≤45ms, Great ≤90ms, Good ≤140ms, 그 외 Miss

### B. Learn Mode
곡을 쪼개서 단계적으로 연습 (예: Für Elise)

```
Lv.1 오른손 4마디 → Lv.2 오른손 8마디 → Lv.3 왼손 추가 → Lv.4 속도 70% → Lv.5 속도 100% → Boss Stage 전곡
```
- 구간 반복(A–B 루프), 한 손씩, 템포 조절, **Wait 모드**(정답 건반을 칠 때까지 기다림)

### C. Adaptive Gameplay (Killer Feature)
사용자가 어려워하면 같은 곡을 자동으로 단순화했다가, 실력이 오르면 원곡으로 복원.

```
원곡            Easy
C E G C   →    C   G
D F A D   →    D   A
E G B E   →    E   B
```
Beginner → Intermediate → Original 로 **같은 노래가 사용자와 함께 성장**.

## 4. 재미/리텐션 요소
- **XP & 레벨**: Lv.1 Beginner → Lv.50 Pianist
- **퀘스트**: 오늘 10분 연주 / Perfect 100회 / 새 곡 클리어 / 7일 연속
- **업적**: First Full Combo, 100 Songs, Chopin Master, 30 Day Streak
- **랭킹**: 친구 / 학교 / 지역 / 글로벌
- **꾸미기**: 코인으로 피아노·연습실·캐릭터·의상·무대 구매

## 5. 하드웨어 연결

```
전자피아노 ──USB MIDI / Bluetooth MIDI──▶ PC·태블릿·폰 ──▶ 게임 엔진 ──▶ 실시간 판정
```
MIDI로 알 수 있는 것: 어떤 키 / 언제 눌렀나 / 세기(velocity) / 언제 뗐나 / 서스테인 페달
→ 이후 Velocity · Dynamics · Pedal 평가까지 확장 가능.

어쿠스틱 피아노 확장(2단계 이후): ① 마이크 음 인식 ② 건반 위 카메라 손·건반 인식 ③ 전용 센서 바 → "어쿠스틱 피아노를 스마트 피아노로" 하드웨어 사업.

## 6. 타깃
| 세그먼트 | 니즈 | 핵심 장치 |
|---|---|---|
| 어린이 | 재미, 보상, 부모 안심 | 캐릭터·월드맵·보상 (시안 C) |
| 입문 성인 | 학원 부담 없이 좋아하는 곡(OST, K-pop, 애니, 팝) 치기 | 쉬운 편곡, 내 곡 가져오기 (시안 A·B) |
| 기존 학습자 | 연습을 재미있게, 정확한 피드백 | 악보 싱크 채점, 구간 연습 (시안 B) |
| 피아노 학원(B2B) | "집에서 실제로 연습했는지 모른다" 해결 | 숙제 배정 + 연습 데이터 대시보드 (시안 B 선생님 탭) |

## 7. AI Coach
연주 데이터가 쌓이므로 AI가 자연스럽게 들어간다.
- "3번째 마디에서 왼손 타이밍이 평균 120ms 느립니다."
- "지금 속도에서는 정확도가 82%입니다. BPM을 72로 낮춰 연습해보세요."
- 개인화 연습 플랜 자동 생성: `13~17마디 오른손 ×3 → 왼손만 BPM 70 → 양손 BPM 60 → Full Song Challenge`

## 8. 로드맵

| Phase | 이름 | 내용 |
|---|---|---|
| **MVP 1.0** | Play | MIDI 연결, Falling Note UI, 실시간 판정, Score/Combo, 5~10곡 |
| 2 | Learn | 곡별 레슨, 구간·한손·템포 연습, **악보 업로드 → 채점** |
| 3 | Progress | 레벨/XP/퀘스트/업적 |
| 4 | AI Coach | 실수 분석 + 개인 훈련 플랜, Adaptive 난이도 |
| 5 | Social | 친구/랭킹/챌린지 |
| 6 | Teacher | 학원·선생님 대시보드 (B2B SaaS) |
| 7 | Hardware | 마이크·카메라·센서 바 |

오디오 → 차트(YouTube/음원 업로드)는 Phase 2~3에 band2sheet 파이프라인을 붙여 실험 기능으로 시작.

## 9. 비즈니스 모델
- **Free**: 기본곡, 하루 플레이 제한
- **Premium** (월 9,900~19,900원): 전체 곡, AI Coach, 고급 분석, 전 게임모드
- **Song Pass / DLC**: K-pop Pack, Ghibli Pack, Disney Pack, Classical Pack, Anime OST Pack (라이선스 필요)
- **B2B**: 학원당 SaaS 구독 + 학생 라이선스

## 10. 장기 비전
**Real Instrument Gaming Platform** — 실제 악기가 게임 컨트롤러가 되는 플랫폼.
`Piano → Drum → Guitar → Violin → Saxophone`

`Rhythm Game → Skill Learning → AI Coach → Music Education Platform → Instrument Hardware Ecosystem`
