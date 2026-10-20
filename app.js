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

  const DEFAULTS = { mode: '1v1', level: 'medium', rules: 'classic', target: 2, p120: 4, hs: 3, live: true, speed: 'normal', name: '' };
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
    if (p === 0) return 'Você';
    if (net.code && ui.match.names) return esc(ui.match.names[serverSeat(p)]);
    if (ui.match.n === 2) return 'Computador';
    return ['Você', 'Rival 1', 'Parceiro', 'Rival 2'][p];
  }
  function teamName(t) {
    if (ui.match.n === 2) return t === 0 ? 'Você' : nameOf(1);
    return t === 0 ? 'Nós' : 'Eles';
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

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
    $('#lobby').classList.toggle('hidden', id !== 'lobby');
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
    markBlocked();
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
    markBlocked();
  }

  /** Capixaba: apaga na mão as cartas que não podem ser jogadas agora (Ás antes do 7; 7 fechando a vaza). */
  function markBlocked() {
    const H = ui.H;
    const legal = H && H.hands[0].length ? B.legalCards(H, 0) : null;
    ui.handEls.forEach((el, id) => {
      const blocked = !!legal && !legal.includes(id);
      el.classList.toggle('blocked', blocked);
      if (blocked) el.title = B.BLOCK_MSG[B.blockReason(H, 0, id)] || '';
      else el.removeAttribute('title');
    });
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
    if (!B.canKnock(m)) { dealHand(false); return; } // Copas já foi trunfo neste ciclo de 4 quedas
    const cutter = B.cutterOf(m);
    if (cutter !== 0) { dealHand(AI.decideKnock(m, cutter, Math.random)); return; }
    ui.knockGen = ui.gen;
    askKnock();
  }

  /** Mesa vazia entre duas mãos, enquanto quem corta decide se bate. */
  function clearTableBetweenHands() {
    const m = ui.match;
    resetTable();
    ui.H = null;
    renderNameplates();
    $('#trump-chip').innerHTML = '';
    [0, 1].forEach((t) => { $('#pts-' + t).textContent = '0'; $('#team-' + t).classList.remove('lead'); });
    $('#matchinfo').innerHTML = `Mão ${m.handNo + 1} &middot; Pontos ${m.sets[0]}–${m.sets[1]}<br>capixaba, até ${m.target}`;
  }

  function askKnock() {
    const m = ui.match;
    clearTableBetweenHands();
    setStatus('Você corta o baralho.');
    $('#knock-score').innerHTML = `Placar: <b>${teamName(0)} ${m.sets[0]}</b> × <b>${m.sets[1]} ${teamName(1)}</b> (até ${m.target})`;
    openDialog(dlgs.knock);
  }

  function answerKnock(knocked) {
    dlgs.knock.close();
    if (net.code) { netSend({ t: 'knock', yes: knocked }); setStatus('Distribuindo as cartas…'); return; }
    if (ui.knockGen !== ui.gen) return;
    ui.knockGen = -1;
    dealHand(knocked);
  }

  function dealHand(knocked) {
    ui.gen++;
    ui.H = B.startHand(ui.match, Math.random, knocked);
    showDeal();
  }

  /** Mostra a distribuição da mão ui.H (local ou recebida do servidor). */
  function showDeal() {
    const m = ui.match, H = ui.H;
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
        for (let j = 0; j < H.hands[p].length; j++) {
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
    if (net.code) {
      // online: o servidor manda as próximas jogadas; aqui só mostra de quem é a vez
      if (H.over) setStatus('Fim da mão.');
      else if (H.turn < 0) setStatus('&nbsp;');
      else if (H.turn === 0) {
        setHumanTurn(true);
        setStatus(H.trick.length ? 'Sua vez: escolha uma carta.' : 'Sua vez: abra a vaza com uma carta.');
      } else setStatus(`Vez de <b>${nameOf(H.turn)}</b>…`);
      netIdle();
      return;
    }
    if (H.over) { endHand(); return; }
    if (H.turn < 0) { setStatus('&nbsp;'); later(850, () => collect()); return; }
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
    if (!B.legalCards(ui.H, 0).includes(c)) {
      setStatus(`${B.BLOCK_MSG[B.blockReason(ui.H, 0, c)] || 'Essa carta não pode ser jogada agora.'} Escolha outra carta.`);
      return;
    }
    setHumanTurn(false);
    if (net.code) {
      ui.handEls.get(c).classList.add('sending');
      netSend({ t: 'play', card: c });
      return;
    }
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
    const src = p === 0 ? ui.handEls.get(c) : $('#hand-' + pos).lastElementChild;
    from = (src || $('#np-' + pos)).getBoundingClientRect();
    if (src) src.remove();
    if (p === 0) ui.handEls.delete(c);
    if (net.code) mirrorPlay(H, p, c); else B.play(H, c);
    const el = cardEl(c);
    setPose(el);
    $('#slot-' + pos).appendChild(el);
    flyFrom(el, from, { dur: 420 });
    if (p === 0) syncHand();
    nextStep();
  }

  /** Recolhe a vaza; online, `given` é o resultado já calculado pelo servidor. */
  function collect(given) {
    const res = given || B.resolveTrick(ui.H);
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
    if (H.over) { if (net.code) nextStep(); else endHand(); return; }
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

  /** Fim da mão; online, `given` é o resultado que veio do servidor (já aplicado ao placar). */
  function endHand(given) {
    const H = ui.H, m = ui.match;
    setHumanTurn(false);
    const w = given || B.finishHand(m, H);
    renderNameplates();
    renderScores(true);
    setStatus('Fim da mão.');
    later(700, () => { showResult(w); if (net.code) netIdle(); });
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
    const wt = w.winner;
    const rival = two ? nameOf(1) : 'A dupla adversária';
    let title;
    if (m.over) {
      title = m.winner === 0 ? (two ? 'Você venceu a partida!' : 'Sua dupla venceu a partida!') : `${rival} venceu a partida`;
    } else if (wt === 0) title = two ? 'Você venceu a mão!' : 'Sua dupla venceu a mão!';
    else if (wt === 1) title = `${rival} venceu a mão`;
    else if (H.reason === 'match') title = 'Partida empatada nos pontos extras';
    else title = 'Mão empatada: 60 a 60';
    $('#result-title').textContent = title;
    $('#result-sub').textContent = H.reason === 'early'
      ? 'A mão terminou antes do fim das cartas: passou de 60 pontos.'
      : H.reason === 'match' ? 'Os pontos extras fecharam a partida antes do fim da mão.'
        : 'Todas as cartas foram jogadas.';

    const lines = $('#result-lines');
    lines.innerHTML = '';
    if (m.rules === 'capixaba' && w.lines) {
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
      row.className = 'rbar' + (wt === t ? ' won' : '');
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
    if (net.code) {
      // online: qualquer jogador pode seguir; a mão nova (ou a sala) chega pelo servidor para todos
      if (m.over) {
        mkBtn('Sair da sala', '', leaveRoom);
        focusBtn = mkBtn('Voltar para a sala', 'primary', () => { netSend({ t: 'restart' }); setStatus('Voltando para a sala…'); });
      } else {
        focusBtn = mkBtn('Próxima mão', 'primary', () => { netSend({ t: 'next' }); setStatus('Começando a próxima mão…'); });
      }
    } else if (m.over) {
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
  /*  Online (salas)                                                     */
  /* ------------------------------------------------------------------ */

  /*
   * O servidor (server.js) embaralha, valida e joga pelos lugares vazios. Aqui ficam só um "espelho"
   * da mão (ui.H, com as cartas dos outros escondidas como -1) e uma fila de mensagens: cada uma é
   * mostrada com a mesma animação do jogo local e, ao terminar, nextStep()/netIdle() libera a próxima.
   */
  const net = {
    ws: null, code: null, seat: 0, n: 2, room: null,
    want: null,          // mensagem de entrada (criar/entrar) reenviada ao reconectar
    queue: [], busy: false, retry: 0
  };
  const ONLINE = location.protocol === 'http:' || location.protocol === 'https:';
  const TOKEN_KEY = 'bisca.room.';

  // o servidor numera os lugares 0..n-1; na tela eu sou sempre o 0 e a minha dupla é a 0
  const localSeat = (s) => (s - net.seat + net.n) % net.n;
  const serverSeat = (p) => (p + net.seat) % net.n;
  const localTeam = (t) => (t < 0 ? t : t ^ (net.seat & 1));
  const byTeam = (a) => (net.seat & 1 ? [a[1], a[0]] : a.slice());
  const withLocalTeam = (list) => list.map((e) => Object.assign({}, e, { team: localTeam(e.team) }));

  function storedToken(code) {
    try { return localStorage.getItem(TOKEN_KEY + code) || null; } catch (e) { return null; }
  }
  function storeToken(code, token) {
    try { if (token) localStorage.setItem(TOKEN_KEY + code, token); else localStorage.removeItem(TOKEN_KEY + code); } catch (e) { /* sem armazenamento */ }
  }
  function setRoomUrl(code) {
    try { history.replaceState(null, '', code ? '?sala=' + code : location.pathname); } catch (e) { /* ignora */ }
  }
  const inviteLink = (code) => location.origin + location.pathname + '?sala=' + code;
  const inviteText = (code) => `Bora jogar Bisca? Entra na minha sala ${code}: ${inviteLink(code)}`;

  let toastTimer = 0;
  function toast(text, ms) {
    const t = $('#net-toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() { $('#net-toast').classList.add('hidden'); }

  function showOnlineError(text) {
    const el = $('#online-error');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  function netConnect() {
    if (net.ws && net.ws.readyState <= 1) return;
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    net.ws = ws;
    ws.onopen = () => { net.retry = 0; if (net.want) ws.send(JSON.stringify(net.want)); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      onNet(msg);
    };
    ws.onclose = () => {
      if (net.ws !== ws) return;
      net.ws = null;
      if (!net.want) return;
      net.retry++;
      if (net.retry > 8 && !net.code) { net.want = null; hideToast(); showOnlineError('Não foi possível conectar ao servidor.'); return; }
      toast('Conexão perdida. Reconectando…');
      setTimeout(() => { if (net.want) netConnect(); }, Math.min(5000, 500 * net.retry));
    };
  }
  function netSend(msg) {
    if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(msg));
  }
  function netStart(msg) {
    showOnlineError('');
    net.want = msg;
    toast('Conectando…');
    if (net.ws && net.ws.readyState === 1) netSend(msg); else netConnect();
  }

  function leaveRoom() {
    netSend({ t: 'leave' });
    if (net.code) storeToken(net.code, null);
    const ws = net.ws;
    Object.assign(net, { ws: null, code: null, room: null, want: null, queue: [], busy: false });
    if (ws) setTimeout(() => ws.close(), 300);
    setRoomUrl(null);
    hideToast();
    ui.H = null;
    goMenu();
  }

  function onNet(msg) {
    switch (msg.t) {
      case 'joined':
        // começo (ou recomeço, ao reconectar): descarta o que estava na fila
        ui.gen++;
        Object.assign(net, { code: msg.code, seat: msg.seat, queue: [], busy: false });
        net.want = { t: 'join', code: msg.code, token: msg.token, name: settings.name };
        storeToken(msg.code, msg.token);
        setRoomUrl(msg.code);
        hideToast();
        return;
      case 'room':
        net.room = msg;
        net.n = msg.seats.length;
        net.seat = msg.you;
        if (msg.phase === 'lobby') {
          if ($('#lobby').classList.contains('hidden')) showLobby(); else renderLobby();
        }
        return;
      case 'error':
        if (msg.code === 'play') {
          $$('#hand-s .sending').forEach((el) => el.classList.remove('sending'));
          if (ui.H && ui.H.turn === 0 && !ui.H.over) setHumanTurn(true);
          toast(msg.msg, 2500);
          return;
        }
        // não deu para entrar na sala
        if (net.code) storeToken(net.code, null);
        if (net.want && net.want.code) storeToken(net.want.code, null);
        Object.assign(net, { code: null, room: null, want: null, queue: [], busy: false });
        setRoomUrl(null);
        hideToast();
        goMenu();
        showOnlineError(msg.msg);
        return;
      case 'kicked':
        Object.assign(net, { code: null, room: null, want: null, queue: [], busy: false });
        goMenu();
        showOnlineError(msg.msg);
        return;
      case 'left':
        return;
      default:
        net.queue.push(msg);
        if (!net.busy) netNext();
    }
  }

  function netNext() {
    const msg = net.queue.shift();
    if (!msg) { net.busy = false; return; }
    net.busy = true;
    handleGame(msg);
  }
  /** A mensagem atual terminou de ser mostrada: passa para a próxima. */
  function netIdle() {
    net.busy = false;
    if (net.queue.length) setTimeout(() => { if (!net.busy) netNext(); }, 0);
  }

  /** Espelho local da mão a partir do que o servidor mostra a este jogador. */
  function mirrorFrom(v) {
    const hands = [];
    for (let p = 0; p < v.n; p++) {
      const s = serverSeat(p);
      hands.push(p === 0 ? v.hand.slice() : new Array(v.counts[s]).fill(-1));
    }
    return {
      n: v.n, hs: v.hs, dealer: localSeat(v.dealer), hands, stock: new Array(v.stockLen).fill(-1),
      trumpCard: v.trumpCard, trump: v.trump, trumpHolder: v.trumpHolder < 0 ? -1 : localSeat(v.trumpHolder),
      trick: v.trick.map((t) => ({ p: localSeat(t.p), c: t.c })),
      leader: localSeat(v.leader), turn: v.turn < 0 ? -1 : localSeat(v.turn),
      pts: byTeam(v.pts), bonus: byTeam(v.bonus), events: withLocalTeam(v.events),
      over: v.over, reason: v.reason, rules: v.rules, knocked: v.knocked, trump7Out: v.trump7Out, trickNo: v.trickNo, applied: false
    };
  }

  function mirrorPlay(H, p, c) {
    const h = H.hands[p];
    if (p === 0) { const i = h.indexOf(c); if (i >= 0) h.splice(i, 1); } else h.pop();
    if (c === H.trump * 10 + B.STR_7) H.trump7Out = true;
    H.trick.push({ p, c });
    H.turn = H.trick.length === H.n ? -1 : (p + 1) % H.n;
  }

  /** Mesa montada de uma vez (ao entrar ou reconectar no meio da mão). */
  function renderSnapshot() {
    const H = ui.H;
    resetTable();
    ui.stockShown = H.stock.length;
    ui.trumpShown = H.stock.length > 0;
    renderTrumpChip();
    renderNameplates();
    renderScores();
    renderStock();
    fitCards();
    syncHand();
    for (let p = 1; p < H.n; p++) {
      const box = $('#hand-' + posOf(p));
      for (let j = 0; j < H.hands[p].length; j++) box.appendChild(backEl());
    }
    H.trick.forEach((t) => {
      const el = cardEl(t.c);
      setPose(el);
      $('#slot-' + posOf(t.p)).appendChild(el);
    });
  }

  function handleGame(msg) {
    const m = ui.match;
    switch (msg.t) {
      case 'match': {
        if (dlgs.result.open) dlgs.result.close();
        const fresh = $('#game').classList.contains('hidden');
        ui.match = {
          n: msg.n, hs: msg.hs, rules: msg.rules, target: msg.target, p120: msg.p120,
          sets: byTeam(msg.sets), dealer: localSeat(msg.dealer), handNo: msg.handNo,
          over: false, winner: -1, names: msg.names
        };
        if (fresh) { closeAllDialogs(); showScreen('game'); }
        buildTable();
        netIdle();
        return;
      }
      case 'knockAsk':
        askKnock();
        netIdle();
        return;
      case 'knockWait':
        clearTableBetweenHands();
        setStatus(`<b>${nameOf(localSeat(msg.seat))}</b> está cortando o baralho…`);
        netIdle();
        return;
      case 'deal':
        ui.gen++;
        if (dlgs.knock.open) dlgs.knock.close();
        ui.H = mirrorFrom(msg.v);
        m.handNo = msg.v.handNo;
        showDeal();
        return;
      case 'sync': {
        const v = msg.v;
        ui.H = mirrorFrom(v);
        m.handNo = v.handNo;
        renderSnapshot();
        if (msg.last) {
          ui.H.applied = true;
          m.over = msg.last.matchOver;
          m.winner = localTeam(msg.last.matchWinner);
          const H = ui.H;
          endHand({ winner: H.pts[0] > 60 ? 0 : H.pts[1] > 60 ? 1 : -1, lines: null });
          return;
        }
        nextStep();
        return;
      }
      case 'play':
        if (!ui.H) { netIdle(); return; }
        playCard(localSeat(msg.seat), msg.card);
        return;
      case 'trick': {
        const H = ui.H;
        if (!H) { netIdle(); return; }
        const res = {
          winner: localSeat(msg.winner), points: msg.points, events: withLocalTeam(msg.events),
          draws: msg.draws.map((d) => ({ p: localSeat(d.p), c: d.c }))
        };
        later(850, () => {
          H.pts = byTeam(msg.pts);
          H.bonus = byTeam(msg.bonus);
          res.events.forEach((e) => H.events.push(e));
          H.trick = [];
          H.leader = H.turn = res.winner;
          H.trickNo++;
          res.draws.forEach((d) => {
            H.hands[d.p].push(d.c);
            H.stock.pop();
            if (d.c === H.trumpCard) H.trumpHolder = d.p;
          });
          H.over = msg.over;
          H.reason = msg.reason;
          collect(res);
        });
        return;
      }
      case 'hand': {
        const H = ui.H;
        if (!H) { netIdle(); return; }
        H.pts = byTeam(msg.pts);
        H.over = true;
        H.reason = msg.reason;
        H.applied = true;
        m.sets = byTeam(msg.sets);
        m.over = msg.matchOver;
        m.winner = localTeam(msg.matchWinner);
        endHand({ winner: localTeam(msg.winner), gains: byTeam(msg.gains), lines: withLocalTeam(msg.lines) });
        return;
      }
      default:
        netIdle();
    }
  }

  /* ---------- Sala de espera ---------- */

  function showLobby() {
    ui.gen++;
    net.queue = [];
    net.busy = false;
    ui.H = null;
    closeAllDialogs();
    showScreen('lobby');
    renderLobby();
  }

  function renderLobby() {
    const r = net.room;
    if (!r) return;
    const o = r.opts;
    const fmt = o.rules === 'capixaba' ? 'Capixaba, até 4 pontos' : ['Jogo único', 'Melhor de 3', 'Melhor de 5'][o.target - 1];
    $('#lobby-code').textContent = r.code;
    $('#lobby-desc').textContent = `${o.n === 4 ? '2 × 2' : '1 × 1'} · ${fmt} · ${o.hs} cartas na mão`;
    $('#invite-link').value = inviteLink(r.code);
    $('#btn-whatsapp').href = 'https://wa.me/?text=' + encodeURIComponent(inviteText(r.code));
    const ul = $('#lobby-seats');
    ul.innerHTML = '';
    r.seats.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = (i === r.you ? 'me' : '') + (s.human ? '' : ' bot');
      const tags = [i === r.you && 'você', s.human && i === r.host && 'anfitrião', s.human && !s.online && 'desconectado']
        .filter(Boolean).join(', ');
      const team = r.seats.length === 4 ? `<span class="team">Dupla ${i % 2 ? 'B' : 'A'}</span>` : '';
      li.innerHTML = `<span class="dot${s.online ? ' on' : ''}"></span>` +
        `<span class="sname">${s.human ? esc(s.name) : 'Lugar livre (computador)'}${tags ? ` <small>${tags}</small>` : ''}</span>${team}`;
      if (!s.human) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small';
        b.textContent = 'Sentar aqui';
        b.addEventListener('click', () => netSend({ t: 'sit', seat: i }));
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
    const host = r.you === r.host;
    const free = r.seats.filter((s) => !s.human).length;
    $('#btn-start').classList.toggle('hidden', !host);
    $('#lobby-hint').textContent = (host ? '' : 'Aguardando o anfitrião começar a partida. ') +
      (free ? (free === 1 ? 'O lugar livre fica com o computador.' : 'Os lugares livres ficam com o computador.') : 'Mesa completa!');
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
  function readMenuForm() {
    const fd = new FormData($('#menu-form'));
    settings.mode = fd.get('mode');
    settings.level = fd.get('level');
    settings.rules = fd.get('rules');
    settings.target = Number(fd.get('target'));
    settings.p120 = Number(fd.get('p120'));
    settings.hs = Number(fd.get('hs'));
    saveSettings();
  }
  $('#menu-form').addEventListener('submit', (e) => {
    e.preventDefault();
    readMenuForm();
    startMatch();
  });

  // Online
  function onlineName() {
    const v = $('#online-name').value.trim();
    if (!v) { showOnlineError('Digite seu nome para jogar online.'); $('#online-name').focus(); return null; }
    settings.name = v.slice(0, 16);
    saveSettings();
    return settings.name;
  }
  $('#btn-create').addEventListener('click', () => {
    const name = onlineName();
    if (!name) return;
    readMenuForm();
    const s = settings;
    netStart({ t: 'create', name, opts: { mode: s.mode, rules: s.rules, target: s.target, p120: s.p120, hs: s.hs, level: s.level } });
  });
  function joinFromMenu() {
    const name = onlineName();
    if (!name) return;
    const code = $('#join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { showOnlineError('O código da sala tem 4 letras ou números.'); $('#join-code').focus(); return; }
    netStart({ t: 'join', code, name, token: storedToken(code) });
  }
  $('#btn-join').addEventListener('click', joinFromMenu);
  $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinFromMenu(); } });
  $('#online-name').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if ($('#join-code').value.trim()) joinFromMenu(); else $('#btn-create').click();
  });
  $('#btn-start').addEventListener('click', () => netSend({ t: 'start' }));
  $('#btn-leave').addEventListener('click', leaveRoom);
  const canShare = typeof navigator.share === 'function';
  $('#btn-share').textContent = canShare ? 'Compartilhar convite' : 'Copiar convite';
  $('#btn-share').addEventListener('click', async () => {
    const code = net.room && net.room.code;
    if (!code) return;
    if (canShare) {
      try { await navigator.share({ title: 'Bisca', text: inviteText(code), url: inviteLink(code) }); } catch (e) { /* cancelado */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteText(code));
    } catch (e) {
      const inp = $('#invite-link');
      inp.select();
      document.execCommand('copy');
    }
    toast('Convite copiado! Cole no WhatsApp ou onde quiser.', 2500);
  });
  $('#invite-link').addEventListener('focus', (e) => e.target.select());

  // Regras / opções / sair
  const openRules = () => { pauseFor(dlgs.rules); openDialog(dlgs.rules); };
  $('#btn-rules').addEventListener('click', openRules);
  $('#btn-rules-menu').addEventListener('click', openRules);
  $('#btn-settings').addEventListener('click', () => {
    $('#opt-live').checked = settings.live;
    $('#opt-speed').value = settings.speed;
    $('#opt-level').value = settings.level;
    $('#opt-level-wrap').classList.toggle('hidden', !!net.code);
    pauseFor(dlgs.settings);
    openDialog(dlgs.settings);
  });
  $('#opt-live').addEventListener('change', (e) => { settings.live = e.target.checked; saveSettings(); if (ui.H) renderScores(); });
  $('#opt-speed').addEventListener('change', (e) => { settings.speed = e.target.value; saveSettings(); });
  $('#opt-level').addEventListener('change', (e) => { settings.level = e.target.value; saveSettings(); });

  $('#btn-quit').addEventListener('click', () => { pauseFor(dlgs.quit); openDialog(dlgs.quit); });
  $('#quit-yes').addEventListener('click', () => { dlgs.quit.close(); if (net.code) leaveRoom(); else goMenu(); });
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

  if (ONLINE) {
    $('#fs-online').classList.remove('hidden');
    $('#online-name').value = settings.name || '';
    const code = (new URLSearchParams(location.search).get('sala') || '').toUpperCase().slice(0, 4);
    if (code) {
      $('#join-code').value = code;
      if (settings.name && storedToken(code)) {
        // recarregou a página: volta direto para o mesmo lugar
        netStart({ t: 'join', code, name: settings.name, token: storedToken(code) });
      } else {
        const banner = $('#invite-banner');
        banner.textContent = `Você foi convidado para a sala ${code}. Digite seu nome e toque em “Entrar na sala”.`;
        banner.classList.remove('hidden');
        $('#btn-join').classList.add('primary');
        $('#btn-create').classList.remove('primary');
        $('#fs-online').scrollIntoView({ block: 'center' });
        $('#online-name').focus();
      }
    }
  }

  // gancho para testes/depuração
  window.__bisca = { ui, net, settings, startMatch, humanPlay, cardEl, backEl };
})();
