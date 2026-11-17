/**
 * Lichess takeover bridge.
 *
 * Connects the local lc0 engine bridge (server.js, ws://127.0.0.1:8642) to a
 * lichess.org game running in the user's Chrome. Scope:
 *   - ANY already-started game in which the logged-in user is a player:
 *     computer (Stockfish AI) games at any level/colour/variant chess.js can
 *     replay, online human games on normal accounts, and online games on
 *     BOT-flagged accounts. All three take the same takeover path.
 *   - spectator/watcher views and already-finished games are NOT taken over.
 *
 * Note: engine assistance in human games on a normal account violates the
 * lichess fair-play policy (risk of account closure); BOT-flagged accounts are
 * the sanctioned option. The bridge still takes over human games by design.
 *
 * It only TAKES OVER an already-started game once the board is laid out. It
 * never starts games, never clicks rematch/resign/draw or any other UI button -
 * the only page elements it clicks are board squares and promotion pieces.
 *
 *   lichess.org (Chrome tab)
 *         ^  CDP trusted input / DOM snapshots
 *         |
 *   lichess-bridge.js  <--ws-->  server.js  <--wsl/docker-->  lc0 (UCI)
 *
 * Requirements:
 *   - Chrome with remote debugging enabled (chrome://inspect/#remote-debugging)
 *   - chrome-auto-connect-win daemon (auto-started here on a best-effort basis)
 *   - server.js running (start-engine.cmd)
 *
 * Node >= 22. No dependencies beyond the project's existing ws + chess.js.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { Chess } = require('chess.js');

// ---- Configuration: edit config.json (bridge section), same keys as before ----
const CONFIG = require('./config').bridge;

// CLI: node lichess-bridge.js [--movetime <ms>]
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--movetime' && process.argv[i + 1]) {
    const v = parseInt(process.argv[++i], 10);
    if (v > 0) CONFIG.movetimeMs = v;
  } else if (process.argv[i] === '--debug-port' && process.argv[i + 1]) {
    const p = parseInt(process.argv[++i], 10);
    if (p > 0) CONFIG.debugPort = p;
  } else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    console.log('Usage: node lichess-bridge.js [--movetime <ms>] [--debug-port <port>]');
    console.log('Manually start a lichess game in Chrome first (computer, human, or BOT account); the bridge takes over our moves once the board is laid out.');
    console.log('Spectator views and finished games are not taken over. Note: engine use in human games on normal accounts violates lichess fair-play rules (use at your own risk).');
    console.log('--debug-port <port>: connect to Chrome on a fixed remote-debugging port (e.g. 9222) instead of the DevToolsActivePort file; handy for self-test.');
    process.exit(0);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
function log(...args) { console.log(`[${stamp()}]`, ...args); }
const throttleMap = new Map();
function logThrottled(key, ms, ...args) {
  const now = Date.now();
  if (now - (throttleMap.get(key) || 0) >= ms) { throttleMap.set(key, now); log(...args); }
}

// Lichess game ids are 8 chars on older games and 12 chars on newer ones.
const GAME_URL_RE = /^https?:\/\/(?:www\.)?lichess\.org\/(?:game\/)?([A-Za-z0-9]{8,12})(?:[/?#]|$)/;
const ROLE_CODE = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };
const PROMO_ROLE = { q: 'queen', n: 'knight', r: 'rook', b: 'bishop' };

// ---------------------------------------------------------------------------
// Page-side functions. Serialized with toString() and run via Runtime.evaluate,
// so they must be fully self-contained. All selectors are semantic (stable
// classes/ids); lichess randomizes its custom element tags per release, so we
// anchor on a.analysis + SAN text instead of tag names.
// ---------------------------------------------------------------------------

function pageSnapshot() {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const url = location.href;
  const idMatch = url.match(/lichess\.org\/(?:game\/)?([A-Za-z0-9]{8,12})(?:[/?#]|$)/);
  // The round page also renders mini-game boards in the sidebar, all using
  // cg-board. Scope everything to the main board inside .round__app.
  const wrap = q('.round__app .cg-wrap') || q('.cg-wrap');
  const board = wrap ? wrap.querySelector('cg-board') : null;
  const rect = board ? board.getBoundingClientRect() : null;
  const black = !!wrap && wrap.classList.contains('orientation-black');

  // Glicko/round data embedded by lichess as <script id="page-init-data">.
  // Player pages always include a "userId" key (null for anonymous users);
  // watcher/spectator pages omit it. `data.player` is always the side the page
  // belongs to, independent of board orientation.
  let init = null;
  try {
    const el = document.getElementById('page-init-data');
    if (el) init = JSON.parse(el.textContent || '{}');
  } catch { init = null; }
  const pd = init && init.data && init.data.player && init.data.opponent ? init.data : null;
  const playerPage = !!(init && Object.prototype.hasOwnProperty.call(init, 'userId'));
  const norm = (c) => (c === 'white' ? 'w' : c === 'black' ? 'b' : null);

  // Names shown in the metadata box, indexed by colour (language independent).
  // The new round UI no longer ships #page-init-data, so identity comes from
  // <body data-user> matched against the player box instead.
  const names = {};
  for (const p of qa('.game__meta__players .player')) {
    const color = p.classList.contains('white') ? 'w' : p.classList.contains('black') ? 'b' : null;
    if (color) names[color] = (p.textContent || '').replace(/\s+/g, ' ').trim();
  }
  const myUser = ((document.body && document.body.getAttribute('data-user')) || '').toLowerCase() || null;
  const tokenMatch = (txt) => !!myUser && (txt || '').toLowerCase().split(/\s+/).some((t) => t === myUser);
  const ourSeat = !myUser ? null
    : tokenMatch(names.w) ? 'w'
    : tokenMatch(names.b) ? 'b'
    : null;

  // Our colour: authoritative from round JSON or the logged-in seat; otherwise
  // fall back to the side at the bottom (lichess orients the player that way).
  let ourColor = pd ? norm(pd.player.color) : null;
  if (!ourColor) ourColor = ourSeat;
  if (!ourColor) ourColor = black ? 'b' : 'w';
  const opponentColor = ourColor === 'w' ? 'b' : 'w';
  const ourUser = pd && pd.player.user ? pd.player.user : null;
  const oppUser = pd && pd.opponent.user ? pd.opponent.user : null;
  const aiLevel = pd && pd.opponent.ai != null ? pd.opponent.ai : null;
  const ourName = ourUser ? ourUser.username : (names[ourColor] || null);
  const opponentName = oppUser ? oppUser.username : (names[opponentColor] || null);

  // Move list: SAN leaves under .round__app. Anchoring on a.analysis no longer
  // works - that link only exists once the game is over, so the move list was
  // invisible while playing. Custom element tags inside are randomized per
  // release, but the .round__app class is stable.
  // Tight SAN: a capture always carries a piece letter or file before the x,
  // so bare "xc6" (a plausible username) is not a SAN.
  const SAN_RE = /^(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?$/;
  let sans = [];
  const moveRoot = q('.round__app') || q('main.round');
  if (moveRoot) {
    // Usernames can look like SAN ("xc6", "b1", "Nf3"): exclude player boxes,
    // user links and chat. Move nodes themselves are never inside anchors.
    sans = Array.from(moveRoot.querySelectorAll('*'))
      .filter((e) => e.children.length === 0 && !e.closest('cg-board, a, .ruser, .game__meta, .mchat') && SAN_RE.test((e.textContent || '').trim()))
      .map((e) => e.textContent.trim());
  }
  // The move count is sans.length. Do NOT derive it from button[data-ply]:
  // in the current lichess round UI those are navigation buttons (first/prev/
  // next/last), whose data-ply is a navigation target that shifts when browsing
  // history or when a draw/takeback offer adds a node - not the move count.
  // Desync is guarded by replaySans validity + piecesMatch below instead.

  // Piece placement from chessground transforms (skip animation artifacts).
  const pieces = {};
  let animating = false;
  if (board && rect && rect.width > 0) {
    const sq = rect.width / 8;
    for (const p of board.querySelectorAll('piece')) {
      const cl = p.classList;
      if (cl.contains('ghost') || cl.contains('fade') || cl.contains('dragging')) continue;
      if (cl.contains('anim')) { animating = true; continue; }
      const color = cl.contains('white') ? 'w' : cl.contains('black') ? 'b' : null;
      const role = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'].find((r) => cl.contains(r));
      if (!color || !role) continue;
      const tm = /translate\(\s*(-?[\d.]+)px[,\s]+(-?[\d.]+)px/.exec(p.style.transform || '');
      if (!tm) continue;
      const col = Math.round(parseFloat(tm[1]) / sq);
      const row = Math.round(parseFloat(tm[2]) / sq);
      if (col < 0 || col > 7 || row < 0 || row > 7) continue;
      const file = black ? 7 - col : col;
      const rank = black ? row + 1 : 8 - row;
      pieces['abcdefgh'[file] + rank] = color + { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' }[role];
    }
  }

  // Clocks: <div class="rclock rclock-white|black"> with "running" on the side
  // whose clock ticks. Absent for untimed AI games. "running" is the most
  // reliable live signal that the game has actually started.
  const parseSec = (txt) => {
    const m = /(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d))?/.exec((txt || '').replace(/\s+/g, ''));
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]);
    return m[3] != null ? a * 3600 + b * 60 + Number(m[3]) : a * 60 + b;
  };
  const clocks = qa('.rclock').map((el) => {
    const color = el.classList.contains('rclock-white') ? 'w'
      : el.classList.contains('rclock-black') ? 'b' : null;
    if (!color) return null;
    const time = el.querySelector('.time');
    return {
      color,
      running: el.classList.contains('running'),
      clockSec: parseSec(time ? time.textContent : ''),
    };
  }).filter(Boolean);
  const ourClock = clocks.find((c) => c.color === ourColor) || null;
  const clockRunning = clocks.some((c) => c.running);

  // End of game: client-rendered result banner, server-rendered meta status,
  // or the rematch controls.
  const finished = !!q('.result-wrap p.status, .game__meta .status, button.rematch, .fbt.rematch, .rematch-decline');

  const promo = q('#promotion-choice');
  return {
    url,
    gameId: idMatch ? idMatch[1] : null,
    isRound: !!q('main.round'),
    boardReady: !!(wrap && board && rect && rect.width > 0),
    orientation: black ? 'b' : 'w',
    isPlayer: playerPage || ourSeat !== null || !!q('.fbt.resign'), // players only; spectators have neither
    ourColor, ourName, opponentColor, opponentName,
    opponentIsAi: aiLevel !== null || /stockfish/i.test(names[opponentColor] || ''),
    ourIsBot: !!(ourUser && ourUser.title === 'BOT'), // lichess BOT accounts may use engines
    variant: pd && pd.game && pd.game.variant ? pd.game.variant.key : null,
    initialFen: pd && pd.game && pd.game.initialFen ? pd.game.initialFen : null,
    clockRunning,
    ourClockSec: ourClock ? ourClock.clockSec : null,
    // Untimed games have no clocks; moves>0 also implies a live game.
    started: clockRunning || clocks.length === 0 || sans.length > 0,
    finished,
    sans,
    pieces,
    animating,
    promotion: promo
      ? Array.from(promo.querySelectorAll('square piece'))
          .map((p) => Array.from(p.classList).find((c) => ['queen', 'knight', 'rook', 'bishop', 'king'].includes(c)))
          .filter(Boolean)
      : null,
  };
}

function pageGeometry() {
  const wrap = document.querySelector('.round__app .cg-wrap') || document.querySelector('.cg-wrap');
  const board = wrap && wrap.querySelector('cg-board');
  if (!board || !wrap) return null;
  board.scrollIntoView({ block: 'center', inline: 'center' });
  const r = board.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, black: wrap.classList.contains('orientation-black') };
}

function pagePromoPos(role, color) {
  const promo = document.querySelector('#promotion-choice');
  if (!promo) return null;
  for (const sq of promo.querySelectorAll('square')) {
    if (sq.querySelector('piece.' + role + '.' + color)) {
      const r = sq.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CDP client (minimal JSON-RPC over WebSocket, flattened sessions).
// ---------------------------------------------------------------------------

function readEndpoint() {
  const lines = fs.readFileSync(CONFIG.portFile, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0 || !lines[1] || !lines[1].startsWith('/')) {
    throw new Error('Invalid DevToolsActivePort content');
  }
  return { port, wsEndpoint: `ws://127.0.0.1:${port}${lines[1]}` };
}

// Resolve the browser-level CDP endpoint. With --debug-port we query that port's
// /json/version directly (no DevToolsActivePort file needed); otherwise read the file.
async function resolveEndpoint() {
  if (CONFIG.debugPort > 0) {
    const r = await fetch(`http://127.0.0.1:${CONFIG.debugPort}/json/version`);
    const j = await r.json();
    const m = /^ws:\/\/127\.0\.0\.1:(\d+)(\/.*)$/.exec(j.webSocketDebuggerUrl || '');
    if (!m) throw new Error('Invalid /json/version response on port ' + CONFIG.debugPort);
    return { port: Number(m[1]), wsEndpoint: j.webSocketDebuggerUrl };
  }
  return readEndpoint();
}

function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

class CdpClient {
  constructor() { this.ws = null; this.connected = false; this.nextId = 0; this.pending = new Map(); }

  async connect() {
    const { wsEndpoint } = await resolveEndpoint();
    const ws = new WebSocket(wsEndpoint);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('CDP connection timeout (check the "Allow remote debugging" dialog)')), 20000);
      ws.once('open', () => { clearTimeout(t); res(); });
      ws.once('error', (e) => { clearTimeout(t); rej(e); });
    });
    this.ws = ws;
    this.connected = true;
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    ws.on('close', () => {
      this.connected = false;
      for (const { rej } of this.pending.values()) rej(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    if (!this.connected) return Promise.reject(new Error('CDP not connected'));
    return new Promise((res, rej) => {
      const id = ++this.nextId;
      const t = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP command timeout: ' + method)); }
      }, 15000);
      this.pending.set(id, {
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async pages() {
    const { targetInfos } = await this.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page');
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      throw new Error('Page script exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  // Trusted mouse click - chessground ignores synthetic JS PointerEvents
  // (setPointerCapture fails for fake pointer ids), so all board input goes
  // through the browser-level Input domain.
  async click(sessionId, x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  }

  close() { try { this.ws && this.ws.close(); } catch { /* already closed */ } this.connected = false; }
}

// Best-effort: keep the chrome-auto-connect-win watcher running so Chrome's
// "Allow remote debugging?" dialog is clicked automatically.
function ensureDaemon() {
  try {
    // Single command string (constant args) avoids the shell+args deprecation.
    const r = spawnSync(`${CONFIG.daemonCli} status --json --no-page-check`, { shell: true, encoding: 'utf8', timeout: 20000, windowsHide: true });
    const status = JSON.parse(r.stdout || '{}');
    if (status.daemon && status.daemon.running) return;
    spawn(`${CONFIG.daemonCli} start --no-connect`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('Started chrome-auto-connect-win daemon (auto-clicks the remote-debugging confirmation dialog)');
  } catch (e) {
    log('Note: cannot manage chrome-auto-connect-win automatically (' + e.message + '). If Chrome shows "Allow remote debugging", click Allow manually.');
  }
}

async function waitForChrome() {
  for (;;) {
    try {
      const { port } = await resolveEndpoint();
      if (await probePort(port)) return;
      logThrottled('chrome-stale', 10000, 'Chrome debugging endpoint is stale, waiting for Chrome to start…');
    } catch {
      logThrottled('chrome-missing', 10000, CONFIG.debugPort > 0
        ? `Cannot reach Chrome debugging port ${CONFIG.debugPort}. Start Chrome with --remote-debugging-port=${CONFIG.debugPort}.`
        : 'Chrome debugging port not found. Start Chrome, enable remote debugging at chrome://inspect/#remote-debugging, then restart Chrome.');
    }
    await sleep(2000);
  }
}

// ---------------------------------------------------------------------------
// Page agent: snapshots and move input for one attached tab.
// ---------------------------------------------------------------------------

class PageAgent {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sid = sessionId; }

  snapshot() { return this.cdp.evaluate(this.sid, `(${pageSnapshot.toString()})()`); }

  async playMove(from, to) {
    const geo = await this.cdp.evaluate(this.sid, `(${pageGeometry.toString()})()`);
    if (!geo) throw new Error('Board not found');
    const center = (name) => {
      const sq = geo.w / 8;
      const f = name.charCodeAt(0) - 97;
      const rank = Number(name[1]);
      const col = geo.black ? 7 - f : f;
      const row = geo.black ? rank - 1 : 8 - rank;
      return { x: geo.x + (col + 0.5) * sq, y: geo.y + (row + 0.5) * sq };
    };
    const a = center(from);
    await this.cdp.click(this.sid, a.x, a.y);
    await sleep(CONFIG.clickGapMs);
    const b = center(to);
    await this.cdp.click(this.sid, b.x, b.y);
  }

  async choosePromotion(role, color) {
    const pos = await this.cdp.evaluate(this.sid, `(${pagePromoPos.toString()})(${JSON.stringify(role)}, ${JSON.stringify(color)})`);
    if (!pos) return false;
    await this.cdp.click(this.sid, pos.x, pos.y);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Engine client: drives the UCI handshake over the server.js WS protocol.
// ---------------------------------------------------------------------------

class EngineClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.ready = false;
    this.pending = null;       // { resolve, timer }
    this.ignoreBestmove = false;
    this.stopped = false;
  }

  start() { this.stopped = false; this._connect(); }

  _connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      log('Connected to engine bridge ' + this.url + ', starting UCI handshake');
      this._send('uci');
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._handle(msg);
    });
    ws.on('close', () => {
      this.ready = false;
      this._resolvePending(null);
      if (!this.stopped) {
        logThrottled('engine-reconnect', 5000, 'Engine bridge disconnected, reconnecting in 2s… (make sure start-engine.cmd is running)');
        setTimeout(() => this._connect(), 2000);
      }
    });
    ws.on('error', () => { /* close event follows */ });
  }

  _send(cmd) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cmd', cmd }));
    }
  }

  _handle(msg) {
    if (msg.type === 'status') {
      if (msg.dead) { this.ready = false; this._resolvePending(null); }
      return;
    }
    if (msg.type === 'reset') {
      // Backend spawned a fresh engine process: redo the handshake.
      this.ready = false;
      this.ignoreBestmove = false;
      this._resolvePending(null);
      log('Engine process reset, re-handshaking');
      this._send('uci');
      return;
    }
    if (msg.type !== 'engine') return;
    const line = msg.line;
    if (line === 'uciok') {
      this._send(`setoption name Threads value ${CONFIG.threads}`);
      this._send('isready');
      return;
    }
    if (line === 'readyok') {
      if (!this.ready) log('Engine ready');
      this.ready = true;
      return;
    }
    if (line.startsWith('bestmove')) {
      if (this.ignoreBestmove) { this.ignoreBestmove = false; return; } // late reply to a stopped search
      const uci = line.split(/\s+/)[1];
      this._resolvePending(uci || null);
    }
  }

  _resolvePending(uci) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const { resolve } = this.pending;
    this.pending = null;
    resolve(uci);
  }

  /** Request a move for the given FEN. Resolves with the UCI move or null. */
  requestMove(fen, movetimeMs) {
    if (!this.ready || this.pending) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Watchdog: stop the search and drop its late bestmove.
        this.ignoreBestmove = true;
        this._send('stop');
        this._resolvePending(null);
        log('Engine search timed out, sent stop');
      }, movetimeMs + CONFIG.engineWatchdogMs);
      this.pending = { resolve, timer };
      this._send('position fen ' + fen);
      this._send('go movetime ' + movetimeMs);
    });
  }

  cancel() {
    if (this.pending) {
      this.ignoreBestmove = true;
      this._send('stop');
      this._resolvePending(null);
    }
  }

  newGame() { this._send('ucinewgame'); }

  stop() {
    this.stopped = true;
    this.cancel();
    try { this.ws && this.ws.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Controller: the takeover state machine.
// ---------------------------------------------------------------------------

function replaySans(sans, initialFen) {
  let chess;
  try { chess = initialFen ? new Chess(initialFen) : new Chess(); } catch { return null; }
  for (const san of sans) {
    try { chess.move(san); } catch { return null; }
  }
  return chess;
}

function piecesMatch(chess, pieces) {
  const expected = {};
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) expected[cell.square] = cell.color + cell.type.toUpperCase();
    }
  }
  const ek = Object.keys(expected), pk = Object.keys(pieces);
  if (ek.length !== pk.length) return false;
  return ek.every((k) => pieces[k] === expected[k]);
}

class Controller {
  constructor(engine) {
    this.engine = engine;
    this.cdp = null;
    this.targetId = null;
    this.sid = null;
    this.agent = null;
    this.gameId = null;
    this.thinking = false;
    this.doneGames = new Set();
    this.warned = new Set();
    this.frontedGame = null;
  }

  warnOnce(key, ...args) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log(...args);
  }

  // Online games are clocked: never spend more time than we can afford.
  // Unknown clocks (untimed AI games, correspondence) use the configured time.
  thinkTime(clockSec) {
    if (clockSec == null) return CONFIG.movetimeMs;
    const budget = clockSec * 1000 - CONFIG.clockSafetyMs;
    return Math.max(CONFIG.minMoveTimeMs, Math.min(CONFIG.movetimeMs, budget));
  }

  async ensureCdp() {
    if (this.cdp && this.cdp.connected) return;
    await waitForChrome();
    const cdp = new CdpClient();
    await cdp.connect();
    this.cdp = cdp;
    this.targetId = null;
    this.sid = null;
    this.agent = null;
    log('CDP connected');
  }

  // Chrome pauses requestAnimationFrame for hidden/occluded pages, which
  // freezes chessground move animations and leaves piece transforms stale.
  // Focus emulation keeps the page rendering regardless of window visibility.
  async keepRendering() {
    if (!this.cdp || !this.sid) return;
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, this.sid).catch(() => {});
    await this.cdp.send('Page.setWebLifecycleState', { state: 'active' }, this.sid).catch(() => {});
  }

  async tick() {
    await this.ensureCdp();
    const allTabs = await this.cdp.pages();
    const tabs = allTabs.filter((p) => GAME_URL_RE.test(p.url));
    if (!tabs.length) {
      this.targetId = null; this.sid = null; this.agent = null; this.gameId = null;
      const seen = allTabs.slice(0, 6).map((p) => p.url).join(' | ') || 'none';
      logThrottled('no-tab', 10000, `Waiting for a lichess game tab… (start a game manually in Chrome; the bridge takes over but never starts games) current tabs: ${seen}`);
      return;
    }
    const tab = tabs.find((t) => t.targetId === this.targetId) || tabs[0];
    if (tab.targetId !== this.targetId) {
      this.targetId = tab.targetId;
      this.sid = await this.cdp.attach(tab.targetId);
      this.agent = new PageAgent(this.cdp, this.sid);
      this.gameId = null;
      await this.keepRendering();
      log('Attached game tab: ' + tab.url);
    }

    const snap = await this.agent.snapshot();

  // -- 1. Board-ready gate --
  if (!snap.isRound || !snap.boardReady) {
    logThrottled('no-board', 5000, 'Board not laid out yet, waiting…');
    return;
  }

  // -- 2. Game switch: decide identity in one place --
  if (snap.gameId !== this.gameId) {
    this.gameId = snap.gameId;
    this.warned.clear();

    const spectator     = !snap.isPlayer;
    const humanVsHuman  = !snap.opponentIsAi && !snap.ourIsBot; // online human game
    const alreadyDone   = this.doneGames.has(snap.gameId);

    //   Human games are no longer excluded; they take the same entry as bot games
    this.takeover     = !spectator && !alreadyDone;
    this.isHumanGame  = humanVsHuman;

    const mode = snap.opponentIsAi ? 'vs computer'
               : snap.ourIsBot     ? 'BOT-account online'
               :                     'online human';
    log(`Detected game ${snap.gameId} (${snap.ourName || '?'} vs ${snap.opponentName || '?'}, ${mode}${snap.variant ? '/' + snap.variant : ''})`);

    // Only reset the engine when actually taking over; leave spectator/finished games alone
    if (this.takeover && !this.thinking && this.engine.ready) {
      this.engine.newGame();
      this.engineGameId = snap.gameId;
    }
  }

  // -- 3. Fast skip conditions --
  if (this.doneGames.has(this.gameId)) return;

  if (snap.finished) {
    log(`Game ${this.gameId} finished, releasing takeover (waiting for the next manually started game)`);
    this.doneGames.add(this.gameId);
    this.takeover = false;
    return;
  }

  if (!snap.isPlayer) {
    this.warnOnce('spectator', 'Spectator view, not taking over');
    return;
  }

  if (!this.takeover) {
    // Defensive fallback: spectator/finished games already returned above; normal flow never reaches here
    this.warnOnce('no-takeover', 'Not taking over this game');
    return;
  }

  // Human games are taken over too; notify once, do not block the flow
  if (this.isHumanGame) {
    this.warnOnce('human-game', 'Online human game, takeover active');
  }

  // -- 4. Catch up the newGame skipped while thinking --
  if (!this.thinking && this.engine.ready && this.engineGameId !== this.gameId) {
    this.engine.newGame();
    this.engineGameId = this.gameId;
  }

    const chess = replaySans(snap.sans, snap.initialFen);
    if (!chess) { this.warnOnce('bad-sans', 'Failed to replay the move list, not taking over this game'); return; }
    if (chess.isGameOver()) {
      log(`Game ${this.gameId} over by rules, releasing takeover`);
      this.doneGames.add(this.gameId);
      return;
    }
    if (!piecesMatch(chess, snap.pieces)) {
      if (snap.animating) {
        // A stuck animation means the page stopped rendering: re-assert the
        // emulation so chessground can finish and the board catches up.
        logThrottled('frozen-anim', 5000, 'Frozen animation detected (page occluded/background), re-enabled rendering emulation');
        await this.keepRendering();
      } else {
        logThrottled('out-of-sync', 5000, 'Board and move list out of sync (custom start position or browsing history?), pausing takeover until synced');
      }
      return;
    }
    // A created game that is still waiting for its opponent has no running
    // clock; never click the board before the game actually begins.
    if (!snap.started) {
      logThrottled('not-started', 5000, 'Game not started yet (clock not running), not moving');
      return;
    }
    if (chess.turn() !== snap.ourColor) return; // opponent to move
    if (this.thinking) return;
    if (!this.engine.ready) { logThrottled('engine-wait', 5000, 'Engine not ready, waiting…'); return; }

    // ---- Our turn: take over and play. ----
    if (this.frontedGame !== this.gameId) {
      this.frontedGame = this.gameId;
      await this.cdp.send('Page.bringToFront', {}, this.sid).catch(() => {});
      log(`Taking over game ${this.gameId}: we play ${snap.ourColor === 'w' ? 'white' : 'black'}, opponent ${snap.opponentName}`);
    }
    this.thinking = true;
    try {
      const fen = chess.fen();
      const ply = snap.sans.length;
      const thinkMs = this.thinkTime(snap.ourClockSec);
      const uci = await this.engine.requestMove(fen, thinkMs);
      if (!uci || uci === '(none)') { log('Engine returned no move, skipping'); return; }

      // Discard the result if the position changed while searching (takeback,
      // manual move, game end, tab switch...).
      const s2 = await this.agent.snapshot();
      if (s2.gameId !== this.gameId || s2.finished || s2.sans.length !== ply) {
        log('Position changed during search, discarding this engine result');
        return;
      }
      const probe = new Chess(fen);
      let mv;
      try {
        mv = probe.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
      } catch {
        log('Illegal engine move: ' + uci + ', skipping');
        return;
      }

      // Play the move, retrying on input/verification failure: the user's own
      // mouse (or a transient page state) can swallow a click. If a DIFFERENT
      // move landed meanwhile, retrying the engine move would be illegal -
      // discard it and let the next tick resync from the new move list.
      let played = false;
      for (let attempt = 1; attempt <= CONFIG.moveAttempts; attempt++) {
        if (attempt > 1) {
          await sleep(CONFIG.retryGapMs);
          const sr = await this.agent.snapshot();
          if (sr.gameId !== this.gameId || sr.finished || sr.sans.length !== ply) {
            log('Position changed before retry, discarding this engine result');
            return;
          }
        }
        try {
          await this.agent.playMove(mv.from, mv.to);
        } catch (e) {
          log(`Move input failed (attempt ${attempt}/${CONFIG.moveAttempts}): ${e.message}`);
          continue;
        }

        if (uci.length > 4) {
          // Promotion: click the matching piece if the dialog appears. With the
          // lichess autoQueen preference set to "Always" no dialog shows up and
          // the move completes as a queen - verifyMove catches any mismatch.
          const role = PROMO_ROLE[uci[4]] || 'queen';
          const color = snap.ourColor === 'w' ? 'white' : 'black';
          const deadline = Date.now() + CONFIG.promoWaitMs;
          while (Date.now() < deadline) {
            const s3 = await this.agent.snapshot();
            if (s3.promotion) {
              const ok = await this.agent.choosePromotion(role, color);
              if (!ok) log('Promotion dialog has no matching piece: ' + role);
              break;
            }
            if (s3.sans.length > ply) break; // auto-queen already completed it
            await sleep(150);
          }
        }

        if (await this.verifyMove(ply, mv.san)) {
          log(`Played ${mv.san} (${uci})` + (attempt > 1 ? ` [attempt ${attempt}]` : ''));
          played = true;
          break;
        }
        const sr = await this.agent.snapshot();
        if (sr.sans[ply] === mv.san) { played = true; break; } // landed just after the verify deadline
        if (sr.gameId !== this.gameId || sr.finished || sr.sans.length > ply) {
          log('A different move landed or the game ended, resyncing from the move list');
          return;
        }
        log(`Move did not register (attempt ${attempt}/${CONFIG.moveAttempts})` + (attempt < CONFIG.moveAttempts ? ', retrying…' : ''));
      }
      if (!played) {
        log(`⚠ Move failed after ${CONFIG.moveAttempts} attempts (expected ${mv.san}), stopping takeover of this game to avoid desync. Check the page, then refresh or start a new game.`);
        this.doneGames.add(this.gameId);
      }
    } finally {
      this.thinking = false;
    }
  }

  async verifyMove(ply, expectedSan) {
    const deadline = Date.now() + CONFIG.verifyTimeoutMs;
    while (Date.now() < deadline) {
      const snap = await this.agent.snapshot();
      if (snap.sans[ply] === expectedSan) return true;
      if (snap.sans.length > ply && snap.sans[ply] !== expectedSan) return false;
      if (snap.finished) return false; // game over before our move landed
      await sleep(200);
    }
    return false;
  }

  async run() {
    log('lc0 lichess takeover bridge started');
    log(`Engine bridge: ${CONFIG.engineUrl} · think time: ${CONFIG.movetimeMs}ms per move (auto-shortened when a clock is present)`);
    log('Scope: any already-started game (computer / human / BOT account); spectators and finished games excluded. Never starts games, resigns, or rematches.');
    ensureDaemon();
    this.engine.start();
    for (;;) {
      try {
        await this.tick();
      } catch (e) {
        log('Poll error: ' + e.message);
        // A detached session (tab closed/navigated) must be re-attached.
        this.targetId = null; this.sid = null; this.agent = null;
        if (this.cdp && !this.cdp.connected) this.cdp = null;
        await sleep(1000);
      }
      await sleep(CONFIG.pollMs);
    }
  }
}

// ---- Graceful shutdown: stop searching, close sockets, leave server.js alone ----
const engine = new EngineClient(CONFIG.engineUrl);
const controller = new Controller(engine);
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down…');
  engine.stop();
  if (controller.cdp) controller.cdp.close();
  setTimeout(() => process.exit(0), 300);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);

controller.run().catch((e) => { console.error('Fatal error:', e); process.exit(1); });
