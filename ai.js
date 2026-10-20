/*
 * Bisca – jogadores controlados pelo computador.
 *
 *  fácil  : joga uma carta aleatória em ~40% das vezes, senão usa a heurística com ruído
 *  médio  : heurística (valor esperado de pontos + valor de guardar a carta)
 *  difícil: Monte Carlo – sorteia mãos possíveis dos outros jogadores (usando só o que
 *           é público: cartas já jogadas, trunfo e quem o comprou) e simula o resto da
 *           mão com a heurística para cada carta candidata.
 *
 * Nenhum nível enxerga as cartas dos outros jogadores.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.BiscaAI = factory(root.Bisca);
})(typeof self !== 'undefined' ? self : this, function (B) {
  'use strict';

  const PTS = B.POINTS;
  const POP = new Uint8Array(1024);
  for (let i = 1; i < 1024; i++) POP[i] = POP[i >> 1] + (i & 1);

  // Parâmetros ajustados por simulação (milhares de mãos IA contra IA).
  const PARAMS = {
    trumpBase: 8,     // valor de guardar um trunfo
    trumpStr: 1.0,    // + por ponto de força do trunfo
    strW: 0.1,        // valor de guardar força de carta comum
    ptsW: 0.1,        // valor de guardar pontos de carta comum
    bank: 0.5,        // bônus por "assegurar" os pontos da própria carta numa vaza ganha
    willing: 0.7,     // chance de o adversário realmente usar uma carta que vence
    partnerHope: 0.2, // chance de o parceiro (que joga depois) virar uma vaza perdida
    matchW: 40        // regras capixabas: quanto vale 1 ponto de jogo, em "pontos de carta"
  };
  const PARAMS_4P = Object.assign({}, PARAMS, { trumpStr: 1.5 });
  const paramsFor = (s) => (s.n === 4 ? PARAMS_4P : PARAMS);

  const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

  /* ---------- Heurística ---------- */

  function heuristicChoose(s, p, par, rng, noise) {
    const hand = s.hands[p];
    const len = hand.length;
    if (len === 1) return hand[0];
    const n = s.n, trump = s.trump, trick = s.trick;
    const myTeam = n === 4 ? p & 1 : p;

    // cartas que eu não vejo (mãos alheias + monte)
    const mk = [0x3ff & ~s.seenMask[0], 0x3ff & ~s.seenMask[1], 0x3ff & ~s.seenMask[2], 0x3ff & ~s.seenMask[3]];
    for (let i = 0; i < len; i++) { const c = hand[i]; mk[(c / 10) | 0] &= ~(1 << (c % 10)); }
    let T = 0, bi = -1;
    for (let i = 0; i < trick.length; i++) {
      const c = trick[i].c;
      mk[(c / 10) | 0] &= ~(1 << (c % 10));
      T += PTS[c % 10];
      if (bi < 0 || B.beats(c, trick[bi].c, trump)) bi = i;
    }
    const u = POP[mk[0]] + POP[mk[1]] + POP[mk[2]] + POP[mk[3]];

    // quem ainda joga depois de mim nesta vaza
    const rem = n - trick.length - 1;
    let oppCards = 0, partnerAfter = 0;
    for (let k = 1; k <= rem; k++) {
      const x = (p + k) % n;
      if ((n === 4 ? x & 1 : x) === myTeam) partnerAfter++;
      else oppCards += s.hands[x].length;
    }

    const fut = len - 1 + s.stock.length / n;       // vazas que ainda restam depois desta
    const tScale = Math.min(1, fut / 5);            // trunfo vale menos perto do fim

    // regras capixabas: onde o 7 e o Ás de trunfo já caíram nesta vaza
    const cap = s.rules === 'capixaba', hearts = trump === 0;
    let i7 = -1, iA = -1;
    if (cap) {
      for (let i = 0; i < trick.length; i++) {
        const c = trick[i].c;
        if (((c / 10) | 0) === trump) { if (c % 10 === 8) i7 = i; else if (c % 10 === 9) iA = i; }
      }
    }
    const myIdx = trick.length;

    const pBeatCache = {};
    function pBeat(bc) {
      const sb = (bc / 10) | 0, stb = bc % 10;
      let k = POP[mk[sb] >> (stb + 1)];
      if (sb !== trump) k += POP[mk[trump]];
      if (k === 0) return 0;
      let none = 1;
      for (let j = 0; j < oppCards; j++) {
        const a = u - k - j;
        if (a <= 0) { none = 0; break; }
        none *= a / (u - j);
      }
      return par.willing * (1 - none);
    }

    const cands = B.legalCards(s, p);
    if (cands.length === 1) return cands[0];
    let bestScore = -Infinity, bestCard = cands[0];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i], su = (c / 10) | 0, st = c % 10, pc = PTS[st];
      let bc, mine;
      if (bi < 0) { bc = c; mine = true; }
      else {
        const cur = trick[bi];
        if (B.beats(c, cur.c, trump)) { bc = c; mine = true; }
        else { bc = cur.c; mine = (n === 4 ? cur.p & 1 : cur.p) === myTeam; }
      }
      let pWin;
      if (mine) {
        if (oppCards === 0) pWin = 1;
        else {
          let pb = pBeatCache[bc];
          if (pb === undefined) pb = pBeatCache[bc] = pBeat(bc);
          pWin = 1 - pb;
        }
      } else {
        pWin = partnerAfter > 0 ? par.partnerHope : 0;
      }
      const keep = su === trump ? (par.trumpBase + par.trumpStr * st) * tScale : par.strW * st + par.ptsW * pc;
      let sc = (2 * pWin - 1) * T - (1 - pWin) * pc + pWin * par.bank * pc - keep;
      if (cap && su === trump) {
        if (st === 9) {
          // meu Ás sobre o 7 de trunfo adversário: Heley
          if (i7 >= 0) {
            const t7 = n === 4 ? trick[i7].p & 1 : trick[i7].p;
            if (t7 !== myTeam) sc += par.matchW * (hearts ? 2 : 1);
          }
        } else if (st === 8) {
          if (iA >= 0) {
            // meu 7 depois do Ás de trunfo adversário: Heley de fundo para eles
            const tA = n === 4 ? trick[iA].p & 1 : trick[iA].p;
            if (tA !== myTeam) sc -= par.matchW * (hearts ? 2 : 1);
          } else if (i7 < 0) {
            // 7 de trunfo sem Ás na mesa: se um adversário ainda tiver o Ás, leva Heley; se ninguém cobrir ao abrir a 1ª vaza, rodei o 7
            let pb = 0;
            if (oppCards > 0) { pb = pBeatCache[c]; if (pb === undefined) pb = pBeatCache[c] = pBeat(c); }
            sc -= par.matchW * pb * (hearts ? 2 : 1);
            if (myIdx === 0 && s.trickNo === 0) sc += par.matchW * (1 - pb) * (hearts ? 2 : 1);
          }
        }
      }
      if (noise) sc += (rng() - 0.5) * 2 * noise;
      if (sc > bestScore) { bestScore = sc; bestCard = c; }
    }
    return bestCard;
  }

  /* ---------- Monte Carlo ---------- */

  /** Sorteia um mundo consistente com o que o jogador p sabe. */
  function sampleWorld(s, p, rng) {
    const w = B.cloneState(s);
    const mk = [0x3ff & ~s.seenMask[0], 0x3ff & ~s.seenMask[1], 0x3ff & ~s.seenMask[2], 0x3ff & ~s.seenMask[3]];
    const mine = s.hands[p];
    for (let i = 0; i < mine.length; i++) mk[(mine[i] / 10) | 0] &= ~(1 << (mine[i] % 10));
    for (let i = 0; i < s.trick.length; i++) { const c = s.trick[i].c; mk[(c / 10) | 0] &= ~(1 << (c % 10)); }
    const pool = [];
    for (let c = 0; c < 40; c++) if ((mk[(c / 10) | 0] >> (c % 10)) & 1) pool.push(c);

    const tc = s.trumpCard;
    const stockPending = s.stock.length > 0;
    let forcedPlayer = -1;
    const ti = pool.indexOf(tc);
    if (ti >= 0) {
      pool.splice(ti, 1);
      if (!stockPending) forcedPlayer = s.trumpHolder; // trunfo já foi comprado: está com quem comprou
    }
    B.shuffle(pool, rng);
    let k = 0;
    for (let x = 0; x < s.n; x++) {
      if (x === p) continue;
      const hand = [];
      let need = s.hands[x].length;
      if (x === forcedPlayer) { hand.push(tc); need--; }
      for (let j = 0; j < need; j++) hand.push(pool[k++]);
      w.hands[x] = hand;
    }
    if (stockPending) {
      const st = [tc];
      for (let j = 1; j < s.stock.length; j++) st.push(pool[k++]);
      w.stock = st;
    }
    return w;
  }

  function rollout(w, first, par, rng) {
    B.play(w, first);
    while (!w.over) {
      if (w.turn < 0) { B.resolveTrick(w); continue; }
      B.play(w, heuristicChoose(w, w.turn, par, rng, 0));
    }
  }

  function mcChoose(s, p, rng, opts) {
    const hand = B.legalCards(s, p);
    const myTeam = B.teamOf(s, p);
    const maxSamples = (opts && opts.samples) || 500;
    const budget = (opts && opts.ms) || 350;
    const sums = new Float64Array(hand.length);
    const t0 = now();
    let done = 0;
    while (done < maxSamples) {
      const w = sampleWorld(s, p, rng);
      for (let i = 0; i < hand.length; i++) {
        const wc = B.cloneState(w);
        rollout(wc, hand[i], paramsFor(s), rng);
        if (s.rules === 'capixaba') {
          // valor = pontos de jogo da mão (extras + prêmio), com bônus por fechar a partida e leve desempate por pontos de carta
          const g = B.handGains(wc);
          const mine = wc.matchPts[myTeam] + g[myTeam], theirs = wc.matchPts[1 - myTeam] + g[1 - myTeam];
          let v = g[myTeam] - g[1 - myTeam] + 0.6 * wc.pts[myTeam] / 120;
          if (mine >= wc.target && mine > theirs) v += 2; else if (theirs >= wc.target && theirs > mine) v -= 2;
          sums[i] += v;
        } else {
          const out = B.outcome(wc);
          sums[i] += wc.pts[myTeam] / 120 + (out === myTeam ? 0.5 : out < 0 ? 0.25 : 0);
        }
      }
      done++;
      if (done >= 24 && now() - t0 > budget) break;
    }
    let bi = 0;
    for (let i = 1; i < hand.length; i++) if (sums[i] > sums[bi]) bi = i;
    return hand[bi];
  }

  /* ---------- API ---------- */

  function choose(s, p, level, rng, opts) {
    rng = rng || Math.random;
    const hand = B.legalCards(s, p);
    if (hand.length === 1) return hand[0];
    switch (level) {
      case 'easy':
        if (rng() < 0.4) return hand[Math.floor(rng() * hand.length)];
        return heuristicChoose(s, p, paramsFor(s), rng, 2.5);
      case 'hard':
        return mcChoose(s, p, rng, opts);
      default:
        return heuristicChoose(s, p, paramsFor(s), rng, 0.25);
    }
  }

  /**
   * Regras capixabas: quem corta pode "bater" no baralho para que Copas seja o trunfo
   * (os pontos extras valem mais, então só compensa para quem está perdendo).
   */
  function decideKnock(match, p, rng) {
    if (!B.canKnock(match)) return false;
    rng = rng || Math.random;
    const mine = match.n === 4 ? p & 1 : p;
    const behind = match.sets[1 - mine] - match.sets[mine];
    if (behind >= 2) return true;
    if (behind === 1) return rng() < 0.4;
    return false;
  }

  return { choose, decideKnock, heuristicChoose, mcChoose, sampleWorld, PARAMS, PARAMS_4P };
});
