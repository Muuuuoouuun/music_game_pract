/**
 * Static markup of the play screen. One stage (sheet + highway + keys) with three layers
 * on top that the phase decides between:
 *  - 준비 (ready): the song card with grouped settings over the dimmed attract demo,
 *  - 연주 중 (focus): a thin HUD strip (progress, bar, small score, pause button),
 *  - 일시정지: the pause menu with live stats and the AI coach line.
 */
import { OFFSET_MAX, OFFSET_MIN } from '../state/settings';
import { ICON } from './dom';

const seg = (label: string, attr: string, items: [string, string][]) =>
  `<span class="seg" role="group" aria-label="${label}">${items.map(([v, t]) => `<button data-${attr}="${v}" aria-pressed="false" type="button">${t}</button>`).join('')}</span>`;

const group = (label: string, body: string, extra = '') => `<div class="og"${extra}><span class="og-l">${label}</span>${body}</div>`;

export function playTemplate(): string {
  return `
  <div class="fhud" id="fhud">
    <div class="fprog" aria-hidden="true"><i id="prog"></i></div>
    <button class="fbtn" id="btnPause" type="button" aria-label="일시정지 (Esc 또는 Space)" title="일시정지 · Esc">${ICON.pause}</button>
    <span class="fmeas" id="fMeas" aria-label="마디"></span>
    <span class="fpill" id="fLoop" hidden></span>
    <span class="fpill tag" id="fTag" hidden></span>
    <span class="fscore"><span class="acc-mini" id="accMini"></span><b class="score" id="score">0,000,000</b></span>
  </div>
  <div class="view" id="view" data-view="both">
    <div class="meters" id="meters">
      <div class="meter life" id="lifeM"><span>LIFE</span><div class="track"><i class="fill"></i></div></div>
      <div class="meter fever" id="feverM"><span>FEVER</span><div class="track"><i class="fill"></i></div></div>
    </div>
    <div class="hud-l" id="hudL">
      <div class="hud-box"><span class="lbl">Accuracy</span><b id="acc">100.00%</b></div>
      <div class="hud-box"><span class="lbl">Max combo</span><b id="maxc">0</b></div>
      <ul class="hud-counts" id="hudCounts"></ul>
    </div>
    <div class="score-panel" id="scorePanel">
      <div class="sheet-wrap" id="sheetWrap"><div id="sheetHost" role="img" aria-label="악보. 판정된 음표는 색이 바뀌고, 틀린 건반은 빨간 점선 음표로 표시돼요."></div></div>
    </div>
    <div class="stage" id="stage"><canvas id="hw" aria-label="노트가 떨어지는 하이웨이"></canvas></div>
    <div class="combo off" id="combo" aria-hidden="true"><b id="comboN">0</b><span>COMBO</span></div>
    <div class="judge-wrap" aria-hidden="true"><div class="judge" id="judge"></div><div class="fs" id="fs"></div></div>
    <div class="big" id="big" aria-hidden="true"></div>
    <p class="whint" id="whint" hidden></p>
  </div>
  <div class="keys-wrap" id="keysWrap"><div class="keys" id="keys" aria-label="피아노 건반"></div></div>

  <section class="ready" id="ready" aria-labelledby="rdTitle">
    <div class="rd-card">
      <div class="rd-main">
        <div class="rd-top">
          <p class="eyebrow">곡 준비</p>
          <button class="fsbtn" id="btnFs" type="button" aria-pressed="false" title="전체 화면">${ICON.full}<span>전체 화면</span></button>
        </div>
        <h1 class="rd-title" id="rdTitle">KeyStage</h1>
        <p class="rd-comp" id="rdComp"></p>
        <dl class="rd-facts" id="rdFacts"></dl>
        <div class="rd-best" id="rdBest"></div>
        <p class="rd-dev" id="rdDev"></p>
        <div class="rd-go">
          <button class="btn cta rd-start" id="btnStart" type="button">${ICON.play}<span id="btnStartT">시작</span></button>
          <button class="btn ghost" id="btnFresh" type="button" hidden>${ICON.restart}처음부터</button>
        </div>
        <p class="rd-hint" id="rdHint"></p>
      </div>
      <div class="rd-opts" aria-label="연주 설정">
        ${group('보기', seg('보기', 'view', [['sheet', '악보만'], ['both', '둘 다'], ['hw', '하이웨이만']]))}
        ${group('템포', seg('템포', 'rate', [['0.5', '50%'], ['0.75', '75%'], ['1', '100%']]))}
        ${group('손', seg('손', 'hands', [['R', '오른손'], ['L', '왼손'], ['B', '양손']]))}
        ${group('연습 방식', seg('연습 방식', 'wait', [['0', '일반'], ['1', '대기 모드']]) + '<span class="og-n" id="waitNote">맞는 건반을 칠 때까지 악보가 기다려요</span>')}
        ${group(
          '구간',
          seg('구간', 'loop', [['0', '전곡'], ['1', 'A–B 마디']]) +
            `<span class="ab" id="abRow"><label for="loopA">A</label><select class="sel" id="loopA"></select><span>–</span><label for="loopB">B</label><select class="sel" id="loopB"></select><span>마디 반복</span></span>`,
        )}
        <details class="more" id="more">
          <summary>더보기 <span class="more-sum" id="moreSum"></span>${ICON.caret}</summary>
          <div class="more-body">
            <label class="switch"><input type="checkbox" id="optMetro">메트로놈</label>
            <label class="switch"><input type="checkbox" id="optAuto">자동 연주 · 모범 연주 보기</label>
            <label class="switch" title="준비 화면에서 MIDI 건반을 아무거나 누르면 시작해요"><input type="checkbox" id="optKeyStart">건반을 누르면 시작</label>
            <label class="switch" title="PC 키보드·화면 건반을 칠 때 소리를 내요"><input type="checkbox" id="optSoundKeys">건반 소리 · PC/화면</label>
            <label class="switch" title="전자피아노 스피커를 끈 경우에 켜요"><input type="checkbox" id="optSoundMidi">건반 소리 · MIDI</label>
            <div class="bt-row" id="btRow" style="grid-column:1/-1;display:grid;gap:10px" hidden>
              <label class="switch" title="채보의 원본 녹음을 연주에 맞춰 함께 들려줘요"><input type="checkbox" id="optBacking">원곡 소리 · 녹음 반주</label>
              <label class="ctl offset" for="btGain"><span>원곡 볼륨</span><input type="range" id="btGain" min="0" max="100" step="5" value="80"><output id="btGainVal" for="btGain">80%</output></label>
              <p class="dr-note" id="btNote">카운트인 동안 녹음의 앞부분이 먼저 들리고, 첫 박에 맞춰 노트가 내려와요. 대기 모드에서는 기다리는 동안 소리도 멈춰요.</p>
            </div>
            ${group('HUD', seg('연주 중 HUD', 'hud', [['focus', '집중'], ['detail', '상세']]) + '<span class="og-n">상세: 정확도·판정 수·LIFE를 옆에 계속 보여요</span>')}
            <label class="ctl offset" for="offset"><span>지연 보정</span><input type="range" id="offset" min="${OFFSET_MIN}" max="${OFFSET_MAX}" step="1" value="0"><output id="offsetVal" for="offset">±0 ms</output></label>
            <p class="dr-note">건반이나 스피커가 늦게 반응하면 + 쪽으로 옮겨요. <a href="#device">건반 연결 화면</a>에서 박자에 맞춰 두드려 자동으로 맞출 수 있어요.</p>
          </div>
        </details>
      </div>
    </div>
  </section>

  <div class="pmenu" id="pmenu" role="dialog" aria-modal="true" aria-labelledby="pmTitle" hidden>
    <div class="pm-card">
      <p class="pm-alert" id="pmAlert" role="alert" hidden></p>
      <div class="pm-head"><h2 id="pmTitle">일시정지</h2><span class="pm-sub" id="pmSub"></span></div>
      <dl class="pm-stats">
        <div><dt>정확도</dt><dd id="pmAcc">–</dd></div>
        <div><dt>콤보</dt><dd id="pmCombo">0</dd></div>
        <div><dt>점수</dt><dd id="pmScore">0</dd></div>
      </dl>
      <ul class="pm-counts" id="pmCounts"></ul>
      <div class="pm-coach"><span class="coach-tag">${ICON.spark}<b>AI 코치</b></span><p id="coachLive"></p></div>
      <div class="pm-actions">
        <button class="btn cta" id="pmResume" type="button">${ICON.play}계속하기</button>
        <button class="btn" id="pmRestart" type="button">${ICON.restart}처음부터</button>
        <button class="btn" id="pmSettings" type="button">설정 바꾸기</button>
        <button class="btn ghost" id="pmExit" type="button">곡 나가기</button>
      </div>
      <p class="pm-hint"><kbd>Esc</kbd> 계속하기</p>
    </div>
  </div>
  <p class="sr-only" id="announce" aria-live="polite"></p>`;
}
