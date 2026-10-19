/*
 * Bisca – interface (DOM, animações e fluxo da partida).
 * Depende de engine.js (window.Bisca) e ai.js (window.BiscaAI).
 */
(() => {
  'use strict';

  const B = window.Bisca;
  const AI = window.BiscaAI;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------------------------------------------ */
  /*  Configurações                                                      */
  /* ------------------------------------------------------------------ */

  const DEFAULTS = { mode: '1v1', level: 'medium', rules: 'classic', target: 2, p120: 4, hs: 3, live: true, speed: 'normal' };
  const SPEED = { slow: 1.6, normal: 1, fast: 0.5 };
  const STORE_KEY = 'bisca.settings.v1';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return Object.assign({}, DEFAULTS, raw);
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* sem armazenamento */ }
  }
  const settings = loadSettings();

  const speed = () => (reduceMotion ? 0.01 : SPEED[settings.speed] || 1);

  /* ------------------------------------------------------------------ */
  /*  Estado da interface                                                */
  /* ------------------------------------------------------------------ */

  const ui = {
    gen: 0,            // invalida temporizadores ao reiniciar/sair
    match: null,
    H: null,           // mão atual (motor)
    humanTurn: false,
    paused: 0,         // diálogos abertos
    handEls: new Map(),
    knockGen: -1,      // mão aguardando a decisão de bater no baralho
    stockShown: 0,
    trumpShown: false
  };

  const POS = { 2: ['s', 'n'], 4: ['s', 'e', 'n', 'w'] };
  const posOf = (p) => POS[ui.match.n][p];

  function nameOf(p) {
    if (ui.match.n === 2) return p === 0 ? 'Você' : 'Computador';
    return ['Você', 'Rival 1', 'Parceiro', 'Rival 2'][p];
  }
  function teamName(t) {
    if (ui.match.n === 2) return t === 0 ? 'Você' : 'Computador';
    return t === 0 ? 'Nós' : 'Eles';
  }

  /** Executa fn depois de ms (escalado pela velocidade), a menos que a partida mude/pause. */
  function later(ms, fn) {
    const g = ui.gen;
    const wait = Math.max(0, ms * speed());
    const tick = () => {
      if (g !== ui.gen) return;
      if (ui.paused) { setTimeout(tick, 150); return; }
      fn();
    };
    setTimeout(tick, wait);
  }

  /* ------------------------------------------------------------------ */
  /*  Construção das cartas                                              */
  /* ------------------------------------------------------------------ */

  const PIPS = {
    '2': [[50, 24], [50, 76]],
    '3': [[50, 24], [50, 50], [50, 76]],
    '4': [[39, 24], [61, 24], [39, 76], [61, 76]],
    '5': [[39, 24], [61, 24], [50, 50], [39, 76], [61, 76]],
    '6': [[39, 24], [61, 24], [39, 50], [61, 50], [39, 76], [61, 76]],
    '7': [[39, 24], [61, 24], [50, 37], [39, 50], [61, 50], [39, 76], [61, 76]]
  };

  const svgSuit = (su, cls = '', style = '') =>
    `<svg class="suit ${cls}" ${style ? `style="${style}"` : ''} aria-hidden="true"><use href="#s-${su}"/></svg>`;

  function cardEl(c, tag = 'div') {
    const su = B.SUITS[B.suitOf(c)];
    const r = B.RANKS[B.strOf(c)];
    const el = document.createElement(tag);
    if (tag === 'button') el.type = 'button';
    el.className = 'card face ' + (su === 'H' || su === 'D' ? 'red' : 'black');
    el.dataset.id = String(c);
    el.setAttribute('aria-label', B.cardName(c));
    let center;
    if (r === 'A') center = svgSuit(su, 'ace');
    else if (PIPS[r]) {
      center = PIPS[r].map(([x, y]) => svgSuit(su, 'pip' + (y > 50 ? ' flip' : ''), `left:${x}%;top:${y}%`)).join('');
    } else {
      center = `<span class="court">${svgSuit(su)}<span class="letter">${r}</span>${svgSuit(su)}</span>`;
    }
    el.innerHTML =
      `<span class="corner tl"><b>${r}</b>${svgSuit(su)}</span>` +
      `<span class="corner br"><b>${r}</b>${svgSuit(su)}</span>` + center;
    return el;
  }

  function backEl() {
    const el = document.createElement('div');
    el.className = 'card back';
    return el;
  }

  /* ------------------------------------------------------------------ */
  /*  Animações (Web Animations API)                                     */
  /* ------------------------------------------------------------------ */

  const EASE = 'cubic-bezier(.2,.8,.25,1)';

  function flyFrom(el, from, opts = {}) {
    const to = el.getBoundingClientRect();
    if (!to.width) return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const sc = from.width / to.width;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${sc})` }, { transform: 'none' }],
      { duration: Math.max(1, (opts.dur || 380) * speed()), delay: (opts.delay || 0) * speed(), easing: EASE, fill: 'backwards' }
    );
  }

  /** Reposiciona suavemente um elemento que mudou de lugar (técnica FLIP). */
  function flipFrom(el, from) {
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 260 * speed() + 1, easing: EASE });
  }

  function flyAway(el, target, dur) {
    const from = el.getBoundingClientRect();
    const dx = target.left + target.width / 2 - (from.left + from.width / 2);
    const dy = target.top + target.height / 2 - (from.top + from.height / 2);
    const a = el.animate(
      [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.5)`, opacity: 0 }],
      { duration: Math.max(1, dur * speed()), easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }
    );
    a.onfinish = () => el.remove();
    a.oncancel = () => el.remove();
  }

  /* ------------------------------------------------------------------ */
  /*  Renderização                                                       */
  /* ------------------------------------------------------------------ */

  function setStatus(html) { $('#status').innerHTML = '<span>' + html + '</span>'; }

  function showScreen(id) {
    $('#menu').classList.toggle('hidden', id !== 'menu');
    $('#game').classList.toggle('hidden', id !== 'game');
  }

  function buildTable() {
    const m = ui.match;
    $('#table').dataset.n = String(m.n);
    $('#game').dataset.n = String(m.n);
    $('#game').style.setProperty('--hs', String(m.hs));
    $('#team-0 .tname').textContent = teamName(0);
    $('#team-1 .tname').textContent = teamName(1);
  }

  function resetTable() {
    ui.handEls.clear();
    $('#hand-s').innerHTML = '';
    ['n', 'e', 'w'].forEach((p) => { $('#hand-' + p).innerHTML = ''; });
    ['n', 'e', 'w', 's'].forEach((p) => { $('#slot-' + p).innerHTML = ''; });
    $('#trumpcard').innerHTML = '';
    $('#stack').querySelectorAll('.card').forEach((e) => e.remove());
    setHumanTurn(false);
  }

  function renderNameplates() {
    const m = ui.match, H = ui.H;
    for (let p = 0; p < m.n; p++) {
      const pos = posOf(p);
      const el = $('#np-' + pos);
      el.className = 'nameplate' + (p === 0 ? ' me' : '') + (H && H.turn === p ? ' active' : '');
      el.innerHTML = `<span class="who">${nameOf(p)}</span>` +
        (m.dealer === p ? '<span class="badge" title="Carteador">D</span>' : '');
    }
  }

  function renderTrumpChip() {
    const H = ui.H;
    const su = B.SUITS[H.trump];
    const chip = $('#trump-chip');
    chip.className = 'chip trump-chip' + (su === 'H' || su === 'D' ? ' red' : '');
    chip.innerHTML = `Trunfo ${svgSuit(su)} ${B.SUIT_NAMES[su]}`;
  }

  function renderScores(reveal) {
    const m = ui.match, H = ui.H;
    const show = settings.live || reveal || (H && H.over);
    const p0 = show ? H.pts[0] : '–';
    const p1 = show ? H.pts[1] : '–';
    $('#pts-0').textContent = p0;
    $('#pts-1').textContent = p1;
    $('#team-0').classList.toggle('lead', !!show && H.pts[0] > H.pts[1]);
    $('#team-1').classList.toggle('lead', !!show && H.pts[1] > H.pts[0]);
    if (m.rules === 'capixaba') {
      const sp = matchScore();
      $('#matchinfo').innerHTML = `Mão ${m.handNo} &middot; Pontos ${sp[0]}–${sp[1]}<br>capixaba, até ${m.target}`;
    } else {
      $('#matchinfo').innerHTML = `Mão ${m.handNo} &middot; Jogos ${m.sets[0]}–${m.sets[1]}<br>${matchFormat()}`;
    }
  }

  const matchFormat = () => {
    const m = ui.match;
    if (m.rules === 'capixaba') return `capixaba, até ${m.target} pontos`;
    return m.target === 1 ? 'jogo único' : m.target === 2 ? 'melhor de 3' : 'melhor de 5';
  };

  /** Placar da partida contando os pontos extras já ganhos na mão em andamento. */
  function matchScore() {
    const m = ui.match, H = ui.H;
    if (!H || H.applied || H.rules !== 'capixaba') return m.sets.slice();
    return [m.sets[0] + H.bonus[0], m.sets[1] + H.bonus[1]];
  }

  /** Monte (pilha de costas + contador) e carta do trunfo virada embaixo. */
  function renderStock() {
    const H = ui.H;
    const left = ui.stockShown;
    const stack = $('#stack');
    stack.querySelectorAll('.card').forEach((e) => e.remove());
    const others = left - (ui.trumpShown ? 1 : 0);
    const layers = Math.min(3, others);
    for (let i = 0; i < layers; i++) {
      const b = backEl();
      b.style.translate = `${(layers - 1 - i) * -2}px ${(layers - 1 - i) * -2}px`;
      stack.insertBefore(b, stack.firstChild);
    }
    stack.style.display = others > 0 ? '' : 'none';
    $('#stockcount').textContent = left;
    const tc = $('#trumpcard');
    if (ui.trumpShown && !tc.firstChild) tc.appendChild(cardEl(H.trumpCard));
    if (!ui.trumpShown) tc.innerHTML = '';
    $('#stocklabel').textContent = left > 0 ? (others > 0 ? 'Monte' : 'Trunfo') : 'Monte vazio';
  }

  const handCmp = (trump) => (a, b) => {
    const ka = (B.suitOf(a) === trump ? 0 : 1 + B.suitOf(a)) * 20 - B.strOf(a);
    const kb = (B.suitOf(b) === trump ? 0 : 1 + B.suitOf(b)) * 20 - B.strOf(b);
    return ka - kb;
  };

  /**
   * Ajusta o tamanho das cartas ao espaço da tela: maior tamanho em que a vaza, o monte e a mão
   * cabem sem se sobrepor. Em telas muito baixas usa a vaza "compacta" (cartas sobrepostas).
   */
  function fitCards() {
    const game = $('#game');
    if (game.classList.contains('hidden') || !ui.H) return;
    const table = $('#table'), seatS = $('#seat-s');
    const k = ui.H.hs;
    const fits = (cw) => {
      const t = $('#trick').getBoundingClientRect();
      const c = $('#center').getBoundingClientRect();
      const s = $('#stockzone').getBoundingClientRect();
      return t.height <= c.height + 1 &&
        c.width / 2 - t.width / 2 >= s.width + 6 &&
        table.scrollHeight <= table.clientHeight + 1 &&
        cw * (1 + (k - 1) * 0.34) <= seatS.clientWidth;
    };
    const search = () => {
      game.style.removeProperty('--cwb');
      const hi0 = $('.stackwrap').offsetWidth / 0.72; // limite definido pelo CSS
      let lo = 28, hi = hi0;
      game.style.setProperty('--cwb', hi + 'px');
      if (fits(hi)) return hi;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        game.style.setProperty('--cwb', mid + 'px');
        if (fits(mid)) lo = mid; else hi = mid;
      }
      return lo;
    };
    game.classList.remove('compact');
    let cw = search();
    if (cw < 60) {
      game.classList.add('compact');
      const cw2 = search();
      if (cw2 > cw + 4) cw = cw2; else game.classList.remove('compact');
    }
    game.style.setProperty('--cwb', cw + 'px');
    layoutHand();
  }

  function layoutHand() {
    const hand = $('#hand-s');
    const els = Array.from(hand.children);
    const k = els.length;
    if (!k) return;
    const cw = els[0].offsetWidth;
    const avail = $('#seat-s').clientWidth - 8;
    const gap = Math.round(cw * 0.14);
    let ml = gap;
    if (k > 1 && k * cw + (k - 1) * gap > avail) ml = (avail - k * cw) / (k - 1);
    els.forEach((el, i) => { el.style.marginLeft = i ? ml + 'px' : '0'; });
  }

  /**
   * Sincroniza a mão do jogador com o estado do motor.
   * drawn: { [cardId]: {rect, delay} } – cartas recém compradas animadas a partir do monte.
   */
  function syncHand(drawn = {}) {
    const H = ui.H;
    const hand = $('#hand-s');
    const before = new Map();
    ui.handEls.forEach((el, id) => before.set(id, el.getBoundingClientRect()));
    const ids = H.hands[0].slice().sort(handCmp(H.trump));
    const keep = new Set(ids);
    ui.handEls.forEach((el, id) => { if (!keep.has(id)) { el.remove(); ui.handEls.delete(id); } });
    ids.forEach((id) => {
      let el = ui.handEls.get(id);
      if (!el) {
        el = cardEl(id, 'button');
        if (B.suitOf(id) === H.trump) el.classList.add('trump-suit');
        ui.handEls.set(id, el);
      }
      hand.appendChild(el); // reordena
    });
    layoutHand();
    ids.forEach((id, i) => {
      const el = ui.handEls.get(id);
      el.dataset.idx = String(i + 1);
      if (drawn[id]) flyFrom(el, drawn[id].rect, { dur: 420, delay: drawn[id].delay });
      else if (before.has(id)) flipFrom(el, before.get(id));
    });
  }

  function setHumanTurn(on) {
    ui.humanTurn = on;
    $('#hand-s').classList.toggle('my-turn', on);
  }

  /* ------------------------------------------------------------------ */
  /*  Fluxo da partida                                                   */
  /* ------------------------------------------------------------------ */

  function startMatch() {
    ui.gen++;
    closeAllDialogs();
    ui.H = null;
    ui.match = B.newMatch({
      n: settings.mode === '2v2' ? 4 : 2, hs: settings.hs, target: settings.target,
      rules: settings.rules, p120: settings.p120
    });
    showScreen('game');
    buildTable();
    beginHand();
  }

  /** Na capixaba, quem corta decide antes da distribuição se bate no baralho (Copas vira trunfo). */
  function beginHand() {
    ui.gen++;
    const m = ui.match;
    if (m.rules !== 'capixaba') { dealHand(false); return; }
    const cutter = B.cutterOf(m);
    if (cutter !== 0) { dealHand(AI.decideKnock(m, cutter, Math.random)); return; }
    const g = ui.gen;
    resetTable();
    renderNameplates();    $('#trump-chip').innerHTML = '';
    [0, 1].forEach((t) => { $('#pts-' + t).textContent = '0'; $('#team-' + t).classList.remove('lead'); });
    $('#matchinfo').innerHTML = `Mão ${m.handNo + 1} &middot; Pontos ${m.sets[0]}–${m.sets[1]}<br>capixaba, até ${m.target}`;
    setStatus('Você corta o baralho.');
    $('#knock-score').innerHTML = `Placar: <b>${teamName(0)} ${m.sets[0]}</b> × <b>${m.sets[1]} ${teamName(1)}</b> (até ${m.target})`;
    ui.knockGen = g;
    openDialog(dlgs.knock);
  }

  function answerKnock(knocked) {
    dlgs.knock.close();
    if (ui.knockGen !== ui.gen) return;
    ui.knockGen = -1;
    dealHand(knocked);
  }

  function dealHand(knocked) {
    ui.gen++;
    const m = ui.match;
    const H = (ui.H = B.startHand(m, Math.random, knocked));
    resetTable();
    ui.stockShown = H.stock.length;
    ui.trumpShown = true;
    renderTrumpChip();
    renderNameplates();
    renderScores();
    renderStock();
    fitCards();

    // distribui: comprador à direita do carteador primeiro, uma carta por vez
    const stackRect = $('#stack').getBoundingClientRect();
    const stagger = H.hs * H.n > 20 ? 42 : 75;
    syncHand();
    for (let p = 0; p < H.n; p++) {
      const order = (p - m.dealer - 1 + H.n) % H.n; // 0 = primeiro a receber
      if (p === 0) {
        const sorted = H.hands[0].slice().sort(handCmp(H.trump));
        sorted.forEach((id) => {
          const j = H.hands[0].indexOf(id); // ordem em que foi dada
          flyFrom(ui.handEls.get(id), stackRect, { dur: 460, delay: (j * H.n + order) * stagger });
        });
      } else {
        const box = $('#hand-' + posOf(p));
        for (let j = 0; j < H.hs; j++) {
          const b = backEl();
          box.appendChild(b);
          flyFrom(b, stackRect, { dur: 460, delay: (j * H.n + order) * stagger });
        }
      }
    }
    const tc = $('#trumpcard .card');
    if (tc) tc.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }],
      { duration: 400 * speed() + 1, delay: H.hs * H.n * stagger * speed(), fill: 'backwards' });

    const lead = nameOf(H.leader);
    const knock = H.knocked ? `<b>${nameOf(B.cutterOf(m))}</b> bateu no baralho: trunfo de Copas! ` : '';
    setStatus(`${knock}Mão ${m.handNo}: <b>${lead}</b> abre a primeira vaza.`);
    later(H.hs * H.n * stagger + 700, nextStep);
  }

  function nextStep() {
    const H = ui.H;
    renderNameplates();
    if (H.over) { endHand(); return; }
    if (H.turn < 0) { setStatus('&nbsp;'); later(850, collect); return; }
    if (H.turn === 0) {
      setHumanTurn(true);
      setStatus(H.trick.length ? 'Sua vez: escolha uma carta.' : 'Sua vez: abra a vaza com uma carta.');
      return;
    }
    const p = H.turn;
    setStatus(`<b>${nameOf(p)}</b> está pensando…`);
    later(520 + Math.random() * 520, () => {
      const c = AI.choose(H, p, settings.level, Math.random);
      playCard(p, c);
    });
  }

  function humanPlay(c) {
    if (!ui.humanTurn || ui.H.turn !== 0 || !ui.handEls.has(c)) return;
    setHumanTurn(false);
    playCard(0, c);
  }

  function setPose(el) {
    const r = (a) => (Math.random() * 2 - 1) * a;
    el.style.setProperty('--rot', r(6).toFixed(1) + 'deg');
    el.style.setProperty('--tx', r(5).toFixed(1) + 'px');
    el.style.setProperty('--ty', r(5).toFixed(1) + 'px');
  }

  function playCard(p, c) {
    const H = ui.H;
    const pos = posOf(p);
    let from;
    if (p === 0) {
      const el = ui.handEls.get(c);
      from = el.getBoundingClientRect();
      el.remove();
      ui.handEls.delete(c);
    } else {
      const last = $('#hand-' + pos).lastElementChild;
      from = last.getBoundingClientRect();
      last.remove();
    }
    B.play(H, c);
    const el = cardEl(c);
    setPose(el);
    $('#slot-' + pos).appendChild(el);
    flyFrom(el, from, { dur: 420 });
    if (p === 0) syncHand();
    nextStep();
  }

  function collect() {
    const H = ui.H;
    const res = B.resolveTrick(H);
    const winPos = posOf(res.winner);
    const winCard = $('#slot-' + winPos + ' .card');
    if (winCard) winCard.classList.add('winner');
    const pts = res.points ? `+${res.points} ponto${res.points > 1 ? 's' : ''}` : 'sem pontos';
    const extras = res.events.map((ev) =>
      ` <span class="extra">${ev.label}! +${ev.points} para ${teamName(ev.team)}</span>`).join('');
    setStatus(`<b>${nameOf(res.winner)}</b> levou a vaza (${pts}).${extras}`);
    renderScores();
    if (extras) $('#matchinfo').animate([{ color: 'var(--gold)' }, { color: '' }], { duration: 1600 * speed() + 1 });
    later(extras ? 2200 : 900, () => {
      const target = $('#np-' + winPos).getBoundingClientRect();
      $$('#trick .card').forEach((el) => flyAway(el, target, 460));
      later(500, () => afterCollect(res));
    });
  }

  function afterCollect(res) {
    const H = ui.H;
    if (H.over) { endHand(); return; }
    const stackRect = $('#stack').getBoundingClientRect();
    const trumpEl = $('#trumpcard .card');
    const trumpRect = trumpEl ? trumpEl.getBoundingClientRect() : stackRect;
    const drawnHuman = {};
    res.draws.forEach((d, k) => {
      const isTrump = d.c === H.trumpCard;
      const rect = isTrump ? trumpRect : stackRect;
      const delay = k * 130;
      ui.stockShown--;
      if (isTrump) ui.trumpShown = false;
      if (d.p === 0) drawnHuman[d.c] = { rect, delay };
      else {
        const b = backEl();
        $('#hand-' + posOf(d.p)).appendChild(b);
        flyFrom(b, rect, { dur: 420, delay });
      }
    });
    syncHand(drawnHuman);
    renderStock();
    later(res.draws.length * 130 + 450, nextStep);
  }

  function endHand() {
    const H = ui.H, m = ui.match;
    setHumanTurn(false);
    const w = B.finishHand(m, H);
    renderNameplates();
    renderScores(true);
    setStatus('Fim da mão.');
    later(700, () => showResult(w));
  }

  /* ------------------------------------------------------------------ */
  /*  Diálogos                                                           */
  /* ------------------------------------------------------------------ */

  const dlgs = {
    result: $('#dlg-result'), rules: $('#dlg-rules'), settings: $('#dlg-settings'), quit: $('#dlg-quit'), knock: $('#dlg-knock')
  };

  function closeAllDialogs() {
    Object.values(dlgs).forEach((d) => { if (d && d.open) d.close(); });
  }
  function openDialog(d) {
    if (d && !d.open) d.showModal();
  }
  Object.values(dlgs).forEach((d) => {
    if (!d) return;
    d.addEventListener('close', () => { ui.paused = Math.max(0, ui.paused - (d.dataset.counted ? 1 : 0)); delete d.dataset.counted; });
  });
  function pauseFor(d) { d.dataset.counted = '1'; ui.paused++; }

  // O resultado da mão e o corte exigem uma escolha: Esc não fecha.
  dlgs.result.addEventListener('cancel', (e) => e.preventDefault());
  dlgs.knock.addEventListener('cancel', (e) => e.preventDefault());

  function showResult(w) {
    const H = ui.H, m = ui.match;
    const two = m.n === 2;
    let title;
    if (m.over) {
      title = m.winner === 0 ? (two ? 'Você venceu a partida!' : 'Sua dupla venceu a partida!')
        : (two ? 'O computador venceu a partida' : 'A dupla adversária venceu a partida');
    } else if (w === 0) title = two ? 'Você venceu a mão!' : 'Sua dupla venceu a mão!';
    else if (w === 1) title = two ? 'O computador venceu a mão' : 'A dupla adversária venceu a mão';
    else if (H.reason === 'match') title = 'Partida empatada nos pontos extras';
    else title = 'Mão empatada: 60 a 60';
    $('#result-title').textContent = title;
    $('#result-sub').textContent = H.reason === 'early'
      ? 'A mão terminou antes do fim das cartas: passou de 60 pontos.'
      : H.reason === 'match' ? 'Os pontos extras fecharam a partida antes do fim da mão.'
        : 'Todas as cartas foram jogadas.';

    const lines = $('#result-lines');
    lines.innerHTML = '';
    if (m.rules === 'capixaba') {
      w.lines.forEach((ln) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${ln.label}</span><b>${teamName(ln.team)} +${ln.points}</b>`;
        lines.appendChild(li);
      });
      if (!w.lines.length) lines.innerHTML = '<li class="muted">Nenhum ponto nesta mão.</li>';
    }

    const bars = $('#result-bars');
    bars.innerHTML = '';
    [0, 1].forEach((t) => {
      const row = document.createElement('div');
      row.className = 'rbar' + (w === t ? ' won' : '');
      row.innerHTML = `<span>${teamName(t)}</span><span class="track"><span class="fill"></span><span class="mark" title="61 pontos"></span></span><span class="num">${H.pts[t]}</span>`;
      bars.appendChild(row);
    });
    $('#result-sets').innerHTML = `${m.rules === 'capixaba' ? 'Pontos' : 'Jogos'}: ` +
      `<b>${teamName(0)} ${m.sets[0]}</b> × <b>${m.sets[1]} ${teamName(1)}</b> (${matchFormat()})`;

    const actions = $('#result-actions');
    actions.innerHTML = '';
    const mkBtn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ' + cls; b.textContent = label;
      b.addEventListener('click', () => { dlgs.result.close(); fn(); });
      actions.appendChild(b);
      return b;
    };
    let focusBtn;
    if (m.over) {
      mkBtn('Menu', '', goMenu);
      focusBtn = mkBtn('Nova partida', 'primary', startMatch);
    } else {
      focusBtn = mkBtn('Próxima mão', 'primary', beginHand);
    }
    pauseFor(dlgs.result);
    openDialog(dlgs.result);
    requestAnimationFrame(() => {
      $$('.rbar', bars).forEach((row, t) => {
        $('.fill', row).style.width = Math.min(100, (H.pts[t] / 120) * 100) + '%';
      });
      focusBtn.focus();
    });
  }

  function goMenu() {
    ui.gen++;
    closeAllDialogs();
    showScreen('menu');
  }

  /* ------------------------------------------------------------------ */
  /*  Eventos                                                            */
  /* ------------------------------------------------------------------ */

  // Menu
  function syncMenuForm() {
    const f = $('#menu-form');
    const set = (name, val) => { const r = f.querySelector(`input[name="${name}"][value="${val}"]`); if (r) r.checked = true; };
    set('mode', settings.mode); set('level', settings.level); set('rules', settings.rules);
    set('target', settings.target); set('p120', settings.p120); set('hs', settings.hs);
    syncRulesFields();
  }
  /** A capixaba vai sempre até 4 pontos: troca a escolha de "Partida" pelo valor dos 120. */
  function syncRulesFields() {
    const cap = $('#menu-form input[name="rules"]:checked').value === 'capixaba';
    $('#fs-target').classList.toggle('hidden', cap);
    $('#fs-p120').classList.toggle('hidden', !cap);
  }
  $$('#menu-form input[name="rules"]').forEach((r) => r.addEventListener('change', syncRulesFields));
  $('#menu-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    settings.mode = fd.get('mode');
    settings.level = fd.get('level');
    settings.rules = fd.get('rules');
    settings.target = Number(fd.get('target'));
    settings.p120 = Number(fd.get('p120'));
    settings.hs = Number(fd.get('hs'));
    saveSettings();
    startMatch();
  });

  // Regras / opções / sair
  const openRules = () => { pauseFor(dlgs.rules); openDialog(dlgs.rules); };
  $('#btn-rules').addEventListener('click', openRules);
  $('#btn-rules-menu').addEventListener('click', openRules);
  $('#btn-settings').addEventListener('click', () => {
    $('#opt-live').checked = settings.live;
    $('#opt-speed').value = settings.speed;
    $('#opt-level').value = settings.level;
    pauseFor(dlgs.settings);
    openDialog(dlgs.settings);
  });
  $('#opt-live').addEventListener('change', (e) => { settings.live = e.target.checked; saveSettings(); if (ui.H) renderScores(); });
  $('#opt-speed').addEventListener('change', (e) => { settings.speed = e.target.value; saveSettings(); });
  $('#opt-level').addEventListener('change', (e) => { settings.level = e.target.value; saveSettings(); });

  $('#btn-quit').addEventListener('click', () => { pauseFor(dlgs.quit); openDialog(dlgs.quit); });
  $('#quit-yes').addEventListener('click', () => { dlgs.quit.close(); goMenu(); });
  $('#knock-yes').addEventListener('click', () => answerKnock(true));
  $('#knock-no').addEventListener('click', () => answerKnock(false));

  // Fechar diálogos ao clicar fora
  Object.values(dlgs).forEach((d) => {
    d.addEventListener('click', (e) => {
      if (d === dlgs.result || d === dlgs.knock) return;
      if (e.target === d) d.close();
    });
  });

  // Jogar uma carta (clique ou teclado)
  $('#hand-s').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) humanPlay(Number(card.dataset.id));
  });
  document.addEventListener('keydown', (e) => {
    if (!ui.humanTurn || ui.paused || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) {
      const el = $(`#hand-s .card[data-idx="${e.key}"]`);
      if (el) { e.preventDefault(); humanPlay(Number(el.dataset.id)); }
    }
  });
  let fitTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitCards, 60); });

  /* ------------------------------------------------------------------ */
  /*  Início                                                             */
  /* ------------------------------------------------------------------ */

  syncMenuForm();
  showScreen('menu');

  // gancho para testes/depuração
  window.__bisca = { ui, settings, startMatch, humanPlay, cardEl, backEl };
})();
