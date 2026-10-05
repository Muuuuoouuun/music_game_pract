/** Static markup of the play screen (mockup D's cabinet: head, controls, stage, keys, coach). */
import { OFFSET_MAX, OFFSET_MIN } from '../state/settings';
import { ICON } from './dom';

export function playTemplate(): string {
  return `
  <div class="play-head">
    <div class="ph-id">
      <span class="mode-chip" id="modeChip" data-m="demo"><i></i><span id="modeTxt">DEMO</span></span>
      <div class="ph-text"><a class="ph-title" id="phTitle" href="#home" title="다른 곡 고르기">KeyStage</a><span class="ph-meta" id="phMeta"></span></div>
    </div>
    <div class="ph-score"><span class="lbl">SCORE</span><b class="score" id="score">0,000,000</b><span class="acc-mini" id="accMini">ACC 100.00%</span></div>
    <div class="progress" aria-hidden="true"><i id="prog"></i></div>
  </div>
  <div class="controls" id="controls">
    <button class="btn cta" id="btnMain" type="button"></button>
    <button class="btn" id="btnRestart" type="button" aria-label="처음부터">${ICON.restart}<span>처음부터</span></button>
    <span class="seg seg-view" role="group" aria-label="보기">
      <button data-view="sheet" aria-pressed="false" type="button">악보만</button><button data-view="both" aria-pressed="true" type="button">둘 다</button><button data-view="hw" aria-pressed="false" type="button">하이웨이만</button>
    </span>
    <div class="drawer" id="drawer" aria-label="연습 설정">
      <div class="pg pg-main">
        <span class="ctl"><span>템포</span><span class="seg" role="group" aria-label="템포">
          <button data-rate="0.5" aria-pressed="false" type="button">50%</button><button data-rate="0.75" aria-pressed="false" type="button">75%</button><button data-rate="1" aria-pressed="true" type="button">100%</button>
        </span></span>
        <span class="ctl"><span>손</span><span class="seg" role="group" aria-label="손 모드">
          <button data-hands="R" aria-pressed="true" type="button">오른손</button><button data-hands="L" aria-pressed="false" type="button">왼손</button><button data-hands="B" aria-pressed="false" type="button">양손</button>
        </span></span>
        <label class="switch" title="정답 건반을 칠 때까지 기다려요"><input type="checkbox" id="optWait">대기 모드</label>
        <label class="switch" title="고른 마디만 계속 반복해요"><input type="checkbox" id="optLoop">A–B 반복</label>
      </div>
      <div class="pg pg-more">
        <div class="ab"><span>구간</span><label for="loopA">A</label><select class="sel" id="loopA"></select><span>–</span><label for="loopB">B</label><select class="sel" id="loopB"></select><span>마디</span></div>
        <label class="switch"><input type="checkbox" id="optMetro">메트로놈</label>
        <label class="switch"><input type="checkbox" id="optAuto">자동 연주 · 모범 연주 보기</label>
        <label class="switch" title="PC 키보드·화면 건반을 칠 때 소리를 내요"><input type="checkbox" id="optSoundKeys">건반 소리 내기 · PC/화면</label>
        <label class="switch" title="전자피아노 스피커를 끈 경우에 켜요"><input type="checkbox" id="optSoundMidi">건반 소리 내기 · MIDI</label>
        <label class="ctl offset" for="offset"><span>지연 보정</span><input type="range" id="offset" min="${OFFSET_MIN}" max="${OFFSET_MAX}" step="1" value="0"><output id="offsetVal" for="offset">±0 ms</output></label>
        <p class="dr-note">건반이나 스피커가 늦게 반응하면 + 쪽으로 옮겨요. <a href="#device">건반 연결 화면</a>에서 박자에 맞춰 두드려 자동으로 맞출 수 있어요. 대기 모드에서는 맞은 음을 칠 때까지 악보가 멈춰요.</p>
      </div>
    </div>
    <button class="btn ghost" id="btnDrawer" type="button" aria-expanded="false" aria-controls="drawer"><span>연습 설정</span>${ICON.caret}</button>
  </div>
  <div class="view" id="view" data-view="both">
    <div class="meters">
      <div class="meter life" id="lifeM"><span>LIFE</span><div class="track"><i class="fill"></i></div></div>
      <div class="meter fever" id="feverM"><span>FEVER</span><div class="track"><i class="fill"></i></div></div>
    </div>
    <div class="hud-l">
      <div class="hud-box"><span class="lbl">Accuracy</span><b id="acc">100.00%</b></div>
      <div class="hud-box"><span class="lbl">Max combo</span><b id="maxc">0</b></div>
      <ul class="hud-counts" id="hudCounts"></ul>
    </div>
    <div class="score-panel" id="scorePanel">
      <div class="sheet-wrap" id="sheetWrap"><div id="sheetHost" role="img" aria-label="악보. 판정된 음표는 색이 바뀌고, 틀린 건반은 빨간 점선 음표로 표시돼요."></div></div>
    </div>
    <div class="stage" id="stage"><canvas id="hw" aria-label="노트가 떨어지는 하이웨이"></canvas></div>
    <div class="combo off" id="combo"><b id="comboN">0</b><span>COMBO</span></div>
    <div class="judge-wrap"><div class="judge" id="judge"></div><div class="fs" id="fs"></div></div>
    <div class="big" id="big"></div>
    <div class="overlay" id="overlay">
      <div class="ov-card">
        <p class="ov-eyebrow" id="ovEyebrow"><i></i><span id="ovEyeTxt">DEMO · 자동 연주 중</span></p>
        <button class="btn cta" id="ovPlay" type="button">${ICON.play}직접 플레이</button>
        <div class="ov-row" id="ovPauseRow" hidden><button class="btn cta" id="ovResume" type="button">계속하기</button><button class="btn ghost" id="ovRestart" type="button">처음부터</button></div>
        <p class="ov-hint" id="ovHint"><kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> <kbd>F</kbd> <kbd>G</kbd> <kbd>H</kbd> <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> <kbd>;</kbd> 또는 MIDI 건반으로 연주</p>
      </div>
    </div>
  </div>
  <div class="keys-wrap"><div class="keys" id="keys" aria-label="피아노 건반"></div></div>
  <div class="coach-line">
    <span class="coach-tag">${ICON.spark}<b>AI 코치</b></span>
    <p id="coachLive" aria-live="polite">데모 연주 중이에요.</p>
  </div>`;
}
