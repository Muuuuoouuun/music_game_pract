/**
 * KeyStage boot: one InputHub (MIDI + PC keyboard + on-screen keys) feeds every screen;
 * a hash router (#home #import #play #result #device) shows one screen at a time and a
 * single rAF loop drives whichever needs frames.
 */
import './styles/base.css';
import './styles/play.css';
import './styles/screens.css';
import './styles/device.css';
import './styles/responsive.css';
import { synth } from './audio/synth';
import { InputHub } from './input/hub';
import { libraryChanged, songs } from './state/library';
import { loadLastResult, recordsChanged, seedPlan, type ResultData } from './state/records';
import { settings } from './state/settings';
import { DeviceScreen } from './ui/device';
import { $, toast } from './ui/dom';
import { clamp } from './ui/format';
import { HomeScreen } from './ui/home';
import { ImportScreen } from './ui/import';
import { PlayScreen } from './ui/play';
import { ResultScreen } from './ui/result';

type Route = 'home' | 'import' | 'play' | 'result' | 'device';
const ROUTES: Route[] = ['home', 'import', 'play', 'result', 'device'];
let route: Route = 'play';

const hub = new InputHub();
hub.attachKeyboard(window);

const play = new PlayScreen($('#scr-play'), {
  hub,
  isActive: () => route === 'play',
  onFinish: (r, best) => {
    showResult(r);
    if (best) toast(`최고 기록 갱신! ${r.rank} 랭크`);
    go('result');
  },
  onPass: (r) => (pendingResult = r),
});
const result = new ResultScreen($('#scr-result'), {
  retry: (r) => {
    play.applyPlan(r.example ? { songId: play.song?.id ?? r.songId, hands: settings.hands, rate: settings.rate } : { songId: r.songId, hands: r.hands, rate: r.rate, wait: r.wait, loop: r.loop ?? undefined });
  },
  startPlan: (p) => play.applyPlan(p),
  offsetChanged: () => play.settingsUpdated(),
});
const home = new HomeScreen($('#scr-home'), {
  midi: hub.midi,
  currentSongId: () => play.song?.id ?? null,
  prepare: (id, patch) => play.prepare(id, patch),
  play: (id) => {
    if (id !== play.song?.id) play.setSong(id);
    play.startPlay();
  },
  startPlan: (p) => play.applyPlan(p),
  songRemoved: (id) => {
    if (play.song?.id === id) play.setSong(songs()[0]?.id ?? null, true);
  },
});
const importer = new ImportScreen($('#scr-import'), {
  added: (id, patch) => {
    if (patch) {
      play.prepare(id, patch);
      play.startPlay();
    }
  },
});
const device = new DeviceScreen($('#scr-device'), hub);
device.onOffsetChange = () => play.settingsUpdated();

let pendingResult: ResultData | null = loadLastResult();
let resultDirty = true;
function showResult(r: ResultData): void {
  pendingResult = r;
  resultDirty = true;
}

/* ---------------- router ---------------- */

function go(r: Route): void {
  if (location.hash !== '#' + r) location.hash = '#' + r;
  else apply(r);
}

function apply(r: Route): void {
  const prev = route;
  route = r;
  if (prev !== r) {
    if (prev === 'play') play.leave();
    if (prev === 'device') device.leave();
    if (prev === 'import') importer.leave();
  }
  for (const s of ROUTES) {
    $('#scr-' + s).hidden = s !== r;
    $('#tab-' + s).setAttribute('aria-selected', String(s === r));
  }
  if (r === 'play') play.enter();
  if (r === 'home') home.render();
  if (r === 'device') device.enter();
  if (r === 'import') importer.enter();
  if (r === 'result') {
    if (resultDirty) {
      resultDirty = false;
      result.show(pendingResult);
    }
    requestAnimationFrame(() => result.enter());
  }
}

window.addEventListener('hashchange', () => {
  const r = location.hash.slice(1) as Route;
  apply(ROUTES.includes(r) ? r : 'home');
});

/* ---------------- input → sound, screens ---------------- */

hub.on((e) => {
  const sound = e.source === 'midi' ? settings.soundMidi : settings.soundKeys;
  if (e.type === 'on') {
    if (sound) synth.noteOn(e.midi, e.velocity);
  } else synth.noteOff(e.midi);
  play.onInput(e);
  device.onInput(e);
});
hub.midi.onPedal((e) => synth.setPedal(e.down));

const unlock = () => synth.unlock();
window.addEventListener('pointerdown', unlock, true);
window.addEventListener('keydown', (e) => {
  unlock();
  if (route === 'play' && play.handleKey(e)) e.preventDefault();
});

/* ---------------- MIDI status chip ---------------- */

let lastName: string | null = null;
function renderChip(): void {
  const m = hub.midi;
  const name = m.primaryName;
  const chip = $('#devChip');
  const count = m.devices.filter((d) => d.connected && m.isListening(d.id)).length;
  chip.classList.toggle('on', !!name);
  chip.classList.toggle('warn', !name && (m.status.kind === 'denied' || m.status.kind === 'unsupported'));
  $('span', chip).textContent = name
    ? `MIDI · ${name}${count > 1 ? ` 외 ${count - 1}대` : ''}`
    : m.status.kind === 'denied' ? 'MIDI 막힘 · PC 키보드로 플레이 중' : 'PC 키보드로 플레이 중';
  document.querySelector('.tabs')?.classList.toggle('midi-on', !!name);
  if (name && name !== lastName) toast(`MIDI 건반 연결됨: ${name}`);
  else if (!name && lastName) toast('MIDI 건반 연결이 끊겼어요. PC 키보드로 계속할 수 있어요.');
  lastName = name;
}
hub.midi.onChange(renderChip);

/* ---------------- shared tooltip for [data-tip] ---------------- */

const tip = $('#tip');
function showTip(el: HTMLElement): void {
  tip.textContent = el.dataset.tip ?? '';
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const tw = tip.offsetWidth;
  tip.style.left = clamp(r.left + r.width / 2 - tw / 2, 8, innerWidth - tw - 8) + 'px';
  tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + 'px';
}
for (const ev of ['pointerover', 'focusin'] as const) {
  document.addEventListener(ev, (e) => {
    const el = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    if (el) showTip(el);
    else tip.hidden = true;
  });
}

/* ---------------- boot ---------------- */

play.mount();
result.mount();
home.mount();
importer.mount();
device.mount();
renderChip();

const first = songs()[0];
if (first) seedPlan(first.id);
play.setSong(settings.songId, true);
libraryChanged.on(() => route === 'home' && home.render());
recordsChanged.on(() => route === 'home' && home.render());

const initial = location.hash.slice(1) as Route;
apply(ROUTES.includes(initial) ? initial : 'play');

// Ask for MIDI right away; Chrome may show a permission prompt, and the device
// screen's 다시 연결 button retries from a user gesture.
void hub.midi.connect();

let lastNow = 0;
let frameErr = false;
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(64, now - (lastNow || now));
  lastNow = now;
  try {
    if (route === 'play') play.frame(now, dt);
  } catch (e) {
    if (!frameErr) {
      frameErr = true;
      console.error(e);
    }
  }
}
requestAnimationFrame(frame);
