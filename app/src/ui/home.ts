/** Home: keyboard connection card, song shelf, today's practice plan and quick reference. */
import type { HandMode } from '../core/engine';
import type { MidiInput } from '../input/midi';
import { PC_LABEL } from '../input/hub';
import { noteName } from '../core/chart';
import { LANE_HUE, laneLayout } from '../render/lanes';
import { getSong, removeUserSong, songs, type LibrarySong } from '../state/library';
import { forgetSong, getBest, plan, removePlan, type PlanItem } from '../state/records';
import { HANDS_KO, settings, type Settings } from '../state/settings';
import { $, ICON, esc, toast } from './dom';
import { commas } from './format';

const DIFFS: Record<'easy' | 'normal' | 'orig', { hands: HandMode; rate: number; label: string }> = {
  easy: { hands: 'R', rate: 0.75, label: 'EASY' },
  normal: { hands: 'R', rate: 1, label: 'NORMAL' },
  orig: { hands: 'B', rate: 1, label: 'ORIGINAL' },
};

export interface HomeDeps {
  midi: MidiInput;
  currentSongId(): string | null;
  /** Load a song with settings and show the attract demo. */
  prepare(songId: string, patch: Partial<Settings>): void;
  /** Start playing a song right away with the current settings. */
  play(songId: string): void;
  startPlan(p: PlanItem): void;
  songRemoved(id: string): void;
}

export class HomeScreen {
  private root: HTMLElement;
  private deps: HomeDeps;

  constructor(root: HTMLElement, deps: HomeDeps) {
    this.root = root;
    this.deps = deps;
  }

  mount(): void {
    this.root.innerHTML = `
    <div class="wrap">
      <div class="home-head">
        <div>
          <p class="eyebrow">STAGE SELECT</p>
          <h1 class="h-disp">진짜 건반이 컨트롤러다.</h1>
          <p class="lede">전자피아노나 MIDI 건반을 연결하고, 악보와 떨어지는 노트를 함께 보며 직접 연주하세요. 건반이 없으면 PC 키보드나 화면 건반으로도 칠 수 있어요.</p>
        </div>
        <div class="head-side"><a class="btn ghost" href="#import">+ 새 곡 만들기</a></div>
      </div>
      <a class="dev-card" id="homeDev" href="#device" aria-label="건반 연결 확인"></a>
      <div class="shelf" id="shelf" role="list" aria-label="곡 목록"></div>
      <p class="shelf-note">난이도 칸을 누르면 그 설정으로 데모가 준비되고, 무대 시작을 누르면 바로 카운트가 시작돼요.</p>
      <div class="home-info">
        <div class="info plan">
          <h2>오늘의 연습</h2>
          <ol class="plan-list" id="planList"></ol>
          <p class="shelf-note" style="margin-top:10px">결과 화면의 AI 코치 추천을 여기에 추가할 수 있어요.</p>
        </div>
        <div class="info">
          <h2>PC 키보드 배치</h2>
          <div class="kmap" id="kmap" aria-label="PC 키와 건반 대응표"></div>
          <p class="shelf-note" style="margin-top:10px">Z X C V B N M 은 C3–B3 흰 건반이에요. 화면 건반을 눌러도 돼요.</p>
        </div>
        <div class="info">
          <h2>판정 기준</h2>
          <table class="jtable"><tbody>
            <tr><td class="jname" style="color:var(--j-perfect)">PERFECT</td><td>±45 ms</td><td>× 1.0</td></tr>
            <tr><td class="jname" style="color:var(--j-great)">GREAT</td><td>±90 ms</td><td>× 0.7</td></tr>
            <tr><td class="jname" style="color:var(--j-good)">GOOD</td><td>±140 ms</td><td>× 0.4</td></tr>
            <tr><td class="jname" style="color:var(--j-miss)">MISS</td><td>+140 ms 지남</td><td>× 0</td></tr>
            <tr><td class="jname" style="color:var(--j-wrong)">WRONG</td><td>없는 음</td><td>콤보 끊김</td></tr>
          </tbody></table>
        </div>
      </div>
    </div>`;
    this.buildKmap();
    $('#shelf', this.root).addEventListener('click', (e) => this.onShelf(e));
    $('#planList', this.root).addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-plan],[data-unplan]');
      if (!b) return;
      if (b.dataset.unplan) {
        removePlan(b.dataset.unplan);
        this.renderPlan();
        return;
      }
      const p = plan.find((x) => x.id === b.dataset.plan);
      if (p) this.deps.startPlan(p);
    });
    this.deps.midi.onChange(() => this.renderDevice());
  }

  render(): void {
    this.renderDevice();
    this.renderShelf();
    this.renderPlan();
  }

  renderDevice(): void {
    const m = this.deps.midi;
    const s = m.status;
    const name = m.primaryName;
    const state = name ? 'on' : s.kind === 'unsupported' || s.kind === 'denied' ? 'bad' : s.kind === 'ready' ? 'empty' : 'idle';
    const title = name
      ? `${name} 연결됨`
      : s.kind === 'unsupported' ? '이 브라우저에서는 MIDI를 못 써요'
        : s.kind === 'denied' ? 'MIDI 사용이 막혀 있어요'
          : s.kind === 'ready' ? 'MIDI 건반이 안 보여요' : 'MIDI 건반 찾는 중…';
    const sub = name
      ? '건반을 누르면 바로 판정돼요. 소리가 늦게 들리면 지연 보정을 해 두세요.'
      : s.kind === 'unsupported' ? '컴퓨터의 Chrome이나 Edge에서 열면 전자피아노를 연결할 수 있어요. 지금은 PC 키보드로 플레이해요.'
        : s.kind === 'denied' ? '주소창 왼쪽 사이트 설정에서 MIDI 기기를 허용해 주세요. 지금은 PC 키보드로 플레이해요.'
          : s.kind === 'ready' ? 'USB 케이블로 전자피아노를 연결하고 전원을 켜 주세요. 없으면 PC 키보드로 플레이해요.'
            : '브라우저가 MIDI 기기 사용을 물으면 허용을 눌러 주세요. 그동안 PC 키보드로 플레이할 수 있어요.';
    $('#homeDev', this.root).innerHTML = `
      <span class="dev-led" data-s="${state}"></span>
      <span class="dev-card-t"><span class="lbl">건반 연결</span><b>${esc(title)}</b><small>${sub}</small></span>
      <span class="btn sm">${name ? '입력 확인 · 지연 보정' : '연결 도우미'}</span>`;
  }

  private renderShelf(): void {
    const cur = this.deps.currentSongId();
    const list = songs();
    $('#shelf', this.root).innerHTML = list.map((s) => this.card(s, s.id === cur)).join('');
  }

  private card(s: LibrarySong, feature: boolean): string {
    const levels = [Math.max(1, s.level - 1), s.level, Math.min(10, s.level + 2)];
    const pips = (['easy', 'normal', 'orig'] as const)
      .map((d, i) => {
        const on = feature && DIFFS[d].hands === settings.hands && DIFFS[d].rate === settings.rate && !settings.wait && !settings.loop.on;
        return `<button class="pip" type="button" data-song="${esc(s.id)}" data-d="${d}" aria-pressed="${on}"><b>${DIFFS[d].label}</b><span class="lvbar" style="--lv:${levels[i]}"></span><span class="lv">Lv.${levels[i]}</span></button>`;
      })
      .join('');
    const bests = (['R', 'L', 'B'] as const).map((h) => ({ h, b: getBest(s.id, h) }));
    const top = bests.filter((x) => x.b).sort((a, b) => b.b!.score - a.b!.score)[0]?.b ?? null;
    const rows = bests
      .map(({ h, b }) => `<span class="bh"><em>${HANDS_KO[h]}</em>${b ? `<i class="rk" data-r="${b.rank}">${b.rank}</i><b>${commas(b.score)}</b>${b.rate < 1 ? `<small>${Math.round(b.rate * 100)}%</small>` : ''}` : '<b class="none">–</b>'}</span>`)
      .join('');
    return `<article class="card${feature ? ' feature' : ''}" role="listitem" data-song="${esc(s.id)}">
      <div class="cover art-${s.art}" data-mark="${esc(s.mark)}"><span class="rank-badge" data-r="${top ? top.rank : '-'}">${top ? top.rank : '–'}</span><span class="cover-title">${esc(s.title)}</span></div>
      <div class="card-body">
        <h3>${esc(s.title)}${s.builtin ? '' : ' <span class="newtag">가져온 곡</span>'}</h3><p class="comp">${esc(s.composer)}</p>
        <p class="meta"><span>BPM ${s.bpm}</span><span>${esc(s.timeSignature)}</span><span>${s.measures}마디</span></p>
        <div class="pips" role="group" aria-label="난이도">${pips}</div>
        <div class="best-grid" aria-label="손 모드별 최고 기록">${rows}</div>
        <div class="card-actions">
          <button class="btn cta" type="button" data-play="${esc(s.id)}">${ICON.play}무대 시작</button>
          ${s.builtin ? '' : `<button class="btn sm ghost del" type="button" data-del="${esc(s.id)}" aria-label="${esc(s.title)} 삭제" title="곡 목록에서 지우기">삭제</button>`}
        </div>
      </div></article>`;
  }

  private onShelf(e: Event): void {
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.d && b.dataset.song) {
      const d = DIFFS[b.dataset.d as keyof typeof DIFFS];
      this.deps.prepare(b.dataset.song, { hands: d.hands, rate: d.rate, wait: false, loop: { ...settings.loop, on: false } });
      toast(`${d.label} · ${HANDS_KO[d.hands]} · 템포 ${d.rate * 100}%로 준비했어요.`);
      location.hash = '#play';
    } else if (b.dataset.play) {
      this.deps.play(b.dataset.play);
    } else if (b.dataset.del) {
      const s = getSong(b.dataset.del);
      if (!s || !confirm(`'${s.title}'을(를) 곡 목록에서 지울까요? 기록도 함께 지워져요.`)) return;
      removeUserSong(s.id);
      forgetSong(s.id);
      this.deps.songRemoved(s.id);
      toast(`'${s.title}'을(를) 지웠어요.`);
      this.render();
    }
  }

  renderPlan(): void {
    const el = $('#planList', this.root);
    if (!plan.length) {
      el.innerHTML = '<li class="plan-empty"><div><b>오늘의 연습이 비어 있어요</b><span>한 곡을 끝까지 치면 AI 코치가 연습 거리를 골라 줘요.</span></div></li>';
      return;
    }
    el.innerHTML = plan
      .map((p) => {
        const song = getSong(p.songId);
        const sub = (song && song.id !== this.deps.currentSongId() ? song.title + ' · ' : '') + p.sub;
        return `<li><div><b>${esc(p.title)}${p.isNew ? ' <span class="newtag">AI 추천</span>' : ''}</b><span>${esc(sub)}</span></div><span class="plan-btns"><button class="btn sm" type="button" data-plan="${esc(p.id)}">시작</button><button class="btn sm ghost" type="button" data-unplan="${esc(p.id)}" aria-label="목록에서 빼기" title="목록에서 빼기">×</button></span></li>`;
      })
      .join('');
  }

  private buildKmap(): void {
    const L = laneLayout(60, 76);
    let html = '';
    for (let m = 60; m <= 76; m++) {
      const ln = L.lane[m];
      html += `<span class="${ln.b ? 'b' : 'w'}" style="left:${ln.l * 100}%;width:${ln.w * 100}%;--h:${LANE_HUE[m % 12]}">${PC_LABEL[m] ?? ''}${ln.b ? '' : `<small>${noteName(m)}</small>`}</span>`;
    }
    $('#kmap', this.root).innerHTML = html;
  }
}
