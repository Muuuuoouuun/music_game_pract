# KeyBeat (가칭) — 실제 피아노로 하는 리듬게임

전자피아노·MIDI 키보드를 컨트롤러로 쓰는 리듬게임. 떨어지는 노트에 맞춰 진짜 건반을 치면
실시간으로 판정(Perfect / Great / Good / Miss)하고 점수·콤보·랭크로 보상합니다.
YouTube/음원이나 악보를 넣으면 플레이 가능한 차트로 바꾸고, 악보대로 제대로 쳤는지 채점합니다.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/00-product-concept.md](docs/00-product-concept.md) | 제품 컨셉, 게임 모드, 타깃, 로드맵, 비즈니스 모델 |
| [docs/research/01-market-and-oss.md](docs/research/01-market-and-oss.md) | 시중 서비스·오픈소스 레퍼런스 조사, 기술 사실, 추천 스택 |
| [docs/research/02-music-band-analysis.md](docs/research/02-music-band-analysis.md) | Music_band(band2sheet) 음원 추출·채보 로직 분석과 재사용 계획, 차트 JSON 스키마 |

## 목업 (시안 3개)

브라우저에서 바로 열어 플레이할 수 있는 단일 HTML 파일입니다. PC 키보드(`A W S E D F T G Y H U J K …`),
화면 건반 터치, Web MIDI(Chrome/Edge) 입력을 모두 받습니다. 공통 규칙은 [mockups/BRIEF.md](mockups/BRIEF.md).

| 시안 | 파일 | 방향 |
|---|---|---|
| A. NEON STAGE | [mockups/a-neon-stage.html](mockups/a-neon-stage.html) · [미리보기](https://claude.ai/artifact/3GSUyhSJ3anmuw7i4PhSsw) | 아케이드 리듬게임형 — 원근 노트 하이웨이, 피버, 화려한 판정 이펙트 |
| B. SCORE FLOW | [mockups/b-score-flow.html](mockups/b-score-flow.html) · [미리보기](https://claude.ai/artifact/8He3aNXJqQdPpVb19FKnGm) | 악보 싱크·학습형 — 대보표 위 실시간 채점, Wait 모드, 구간 반복, 선생님 대시보드 |
| C. PIANO QUEST | [mockups/c-piano-quest.html](mockups/c-piano-quest.html) · [미리보기](https://claude.ai/artifact/Dg93R9pn9Wkvxovp5Wu47C) | 키즈·게이미피케이션형 — 월드맵, 마스코트, 색깔 건반, 적응형 난이도 |

> 미리보기 링크는 비공개 아티팩트라 다른 사람이 보려면 페이지의 Share 메뉴에서 공유해야 합니다.
> 목업 HTML은 아티팩트 게시 형식(조각 HTML, `<html>/<head>` 태그 없음)으로 작성되어 있습니다.
> 로컬에서는 파일을 그대로 브라우저로 열거나 `npx serve mockups`로 띄우면 됩니다.
