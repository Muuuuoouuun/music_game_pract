/**
 * 건반 연결 screen: MIDI status and fixes, device picker, a live input monitor, a latency
 * calibration wizard and connection help. Answers "is my keyboard working?" before a run.
 */
import { synth } from '../audio/synth';
import { noteName } from '../core/chart';
import { statusHelp, type MidiInput } from '../input/midi';
import type { InputHub, NoteInput } from '../input/hub';
import { OFFSET_MAX, OFFSET_MIN, settings, updateSettings } from '../state/settings';
import { calibrate, type Calibration } from './calibration';
import { $, esc, toast } from './dom';
import { nKo, signed } from './format';
import { PianoKeys } from './piano-keys';

const CAL_BPM = 100;
const CAL_COUNT = 4;
const CAL_BEATS = 8;
const SRC: Record<NoteInput['source'], string> = { midi: 'MIDI', pc: 'PC', pointer: '화면' };

export function deviceTemplate(): string {
  const dots = Array.from({ length: CAL_COUNT + CAL_BEATS }, (_, i) =>
    `<span class="cal-dot${i < CAL_COUNT ? ' pre' : ''}" data-i="${i}"><i></i><em></em></span>`).join('');
  return `
  <div class="wrap">
    <div class="home-head">
      <div>
        <p class="eyebrow">DEVICE</p>
        <h1 class="h-disp">건반 연결</h1>
        <p class="lede">전자피아노나 MIDI 건반이 제대로 들어오는지 여기서 바로 확인해요. 건반을 눌러 불이 들어오면 준비 끝이에요.</p>
      </div>
    </div>
    <div class="dev-grid">
      <section class="panel dev-status" aria-labelledby="devStatusH">
        <div class="dev-st-top">
          <span class="dev-led" id="devLed" data-s="idle"></span>
          <div class="dev-st-text"><h2 id="devStatusH">연결 상태</h2><b id="devStatusT">확인 중…</b></div>
          <button class="btn sm" id="devReconnect" type="button">다시 연결</button>
        </div>
        <p class="dev-help-line" id="devHelp"></p>
        <ul class="dev-list" id="devList" aria-label="MIDI 입력 기기"></ul>
        <p class="shelf-note">여러 기기가 연결돼 있으면 연주에 쓸 건반만 체크해 두세요. 기기를 꽂거나 빼면 목록이 바로 바뀌어요.</p>
      </section>
      <section class="panel dev-monitor" aria-labelledby="devMonH">
        <div class="ph2"><h2 id="devMonH">입력 모니터</h2><span class="dev-rate"><b id="devRate">0</b> 음/초</span></div>
        <div class="keys mini" id="devKeys" aria-hidden="true"></div>
        <div class="dev-now">
          <div class="dev-note"><span class="lbl">마지막 음</span><b id="devNote">–</b><small id="devNoteKo">건반을 눌러 보세요</small></div>
          <div class="dev-vel"><span class="lbl">세기</span><div class="dev-velbar"><i id="devVel"></i></div><small id="devVelN">–</small></div>
          <div class="dev-pedal" id="devPedal"><span class="lbl">페달</span><b>SUSTAIN</b><small id="devPedalT">떼짐</small></div>
        </div>
        <div class="dev-log-h"><span class="lbl">마지막 입력</span></div>
        <ol class="dev-log" id="devLog"><li class="empty">아직 입력이 없어요</li></ol>
      </section>
      <section class="panel dev-cal" aria-labelledby="devCalH">
        <div class="ph2"><h2 id="devCalH">지연 보정</h2><span class="dev-cur">지금 <b id="devCurOff">0 ms</b></span></div>
        <p class="dev-help-line">메트로놈 클릭(♩=${CAL_BPM})에 맞춰 아무 건반이나 박마다 한 번씩 눌러 주세요. 4번 준비 클릭 뒤 ${CAL_BEATS}박을 재요. 건반이 없으면 아래 판을 눌러도 돼요.</p>
        <button class="cal-pad" id="calPad" type="button" aria-label="박자에 맞춰 누르는 판">
          <span class="cal-pulse" id="calPulse"></span>
          <span class="cal-dots" id="calDots">${dots}</span>
          <span class="cal-msg" id="calMsg">시작을 누르면 클릭이 나와요</span>
        </button>
        <div class="cal-actions">
          <button class="btn cta" id="calStart" type="button">보정 시작</button>
          <button class="btn" id="calApply" type="button" hidden>적용</button>
          <label class="ctl offset" for="devOffset"><span>직접 조절</span><input type="range" id="devOffset" min="${OFFSET_MIN}" max="${OFFSET_MAX}" step="1"><output id="devOffsetVal">0 ms</output></label>
        </div>
        <p class="cal-note">블루투스 헤드폰·스피커는 소리가 150–300ms 늦게 나와서 박자보다 늦게 치게 돼요. 가능하면 유선 이어폰이나 피아노 스피커를 쓰고, 블루투스를 쓴다면 그 상태로 보정해 주세요.</p>
      </section>
      <section class="panel dev-sound" aria-labelledby="devSoundH">
        <h2 id="devSoundH">건반 소리</h2>
        <label class="switch"><input type="checkbox" id="devSoundMidi">MIDI 건반을 칠 때 소리 내기</label>
        <p class="shelf-note">전자피아노는 보통 자기 스피커로 소리를 내요. 피아노 볼륨을 0으로 했거나 소리가 안 나는 MIDI 컨트롤러라면 켜 주세요.</p>
        <label class="switch"><input type="checkbox" id="devSoundKeys">PC 키보드·화면 건반 소리 내기</label>
      </section>
      <section class="panel dev-help" aria-labelledby="devHelpH">
        <h2 id="devHelpH">연결이 안 될 때</h2>
        <dl class="help-list">
          <div><dt>USB가 가장 확실해요</dt><dd>전자피아노 뒤의 <b>USB to Host</b>(사각형 USB-B) 단자와 컴퓨터를 케이블로 연결하세요. 'USB to Device'(USB 메모리용) 단자는 MIDI가 아니에요.</dd></div>
          <div><dt>브라우저</dt><dd>컴퓨터의 <b>Chrome · Edge</b>에서 열어 주세요. 처음 연결할 때 'MIDI 기기 사용' 허용 창이 뜨면 허용을 눌러요. <b>Safari와 아이폰·아이패드</b>는 아직 Web MIDI를 지원하지 않아요.</dd></div>
          <div><dt>블루투스 MIDI</dt><dd><b>macOS</b>: Audio MIDI 설정 앱 → 윈도우 → MIDI 스튜디오 보기 → Bluetooth 구성에서 피아노를 연결한 뒤 이 화면에서 다시 연결을 눌러요. <b>Windows</b>: 블루투스 MIDI 지원이 기기마다 달라서 잘 안 보일 수 있어요. 가능하면 USB 케이블을 쓰세요. 블루투스는 USB보다 10–20ms 늦어서 지연 보정을 해 두면 좋아요.</dd></div>
          <div><dt>오래된 피아노</dt><dd>일부 오래된 모델은 제조사의 USB-MIDI 드라이버(Yamaha·Roland·Kawai·Casio 지원 페이지)를 설치해야 컴퓨터가 알아봐요. 둥근 5핀 MIDI 단자만 있다면 USB-MIDI 인터페이스 케이블이 필요해요.</dd></div>
          <div><dt>그래도 안 보이면</dt><dd>케이블을 뺐다 다시 꽂고, 다른 프로그램(DAW 등)이 건반을 쓰고 있지 않은지 확인한 뒤 '다시 연결'을 눌러요. 건반이 없어도 PC 키보드(A S D F …)나 화면 건반으로 플레이할 수 있어요.</dd></div>
        </dl>
      </section>
    </div>
  </div>`;
}

export class DeviceScreen {
  private root: HTMLElement;
  private midi: MidiInput;
  private keys!: PianoKeys;
  private onTimes: number[] = [];
  private log: string[] = [];
  private active = false;
  private rateTimer = 0;
  private cal: { beats: number[]; taps: number[]; end: number; idx: number; raf: number } | null = null;
  private result: Calibration | null = null;
  onOffsetChange: (() => void) | null = null;

  constructor(root: HTMLElement, hub: InputHub) {
    this.root = root;
    this.midi = hub.midi;
  }

  mount(): void {
    this.root.innerHTML = deviceTemplate();
    this.keys = new PianoKeys($('#devKeys', this.root), { labels: false, interactive: false });
    this.keys.build(21, 108);
    $('#devReconnect', this.root).addEventListener('click', () => this.reconnect());
    $('#devList', this.root).addEventListener('change', () => this.pickDevices());
    $('#calStart', this.root).addEventListener('click', () => this.startCal());
    $('#calApply', this.root).addEventListener('click', () => this.applyCal());
    $('#calPad', this.root).addEventListener('pointerdown', (e) => {
      synth.unlock();
      if (this.cal) this.tap(e.timeStamp);
    });
    const off = $<HTMLInputElement>('#devOffset', this.root);
    off.addEventListener('input', () => {
      updateSettings({ offset: Number(off.value) });
      this.syncOffset();
      this.onOffsetChange?.();
    });
    const sm = $<HTMLInputElement>('#devSoundMidi', this.root);
    const sk = $<HTMLInputElement>('#devSoundKeys', this.root);
    sm.addEventListener('change', () => updateSettings({ soundMidi: sm.checked }));
    sk.addEventListener('change', () => updateSettings({ soundKeys: sk.checked }));
    this.midi.onChange(() => this.renderStatus());
    this.midi.onPedal((e) => this.setPedal(e.down));
    this.renderStatus();
    this.syncOffset();
  }

  enter(): void {
    this.active = true;
    this.renderStatus();
    this.syncOffset();
    $<HTMLInputElement>('#devSoundMidi', this.root).checked = settings.soundMidi;
    $<HTMLInputElement>('#devSoundKeys', this.root).checked = settings.soundKeys;
    clearInterval(this.rateTimer);
    this.rateTimer = window.setInterval(() => this.updateRate(), 250);
  }

  leave(): void {
    this.active = false;
    clearInterval(this.rateTimer);
    this.stopCal(false);
  }

  private async reconnect(): Promise<void> {
    synth.unlock();
    const s = await this.midi.connect();
    if (s.kind === 'ready') toast(this.midi.primaryName ? `MIDI 준비 완료: ${this.midi.primaryName}` : 'MIDI는 준비됐어요. 건반을 연결해 주세요.');
    else toast(statusHelp(s, 0));
    this.renderStatus();
  }

  private renderStatus(): void {
    const m = this.midi;
    const s = m.status;
    const listening = m.devices.filter((d) => d.connected && m.isListening(d.id));
    const connected = m.devices.filter((d) => d.connected);
    const led = $('#devLed', this.root);
    const state = s.kind === 'ready' ? (listening.length ? 'on' : 'empty') : s.kind === 'unsupported' || s.kind === 'denied' ? 'bad' : 'idle';
    led.dataset.s = state;
    $('#devStatusT', this.root).textContent =
      state === 'on' ? `${listening[0].name}${listening.length > 1 ? ` 외 ${listening.length - 1}대` : ''} 연결됨`
        : state === 'empty' ? (connected.length ? '선택된 건반이 없어요' : 'MIDI 건반이 안 보여요')
          : s.kind === 'unsupported' ? '이 브라우저는 MIDI를 못 써요'
            : s.kind === 'denied' ? 'MIDI 사용이 막혔어요' : 'MIDI 확인 중…';
    $('#devHelp', this.root).textContent = statusHelp(s, connected.length) + (s.kind === 'denied' ? ` (${s.message})` : '');
    const list = $('#devList', this.root);
    list.innerHTML = m.devices.length
      ? m.devices.map((d) => `<li class="${d.connected ? 'on' : 'off'}"><label><input type="checkbox" data-id="${esc(d.id)}" ${m.isListening(d.id) ? 'checked' : ''} ${d.connected ? '' : 'disabled'}><span><b>${esc(d.name)}</b><small>${esc(d.manufacturer || 'MIDI 입력')} · ${d.connected ? '연결됨' : '연결 끊김'}</small></span></label></li>`).join('')
      : `<li class="none">${s.kind === 'ready' ? '연결된 MIDI 입력 기기가 없어요' : '기기 목록은 MIDI가 준비되면 보여요'}</li>`;
  }

  private pickDevices(): void {
    const boxes = [...this.root.querySelectorAll<HTMLInputElement>('#devList input[data-id]')];
    const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.id!);
    const all = this.midi.devices.filter((d) => d.connected).every((d) => ids.includes(d.id));
    this.midi.setSelected(all ? [] : ids.length ? ids : ['__none__']);
  }

  /** Every input event, from main.ts. */
  onInput(e: NoteInput): void {
    if (e.type === 'on') {
      this.keys.down(e.midi);
      this.onTimes.push(e.time);
      if (this.cal) this.tap(e.time);
    } else this.keys.up(e.midi);
    if (!this.active && !this.cal) return;
    if (e.type === 'on') {
      $('#devNote', this.root).textContent = noteName(e.midi);
      $('#devNoteKo', this.root).textContent = `${nKo(e.midi)} · ${SRC[e.source]}`;
      $('#devVel', this.root).style.width = Math.round(e.velocity * 100) + '%';
      $('#devVelN', this.root).textContent = e.source === 'midi' ? String(Math.round(e.velocity * 127)) : '고정';
    }
    const d = new Date(performance.timeOrigin + e.time);
    const ts = `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    const vel = e.type === 'on' ? (e.source === 'midi' ? String(Math.round(e.velocity * 127)).padStart(3) : '  –') : '   ';
    this.log.unshift(`<li><span class="t">${ts}</span><span class="s s-${e.source}">${SRC[e.source]}</span><span class="k">${e.type === 'on' ? '누름' : '뗌'}</span><b>${noteName(e.midi)}</b><span class="v">${vel}</span></li>`);
    this.log.length = Math.min(this.log.length, 8);
    $('#devLog', this.root).innerHTML = this.log.join('');
  }

  private setPedal(down: boolean): void {
    const p = this.root.querySelector('#devPedal');
    if (!p) return;
    p.classList.toggle('on', down);
    $('#devPedalT', this.root).textContent = down ? '밟음' : '떼짐';
  }

  private updateRate(): void {
    const now = performance.now();
    this.onTimes = this.onTimes.filter((t) => now - t <= 1000);
    $('#devRate', this.root).textContent = String(this.onTimes.length);
  }

  private syncOffset(): void {
    const v = settings.offset;
    $('#devCurOff', this.root).textContent = signed(v) + ' ms';
    $<HTMLInputElement>('#devOffset', this.root).value = String(v);
    $('#devOffsetVal', this.root).textContent = signed(v) + ' ms';
  }

  /* ---------------- calibration ---------------- */

  private startCal(): void {
    synth.unlock();
    this.stopCal(false);
    const beatMs = 60000 / CAL_BPM;
    const go = () => {
      const total = CAL_COUNT + CAL_BEATS;
      const perf: number[] = [];
      const ctx = synth.ready ? synth.ctx : null;
      if (ctx) {
        const c0 = ctx.currentTime + 0.5;
        for (let i = 0; i < total; i++) {
          const at = c0 + (i * beatMs) / 1000;
          synth.tick(i === 0 || i === CAL_COUNT, at);
          perf.push(synth.perfTimeOf(at));
        }
      } else {
        const p0 = performance.now() + 500;
        for (let i = 0; i < total; i++) perf.push(p0 + i * beatMs);
      }
      this.cal = { beats: perf, taps: [], end: perf[total - 1] + beatMs * 0.8, idx: -1, raf: 0 };
      this.result = null;
      $('#calApply', this.root).hidden = true;
      $('#calStart', this.root).textContent = '다시 시작';
      this.root.querySelectorAll('.cal-dot').forEach((d) => {
        d.className = 'cal-dot' + (Number((d as HTMLElement).dataset.i) < CAL_COUNT ? ' pre' : '');
        d.querySelector('em')!.textContent = '';
      });
      $('#calMsg', this.root).textContent = ctx ? '준비… 4번 클릭 뒤부터 박마다 눌러요' : '소리가 꺼져 있어요 · 불빛에 맞춰 눌러요';
      const loop = () => {
        if (!this.cal) return;
        const now = performance.now();
        let i = -1;
        while (i + 1 < this.cal.beats.length && this.cal.beats[i + 1] <= now) i++;
        if (i !== this.cal.idx) {
          this.cal.idx = i;
          if (i >= 0) {
            this.root.querySelector(`.cal-dot[data-i="${i}"]`)?.classList.add('lit');
            const p = $('#calPulse', this.root);
            p.classList.remove('beat');
            void p.offsetWidth;
            p.classList.add('beat');
            $('#calMsg', this.root).textContent = i < CAL_COUNT ? ['준비', '3', '2', '1'][i] : `${i - CAL_COUNT + 1} / ${CAL_BEATS}`;
          }
        }
        if (now >= this.cal.end) {
          this.stopCal(true);
          return;
        }
        this.cal.raf = requestAnimationFrame(loop);
      };
      this.cal.raf = requestAnimationFrame(loop);
    };
    // the AudioContext may need a moment to resume after the unlock gesture
    if (synth.ctx && !synth.ready) setTimeout(go, 120);
    else go();
  }

  private tap(time: number): void {
    const c = this.cal;
    if (!c) return;
    const beatMs = 60000 / CAL_BPM;
    const measured = c.beats.slice(CAL_COUNT);
    if (time < measured[0] - beatMs / 2) return; // still counting in
    c.taps.push(time);
    let bi = 0;
    for (let i = 1; i < measured.length; i++) if (Math.abs(measured[i] - time) < Math.abs(measured[bi] - time)) bi = i;
    const d = Math.round(time - measured[bi]);
    const dot = this.root.querySelector(`.cal-dot[data-i="${bi + CAL_COUNT}"]`);
    if (dot && !dot.classList.contains('tap')) {
      dot.classList.add('tap');
      dot.querySelector('em')!.textContent = signed(d);
    }
  }

  private stopCal(evaluate: boolean): void {
    const c = this.cal;
    if (!c) return;
    cancelAnimationFrame(c.raf);
    this.cal = null;
    if (!evaluate) {
      $('#calMsg', this.root).textContent = '시작을 누르면 클릭이 나와요';
      return;
    }
    const r = calibrate(c.taps, c.beats.slice(CAL_COUNT), 60000 / CAL_BPM);
    this.result = r;
    const msg = $('#calMsg', this.root);
    const apply = $<HTMLButtonElement>('#calApply', this.root);
    if (!r) {
      msg.textContent = '박에 맞는 입력이 부족해요. 클릭을 듣고 다시 해 보세요.';
      apply.hidden = true;
      return;
    }
    const off = Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, r.offset));
    msg.textContent = `평균 ${signed(r.offset)}ms ${r.offset > 0 ? '늦게' : r.offset < 0 ? '빨리' : ''} 들어와요 · 흔들림 ±${r.spread}ms · ${r.used}/${CAL_BEATS}박`;
    apply.hidden = false;
    apply.textContent = `${signed(off)} ms 적용`;
  }

  private applyCal(): void {
    if (!this.result) return;
    updateSettings({ offset: this.result.offset });
    this.syncOffset();
    this.onOffsetChange?.();
    toast(`지연 보정을 ${signed(settings.offset)}ms로 맞췄어요.`);
    $('#calApply', this.root).hidden = true;
  }
}
