/*
 * Bisca – servidor: arquivos do jogo + salas online (WebSocket em /ws).
 * O servidor é quem embaralha e decide as jogadas; cada jogador só recebe as próprias cartas.
 * Lugares sem pessoa (ou de quem caiu/saiu) são jogados pelo computador.
 *
 *   node server.js        (porta em PORT, padrão 5173)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const B = require('./engine.js');
const AI = require('./ai.js');

const PORT = Number(process.env.PORT) || 5173;
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/ai.js': ['ai.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LEVELS = ['easy', 'medium', 'hard'];
const LOBBY_GRACE = 30000;        // quem cai na sala de espera tem 30 s para voltar ao lugar
const ROOM_IDLE = 20 * 60000;     // sala sem ninguém conectado é apagada depois de 20 min
const DELAY = Number(process.env.BISCA_DELAY_SCALE) || 1; // < 1 acelera as pausas (testes)

/* ---------- Arquivos ---------- */

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const f = FILES[url];
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Não encontrado'); return; }
  fs.readFile(path.join(__dirname, f[0]), (err, data) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

/* ---------- Salas ---------- */

const rooms = new Map();

function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

const cleanName = (s) => String(s || '').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Jogador';

function cleanOpts(o) {
  o = o || {};
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  return {
    n: o.mode === '2v2' ? 4 : 2,
    rules: pick(o.rules, ['classic', 'capixaba'], 'classic'),
    target: pick(Number(o.target), [1, 2, 3], 2),
    p120: pick(Number(o.p120), [2, 3, 4], 4),
    hs: pick(Number(o.hs), [3, 7, 9], 3),
    level: pick(o.level, LEVELS, 'medium')
  };
}

/** Lugar ocupado por uma pessoa conectada? (senão o computador joga por ele) */
const isLive = (seat) => !!(seat && !seat.left && seat.ws);
const humans = (room) => room.seats.filter((s) => s && !s.left);

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
/** Envia a cada pessoa da sala; fn(seatIndex) monta a mensagem personalizada. */
function each(room, fn) {
  room.seats.forEach((s, i) => { if (s && s.ws && !s.left) send(s.ws, fn(i)); });
}

function seatName(room, i) {
  const s = room.seats[i];
  if (s && !s.left) return s.name;
  return room.botNames[i];
}

function roomInfo(room, me) {
  return {
    t: 'room', code: room.code, you: me, host: room.host, phase: room.phase,
    opts: room.opts,
    seats: room.seats.map((s, i) => ({
      name: seatName(room, i), human: !!(s && !s.left), online: isLive(s)
    }))
  };
}
const broadcastRoom = (room) => each(room, (i) => roomInfo(room, i));

function createRoom(opts) {
  const o = cleanOpts(opts);
  const room = {
    code: newCode(), opts: o, n: o.n,
    seats: new Array(o.n).fill(null), host: 0,
    botNames: [], phase: 'lobby', match: null, H: null,
    timer: null, gen: 0, idleSince: 0
  };
  for (let i = 0; i < o.n; i++) room.botNames.push('Computador');
  if (o.n === 4) room.botNames = ['Computador 1', 'Computador 2', 'Computador 3', 'Computador 4'];
  rooms.set(room.code, room);
  return room;
}

function freeSeat(room) {
  for (let i = 0; i < room.n; i++) if (!room.seats[i] || room.seats[i].left) return i;
  return -1;
}

function pickHost(room) {
  const h = room.seats[room.host];
  if (h && !h.left) return;
  const i = room.seats.findIndex((s) => s && !s.left);
  room.host = i < 0 ? 0 : i;
}

/* ---------- Partida ---------- */

function later(room, ms, fn) {
  clearTimeout(room.timer);
  const g = room.gen;
  room.timer = setTimeout(() => { if (g === room.gen) fn(); }, ms * DELAY);
}

function matchInfo(room) {
  const m = room.match;
  return {
    t: 'match', n: m.n, hs: m.hs, rules: m.rules, target: m.target, p120: m.p120,
    sets: m.sets, dealer: m.dealer, handNo: m.handNo, names: room.seats.map((_, i) => seatName(room, i))
  };
}

/** O que o jogador do lugar `seat` pode ver da mão em andamento. */
function viewFor(room, seat) {
  const H = room.H, m = room.match;
  return {
    n: H.n, hs: H.hs, dealer: H.dealer, hand: H.hands[seat].slice(),
    counts: H.hands.map((h) => h.length), stockLen: H.stock.length,
    trumpCard: H.trumpCard, trump: H.trump, trumpHolder: H.trumpHolder,
    trick: H.trick.map((t) => ({ p: t.p, c: t.c })), leader: H.leader, turn: H.turn,
    pts: H.pts, bonus: H.bonus, events: H.events, over: H.over, reason: H.reason,
    rules: H.rules, knocked: H.knocked, trump7Out: H.trump7Out, trickNo: H.trickNo,
    handNo: m.handNo, sets: m.sets, target: m.target, p120: m.p120
  };
}

function startMatch(room) {
  room.gen++;
  room.match = B.newMatch({ n: room.n, hs: room.opts.hs, target: room.opts.target, rules: room.opts.rules, p120: room.opts.p120 });
  room.phase = 'play';
  broadcastRoom(room);
  beginHand(room);
}

function beginHand(room) {
  room.gen++;
  const m = room.match;
  room.H = null;
  each(room, () => matchInfo(room));
  if (B.canKnock(m)) {
    const cutter = B.cutterOf(m);
    if (isLive(room.seats[cutter])) {
      room.phase = 'knock';
      room.cutter = cutter;
      each(room, (i) => (i === cutter ? { t: 'knockAsk', sets: m.sets, target: m.target } : { t: 'knockWait', seat: cutter }));
      return;
    }
    dealHand(room, AI.decideKnock(m, cutter, Math.random));
    return;
  }
  dealHand(room, false);
}

function dealHand(room, knocked) {
  room.gen++;
  room.phase = 'play';
  const H = (room.H = B.startHand(room.match, Math.random, knocked));
  each(room, (i) => ({ t: 'deal', v: viewFor(room, i) }));
  const stagger = H.hs * H.n > 20 ? 42 : 75;
  later(room, H.hs * H.n * stagger + 1200, () => step(room));
}

/** Avança o jogo: recolhe vazas, joga pelo computador ou espera a pessoa da vez. */
function step(room) {
  const H = room.H;
  if (!H) return;
  if (H.over) { endHand(room); return; }
  if (H.turn < 0) {
    const r = B.resolveTrick(H);
    each(room, (i) => ({
      t: 'trick', winner: r.winner, points: r.points, events: r.events,
      draws: r.draws.map((d) => ({ p: d.p, c: d.p === i || d.c === H.trumpCard ? d.c : -1 })),
      pts: H.pts, bonus: H.bonus, over: H.over, reason: H.reason
    }));
    later(room, 1900 + (r.events.length ? 1300 : 0) + r.draws.length * 130, () => step(room));
    return;
  }
  const p = H.turn;
  const seat = room.seats[p];
  if (isLive(seat)) return; // espera a jogada
  // computador (lugar vazio, ou de quem saiu/caiu – neste caso espera um pouco mais)
  const wait = seat && !seat.left ? 2500 : 700 + Math.random() * 600;
  later(room, wait, () => {
    const opts = room.opts.level === 'hard' ? { ms: 250 } : undefined;
    applyPlay(room, p, AI.choose(H, p, room.opts.level, Math.random, opts));
  });
}

function applyPlay(room, p, c) {
  const H = room.H;
  B.play(H, c);
  each(room, () => ({ t: 'play', seat: p, card: c }));
  if (H.turn < 0) later(room, 1000, () => step(room));
  else step(room);
}

function endHand(room) {
  const m = room.match, H = room.H;
  const w = B.finishHand(m, H);
  room.phase = m.over ? 'over' : 'result';
  each(room, () => ({
    t: 'hand', winner: w.winner, gains: w.gains, lines: w.lines, sets: m.sets,
    matchOver: m.over, matchWinner: m.winner, pts: H.pts, reason: H.reason
  }));
}

/* ---------- Mensagens ---------- */

function attach(room, i, ws, name) {
  const s = room.seats[i];
  s.ws = ws;
  if (name) s.name = name;
  ws.room = room;
  ws.seat = i;
  room.idleSince = 0;
  send(ws, { t: 'joined', code: room.code, seat: i, token: s.token });
  broadcastRoom(room);
  if (room.phase !== 'lobby') sendSync(room, i);
}

function sendSync(room, i) {
  const ws = room.seats[i].ws;
  send(ws, matchInfo(room));
  if (room.phase === 'knock') {
    send(ws, i === room.cutter ? { t: 'knockAsk', sets: room.match.sets, target: room.match.target } : { t: 'knockWait', seat: room.cutter });
  } else if (room.H) {
    send(ws, { t: 'sync', v: viewFor(room, i), phase: room.phase, last: room.phase === 'result' || room.phase === 'over' ? lastHand(room) : null });
  }
  // se era a vez dele e o computador ia jogar, devolve a vez
  if (room.phase === 'play' && room.H && room.H.turn === i && !room.H.over) { room.gen++; step(room); }
}

function lastHand(room) {
  const m = room.match;
  return { sets: m.sets, matchOver: m.over, matchWinner: m.winner };
}

function join(ws, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase());
  if (!room) { send(ws, { t: 'error', code: 'noroom', msg: 'Sala não encontrada. Confira o código.' }); return; }
  leave(ws);
  // volta ao próprio lugar com o token salvo no navegador
  const mine = msg.token ? room.seats.findIndex((s) => s && !s.left && s.token === msg.token) : -1;
  if (mine >= 0) {
    const old = room.seats[mine].ws;
    if (old && old !== ws) { old.room = null; send(old, { t: 'kicked', msg: 'Você abriu esta sala em outra janela.' }); }
    attach(room, mine, ws, cleanName(msg.name || room.seats[mine].name));
    return;
  }
  const i = freeSeat(room);
  if (i < 0) { send(ws, { t: 'error', code: 'full', msg: 'A sala está cheia.' }); return; }
  room.seats[i] = { name: cleanName(msg.name), token: crypto.randomBytes(12).toString('hex'), ws: null, left: false };
  pickHost(room);
  attach(room, i, ws);
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  const s = room.seats[ws.seat];
  if (!s || s.ws !== ws) return;
  s.ws = null;
  if (room.phase === 'lobby') room.seats[ws.seat] = null;
  else s.left = true;
  afterLoss(room, ws.seat);
}

/** Alguém saiu ou caiu: troca o anfitrião, e o computador assume se for a vez dele. */
function afterLoss(room, i) {
  pickHost(room);
  if (!room.seats.some(isLive)) room.idleSince = Date.now();
  broadcastRoom(room);
  if (room.phase === 'knock' && room.cutter === i && !isLive(room.seats[i])) dealHand(room, false);
  else if (room.phase === 'play' && room.H && room.H.turn === i) { room.gen++; step(room); }
}

const handlers = {
  create(ws, msg) {
    leave(ws);
    const room = createRoom(msg.opts);
    room.seats[0] = { name: cleanName(msg.name), token: crypto.randomBytes(12).toString('hex'), ws: null, left: false };
    room.host = 0;
    attach(room, 0, ws);
  },
  join,
  leave(ws) { leave(ws); send(ws, { t: 'left' }); },
  sit(ws, msg) {
    const room = ws.room;
    const to = Number(msg.seat);
    if (!room || room.phase !== 'lobby' || !(to >= 0 && to < room.n) || room.seats[to]) return;
    room.seats[to] = room.seats[ws.seat];
    room.seats[ws.seat] = null;
    if (room.host === ws.seat) room.host = to;
    ws.seat = to;
    send(ws, { t: 'joined', code: room.code, seat: to, token: room.seats[to].token });
    broadcastRoom(room);
  },
  start(ws) {
    const room = ws.room;
    if (!room || room.host !== ws.seat || room.phase !== 'lobby') return;
    startMatch(room);
  },
  knock(ws, msg) {
    const room = ws.room;
    if (!room || room.phase !== 'knock' || room.cutter !== ws.seat) return;
    dealHand(room, !!msg.yes);
  },
  play(ws, msg) {
    const room = ws.room;
    const H = room && room.H;
    const c = Number(msg.card);
    if (!H || room.phase !== 'play' || H.over || H.turn !== ws.seat || !B.legalCards(H, ws.seat).includes(c)) {
      const ace = H && B.aceBlocked(H, ws.seat, c);
      send(ws, { t: 'error', code: 'play', msg: ace ? 'O Ás de trunfo só pode sair depois do 7.' : 'Jogada não aceita.' });
      return;
    }
    room.gen++;
    applyPlay(room, ws.seat, c);
  },
  next(ws) {
    const room = ws.room;
    if (!room || room.phase !== 'result') return;
    beginHand(room);
  },
  restart(ws) {
    const room = ws.room;
    if (!room || room.phase !== 'over') return;
    // quem saiu durante a partida libera o lugar
    room.seats = room.seats.map((s) => (s && !s.left ? s : null));
    room.phase = 'lobby';
    pickHost(room);
    broadcastRoom(room);
  }
};

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    const h = msg && Object.prototype.hasOwnProperty.call(handlers, msg.t) && handlers[msg.t];
    if (!h) return;
    try { h(ws, msg); } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    const s = room.seats[ws.seat];
    if (!s || s.ws !== ws) return;
    s.ws = null;
    const i = ws.seat;
    if (room.phase === 'lobby') {
      // dá um tempo para recarregar a página sem perder o lugar
      setTimeout(() => { if (room.phase === 'lobby' && room.seats[i] === s && !s.ws) { room.seats[i] = null; afterLoss(room, i); } }, LOBBY_GRACE);
    }
    afterLoss(room, i);
  });
});

// mantém as conexões vivas atrás de proxies e limpa salas abandonadas
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    ws.ping();
  });
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.idleSince && now - room.idleSince > ROOM_IDLE) { clearTimeout(room.timer); rooms.delete(code); }
  });
}, 25000);

server.listen(PORT, () => console.log(`Bisca em http://localhost:${PORT}`));
