/*
 * Bisca – motor do jogo (sem DOM).
 * Regras: https://en.wikipedia.org/wiki/Bisca_(card_game)
 *
 * Cartas são inteiros 0..39:  id = naipe * 10 + força
 *   naipe : 0=Copas(H) 1=Ouros(D) 2=Paus(C) 3=Espadas(S)
 *   força : 0..9 = 2,3,4,5,6,Dama,Valete,Rei,7,Ás   (crescente)
 *
 * Funciona no navegador (window.Bisca) e no Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bisca = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITS = ['H', 'D', 'C', 'S'];
  const SUIT_NAMES = { H: 'Copas', D: 'Ouros', C: 'Paus', S: 'Espadas' };
  const RANKS = ['2', '3', '4', '5', '6', 'Q', 'J', 'K', '7', 'A'];
  const RANK_NAMES = {
    '2': 'Dois', '3': 'Três', '4': 'Quatro', '5': 'Cinco', '6': 'Seis',
    Q: 'Dama', J: 'Valete', K: 'Rei', '7': 'Sete', A: 'Ás'
  };
  const POINTS = [0, 0, 0, 0, 0, 2, 3, 4, 10, 11]; // por força; soma por naipe = 30
  const WIN_POINTS = 61; // mais de 60 de 120 vence a mão
  const STR_7 = 8, STR_A = 9, HEARTS = 0; // força do 7 e do Ás; índice do naipe de Copas
  const CAPIXABA_TARGET = 4; // a partida capixaba vai até 4 pontos

  const suitOf = (c) => (c / 10) | 0;
  const strOf = (c) => c % 10;
  const ptsOf = (c) => POINTS[c % 10];
  const cardInfo = (c) => ({ id: c, suit: SUITS[suitOf(c)], rank: RANKS[strOf(c)], points: ptsOf(c) });
  const cardName = (c) => `${RANK_NAMES[RANKS[strOf(c)]]} de ${SUIT_NAMES[SUITS[suitOf(c)]]}`;
  const teamOf = (s, p) => (s.n === 4 ? p & 1 : p);

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // PRNG com semente (usado nos testes)
  function seeded(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** a (jogada depois) vence b (melhor carta até agora)? */
  function beats(a, b, trump) {
    const sa = suitOf(a), sb = suitOf(b);
    if (sa === sb) return strOf(a) > strOf(b);
    return sa === trump;
  }

  /**
   * Nova mão. n = 2 ou 4 jogadores (índices em sentido anti-horário).
   * opts.rules = 'classic' (padrão) ou 'capixaba'. Na capixaba o indicador do trunfo nunca é
   * Bisca (7 ou Ás), não repete naipes de opts.usedSuits (as outras quedas do ciclo de 4) e, se
   * quem corta bateu no baralho (opts.forceHearts), o trunfo é Copas.
   * Distribuição: começa pelo jogador à direita do carteador (dealer+1) e termina
   * nele; a carta seguinte é virada e vai para o fundo do monte (define o trunfo).
   * Quem corta (à esquerda do carteador) abre a primeira vaza.
   */
  function newHand(opts) {
    const rng = opts.rng || Math.random;
    const n = opts.n, hs = opts.hs, dealer = opts.dealer;
    const deck = [];
    for (let c = 0; c < 40; c++) deck.push(c);
    shuffle(deck, rng);
    const rules = opts.rules === 'capixaba' ? 'capixaba' : 'classic';
    let trumpCard = -1;
    if (rules === 'capixaba') {
      const used = opts.usedSuits || [];
      const eligible = deck.filter((c) => strOf(c) < STR_7 &&
        (opts.forceHearts ? suitOf(c) === HEARTS : !used.includes(suitOf(c))));
      trumpCard = eligible[Math.floor(rng() * eligible.length)];
      deck.splice(deck.indexOf(trumpCard), 1);
    }
    const hands = [];
    for (let i = 0; i < n; i++) hands.push([]);
    for (let r = 0; r < hs; r++) {
      for (let k = 1; k <= n; k++) hands[(dealer + k) % n].push(deck.pop());
    }
    if (rules === 'classic') trumpCard = deck.pop();
    const stock = [trumpCard].concat(deck); // compra-se do fim; trunfo fica no fundo
    const leader = (dealer + n - 1) % n;
    return {
      n, hs, dealer, hands, stock,
      trumpCard, trump: suitOf(trumpCard), trumpHolder: -1,
      trick: [], leader, turn: leader,
      pts: [0, 0], taken: [0, 0], tricks: [0, 0],
      seenMask: [0, 0, 0, 0], // cartas já recolhidas (públicas), 1 bit por força
      over: false, reason: null, trickNo: 0,
      // regras capixabas
      rules, knocked: !!opts.forceHearts,
      trump7Out: false,                     // o 7 de trunfo já foi jogado (libera o Ás)
      bonus: [0, 0], events: [],            // pontos extras de jogo ganhos nesta mão
      matchPts: (opts.matchPts || [0, 0]).slice(), target: opts.target || CAPIXABA_TARGET,
      p120: opts.p120 || 4
    };
  }

  function cloneState(s) {
    return {
      n: s.n, hs: s.hs, dealer: s.dealer,
      hands: s.hands.map((h) => h.slice()), stock: s.stock.slice(),
      trumpCard: s.trumpCard, trump: s.trump, trumpHolder: s.trumpHolder,
      trick: s.trick.map((t) => ({ p: t.p, c: t.c })),
      leader: s.leader, turn: s.turn,
      pts: s.pts.slice(), taken: s.taken.slice(), tricks: s.tricks.slice(),
      seenMask: s.seenMask.slice(), over: s.over, reason: s.reason, trickNo: s.trickNo,
      rules: s.rules, knocked: s.knocked, trump7Out: s.trump7Out, bonus: s.bonus.slice(), events: s.events.slice(),
      matchPts: s.matchPts, target: s.target, p120: s.p120
    };
  }

  /** Na capixaba o Ás de trunfo só sai depois do 7 de trunfo, a não ser que seja a última carta na mão. */
  function aceBlocked(s, p, c) {
    return s.rules === 'capixaba' && !s.trump7Out && c === s.trump * 10 + STR_A && s.hands[p].length > 1;
  }

  /** Não há obrigação de seguir naipe nem de cortar: vale qualquer carta (exceto o Ás de trunfo bloqueado). */
  function legalCards(s, p) {
    return s.hands[p].filter((c) => !aceBlocked(s, p, c));
  }

  function play(s, c) {
    if (s.over) throw new Error('Mão encerrada');
    const p = s.turn;
    if (p < 0) throw new Error('Vaza completa: resolva antes de jogar');
    const h = s.hands[p];
    const i = h.indexOf(c);
    if (i < 0) throw new Error(`Jogador ${p} não tem a carta ${c}`);
    if (aceBlocked(s, p, c)) throw new Error('O Ás de trunfo só sai depois do 7');
    h.splice(i, 1);
    if (c === s.trump * 10 + STR_7) s.trump7Out = true;
    s.trick.push({ p, c });
    s.turn = s.trick.length === s.n ? -1 : (p + 1) % s.n;
  }

  function trickBestIndex(s) {
    let best = 0;
    for (let i = 1; i < s.trick.length; i++) {
      if (beats(s.trick[i].c, s.trick[best].c, s.trump)) best = i;
    }
    return best;
  }

  /**
   * Eventos de pontuação extra (regras capixabas) de uma vaza completa.
   * plays = [{p, c}] na ordem jogada; trickNo = índice da vaza (0 = primeira).
   * Todo Heley vale 1 (Copas 2) p/ quem jogou o Ás; Ás e 7 da mesma dupla não contam.
   *  - Heley         : Ás de trunfo depois do 7 de trunfo adversário
   *  - Heley de Roda : 7 de trunfo abre a vaza e o Ás é a 4ª carta
   *  - Heley de fundo: 7 de trunfo jogado depois do Ás de trunfo adversário
   *  - Rodar o 7     : 7 de trunfo abre a 1ª vaza e nenhum Ás o cobre -> 1 (Copas 2) p/ quem abriu
   */
  function trickEvents(s, plays, trickNo) {
    const trump = s.trump, hearts = trump === HEARTS;
    const tag = hearts ? ' (Copas)' : '';
    const pts = hearts ? 2 : 1; // todo Heley vale 1, de Copas 2
    let i7 = -1, iA = -1;
    for (let i = 0; i < plays.length; i++) {
      const c = plays[i].c;
      if (suitOf(c) !== trump) continue;
      if (strOf(c) === STR_7) i7 = i; else if (strOf(c) === STR_A) iA = i;
    }
    const out = [];
    const add = (kind, team, points, label) => out.push({ kind, team, points, label, trick: trickNo });
    if (i7 >= 0 && iA >= 0) {
      const t7 = teamOf(s, plays[i7].p), tA = teamOf(s, plays[iA].p);
      if (t7 !== tA) {
        if (iA < i7) add('fundo', tA, pts, 'Heley de fundo' + tag);
        else if (s.n === 4 && i7 === 0 && iA === 3) add('roda', tA, pts, 'Heley de Roda' + tag);
        else add('heley', tA, pts, hearts ? 'Heley de Copas' : 'Heley');
      }
    } else if (i7 === 0 && iA < 0 && trickNo === 0) {
      add('rodar7', teamOf(s, plays[0].p), hearts ? 2 : 1, 'Rodar o 7' + tag);
    }
    return out;
  }

  /**
   * Recolhe a vaza: vencedor leva as cartas, compra primeiro (depois os demais em
   * sentido anti-horário) e abre a próxima. O último a comprar fica com o trunfo.
   */
  function resolveTrick(s) {
    if (s.trick.length !== s.n) throw new Error('Vaza incompleta');
    const bi = trickBestIndex(s);
    const winner = s.trick[bi].p;
    let points = 0;
    for (let i = 0; i < s.trick.length; i++) {
      const c = s.trick[i].c;
      points += ptsOf(c);
      s.seenMask[suitOf(c)] |= 1 << strOf(c);
    }
    const events = s.rules === 'capixaba' ? trickEvents(s, s.trick, s.trickNo) : [];
    for (let i = 0; i < events.length; i++) { s.bonus[events[i].team] += events[i].points; s.events.push(events[i]); }
    const t = teamOf(s, winner);
    s.pts[t] += points;
    s.taken[t] += s.n;
    s.tricks[t]++;
    const plays = s.trick;
    s.trick = [];
    const draws = [];
    for (let k = 0; k < s.n && s.stock.length; k++) {
      const p = (winner + k) % s.n;
      const c = s.stock.pop();
      s.hands[p].push(c);
      draws.push({ p, c });
      if (c === s.trumpCard) s.trumpHolder = p;
    }
    s.leader = s.turn = winner;
    s.trickNo++;
    let empty = true;
    for (let i = 0; i < s.n; i++) if (s.hands[i].length) { empty = false; break; }
    if (s.rules === 'capixaba') {
      // os extras podem fechar a partida na hora; a mão capixaba é jogada até o fim (capote / 120)
      if (s.matchPts[0] + s.bonus[0] >= s.target || s.matchPts[1] + s.bonus[1] >= s.target) { s.over = true; s.reason = 'match'; }
      else if (empty) { s.over = true; s.reason = 'complete'; }
    } else if (empty) { s.over = true; s.reason = 'complete'; }
    else if (s.pts[t] >= WIN_POINTS) { s.over = true; s.reason = 'early'; }
    return { winner, team: t, points, plays, draws, events };
  }

  /** 0 / 1 = equipe vencedora; -1 = empate (60 a 60). */
  function outcome(s) {
    if (s.pts[0] >= WIN_POINTS) return 0;
    if (s.pts[1] >= WIN_POINTS) return 1;
    return -1;
  }

  /**
   * Pontos de jogo da mão vencida (regras capixabas): 1 (Copas 2); capote (perdedor < 31) 2 (Copas 3);
   * 120 pontos = s.p120 (4 fecha a partida). Não há prêmio se a partida já foi fechada por extras ou se empatou 60 a 60.
   */
  function baseAward(s) {
    if (s.rules !== 'capixaba' || s.reason === 'match') return null;
    const w = outcome(s);
    if (w < 0) return null;
    const hearts = s.trump === HEARTS;
    if (s.pts[w] >= 120) return { kind: '120', team: w, points: s.p120, label: '120 pontos' };
    if (s.pts[1 - w] < 31) return { kind: 'capote', team: w, points: hearts ? 3 : 2, label: hearts ? 'Capote de Copas' : 'Capote' };
    return { kind: 'mao', team: w, points: hearts ? 2 : 1, label: hearts ? 'Mão vencida (Copas)' : 'Mão vencida' };
  }

  /** Pontos de jogo que a mão rende a cada equipe (extras + prêmio da mão). */
  function handGains(s) {
    const g = s.bonus.slice();
    const base = baseAward(s);
    if (base) g[base.team] += base.points;
    return g;
  }

  /* ---------- Partida ---------- */

  /**
   * Clássica: opts.target jogos (mão vencida = 1 ponto de jogo).
   * Capixaba (opts.rules = 'capixaba'): vai até 4 pontos; cada mão rende pontos conforme as regras acima.
   */
  function newMatch(opts) {
    const rng = opts.rng || Math.random;
    const rules = opts.rules === 'capixaba' ? 'capixaba' : 'classic';
    return {
      n: opts.n, hs: opts.hs, rules, p120: opts.p120 || 4,
      target: rules === 'capixaba' ? CAPIXABA_TARGET : opts.target,
      sets: [0, 0], dealer: Math.floor(rng() * opts.n), handNo: 0,
      usedSuits: [],                      // capixaba: trunfos das quedas do ciclo atual de 4
      over: false, winner: -1
    };
  }

  /** Quem corta (à esquerda do carteador) abre a primeira vaza e, na capixaba, pode bater: Copas vira trunfo. */
  function cutterOf(match) {
    return (match.dealer + match.n - 1) % match.n;
  }

  /** Naipes que já foram trunfo no ciclo atual (a cada 4 quedas os quatro naipes voltam a valer). */
  function usedSuitsOf(match) {
    const used = match.usedSuits || [];
    return used.length >= 4 ? [] : used;
  }

  /** Só dá para bater (Copas) se Copas ainda não foi trunfo neste ciclo de 4 quedas. */
  function canKnock(match) {
    return match.rules === 'capixaba' && !usedSuitsOf(match).includes(HEARTS);
  }

  function startHand(match, rng, forceHearts) {
    match.handNo++;
    const capixaba = match.rules === 'capixaba';
    const used = capixaba ? usedSuitsOf(match) : [];
    const s = newHand({
      n: match.n, hs: match.hs, dealer: match.dealer, rng, rules: match.rules,
      forceHearts: !!forceHearts && canKnock(match), usedSuits: used,
      matchPts: match.sets, target: match.target, p120: match.p120
    });
    if (capixaba) match.usedSuits = used.concat([s.trump]);
    return s;
  }

  /**
   * Registra o resultado da mão; o carteador passa para a direita.
   * Retorna { winner, gains: [g0, g1], lines: [{kind, team, points, label}] }
   * (winner = equipe que venceu a mão, ou -1 se empatou).
   */
  function finishHand(match, s) {
    let winner = outcome(s);
    const lines = [];
    const gains = [0, 0];
    if (match.rules === 'capixaba') {
      s.events.forEach((ev) => { gains[ev.team] += ev.points; lines.push(ev); });
      const base = baseAward(s);
      if (base) { gains[base.team] += base.points; lines.push(base); }
    } else if (winner >= 0) {
      gains[winner] = 1;
      lines.push({ kind: 'mao', team: winner, points: 1, label: 'Mão vencida' });
    }
    match.sets[0] += gains[0];
    match.sets[1] += gains[1];
    s.applied = true;
    match.dealer = (match.dealer + 1) % match.n;
    const a = match.sets[0], b = match.sets[1];
    if ((a >= match.target || b >= match.target) && a !== b) { match.over = true; match.winner = a > b ? 0 : 1; }
    if (s.reason === 'match') winner = a > b ? 0 : b > a ? 1 : winner;
    return { winner, gains, lines };
  }

  return {
    SUITS, SUIT_NAMES, RANKS, RANK_NAMES, POINTS, WIN_POINTS,
    suitOf, strOf, ptsOf, cardInfo, cardName, teamOf, shuffle, seeded, beats,
    newHand, cloneState, legalCards, play, trickBestIndex, trickEvents, resolveTrick, outcome,
    baseAward, handGains, newMatch, cutterOf, usedSuitsOf, canKnock, startHand, finishHand, aceBlocked,
    STR_7, STR_A, HEARTS, CAPIXABA_TARGET
  };
});
