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
 * By default it only TAKES OVER an already-started game once the board is laid
 * out. With bridge.autoStart enabled in config.json it also CREATES games
 * (homepage quick-pairing pools or the AI dialog) and chains to the next one
 * after each finish. It never resigns, rematches, or offers draws; page clicks
 * are limited to board squares, promotion pieces, and (when auto-starting) the
 * homepage pool/AI setup controls.
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
    console.log('Takeover: start a lichess game in Chrome (computer, human, or BOT); the bridge plays our moves once the board is laid out.');
    console.log('Auto-start: set bridge.autoStart=true and bridge.autoMode in config.json ("ai" or a homepage pool id like "5+3"); the bridge creates games and chains to the next after each finish.');
    console.log('Spectator views and finished games are not taken over. Note: engine use in online human games on normal accounts violates lichess fair-play rules (BOT accounts are sanctioned).');
    console.log('--debug-port <port>: connect to Chrome on a fixed remote-debugging port (e.g. 9222) instead of the DevToolsActivePort file; handy for self-test.');
    console.log(`Stop: press "${CONFIG.stopKey}" in this console to finish the current game then exit without starting a new one (Ctrl+C = immediate). Config: bridge.stopKey.`);
    console.log('chrome-auto-connect-win is optional; without it, click "Allow" on Chrome\'s remote-debugging dialog manually.');
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
const HOME_URL_RE = /^https?:\/\/(?:www\.)?lichess\.org\/?($|\?|#)/;
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
  // Opponent abandoned: lichess offers a green "claim victory" button (the draw
  // claim is a plain button, rematch is .fbt.rematch, so green = victory claim).
  const claimVictory = !!q('.round__app .button-green, main.round .button-green');

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
    // Untimed games have no clocks; moves>0 also implies a live game. In online
    // HUMAN games the clock only starts AFTER the first move (lichess shows a
    // "make your first move" countdown instead), so at ply 0 clockRunning is
    // false by design. The resign button only exists once the game is live (a
    // waiting-for-opponent page offers Cancel, not resign), so it marks a
    // started game even before the clock ticks.
    started: clockRunning || clocks.length === 0 || sans.length > 0 || !!q('.fbt.resign'),
    finished,
    claimVictory,
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

// Homepage lobby state. Anchors are locale-independent: pool buttons are
// div.lpool[data-id="5+3"] (the clock notation is universal), the AI entry is
// .lobby__start__button--ai. A pending quick-pairing seek marks its pool
// `.lpool.active` and shows a spinner; the URL stays on the homepage until an
// opponent is found, then lichess navigates the same tab to /<gameId>.
function pageLobby() {
  const q = (s) => document.querySelector(s);
  const url = location.href;
  const pools = Array.from(document.querySelectorAll('.lpool[data-id]')).map((p) => ({
    id: p.getAttribute('data-id'),
    active: p.classList.contains('active'),
  }));
  const ai = q('.lobby__start__button--ai');
  const r = ai ? ai.getBoundingClientRect() : null;
  return {
    url,
    isHome: /lichess\.org\/?($|\?|#)/.test(url) && !!q('main.lobby'),
    user: (document.body && document.body.getAttribute('data-user')) || null,
    pools,
    seeking: pools.some((p) => p.active),
    aiButton: r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null,
    dialogOpen: !!q('.game-setup'),
  };
}

// Click a lobby/setup element synthetically (scrolling it into view first).
// Unlike the board (chessground needs trusted CDP mouse input), lichess lobby
// and dialog buttons use plain DOM click handlers, so a synthetic el.click()
// works AND is immune to the Chrome window being occluded/background - trusted
// mouse clicks on a background window silently no-op for form submits.
// spec: {sel} CSS selector | {tab:N} Nth AI time-control tab (0 unlimited,
// 1 realtime, 2 correspondence) | {preset:"M+I"} AI realtime preset button |
// {radio:"sf_level_8"|"color-picker-white"} AI setup radio input id |
// {lobbyTab:N} Nth homepage lobby tab (0 quick pairing, 1 lobby, 2 correspondence,
// 3 ongoing) - lichess remembers the last lobby tab across visits.
function pageClick(spec) {
  let el = null;
  if (spec.sel) el = document.querySelector(spec.sel);
  else if (spec.tab != null) el = document.querySelectorAll('.game-setup .time-control-tabs .tabs-horiz button[role=tab]')[spec.tab];
  else if (spec.preset != null) el = Array.from(document.querySelectorAll('.game-setup .preset-btn')).find((b) => (b.textContent || '').trim() === spec.preset);
  else if (spec.radio) el = document.getElementById(spec.radio);
  else if (spec.lobbyTab != null) el = document.querySelectorAll('.lobby__app .tabs-horiz button')[spec.lobbyTab];
  if (!el) return false;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return true;
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
      const t = setTimeout(() => rej(new Error('CDP connection timeout. ' + (daemonAvailable === false
        ? 'Click "Allow" on Chrome\'s "Allow remote debugging?" dialog MANUALLY.'
        : 'Check the "Allow remote debugging" dialog (chrome-auto-connect-win should click it for you).'))), 20000);
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

  // Release a debugger session. Without this, re-attaching the same tab every
  // game cycle accumulates sessions in Chrome over hours of continuous play.
  detach(sessionId) {
    if (!sessionId || !this.connected) return Promise.resolve();
    return this.send('Target.detachFromTarget', { sessionId }).catch(() => {});
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

  navigate(sessionId, url) { return this.send('Page.navigate', { url }, sessionId); }

  async createTarget(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    return targetId;
  }

  close() { try { this.ws && this.ws.close(); } catch { /* already closed */ } this.connected = false; }
}

// Best-effort: keep the chrome-auto-connect-win watcher running so Chrome's
// "Allow remote debugging?" dialog is clicked automatically. The package is
// OPTIONAL: without it the bridge still works, but the user must click "Allow"
// on Chrome's dialog by hand, so say that clearly instead of failing silently.
let daemonAvailable = null; // null = not probed yet, true/false afterwards
function ensureDaemon() {
  if (daemonAvailable === false) return; // known missing; prompt already shown
  const manualHint = 'chrome-auto-connect-win is not available: when Chrome shows the "Allow remote debugging?" dialog, click "Allow" MANUALLY (or install it with: npm i -g chrome-auto-connect-win).';
  try {
    // Single command string (constant args) avoids the shell+args deprecation.
    const r = spawnSync(`${CONFIG.daemonCli} status --json --no-page-check`, { shell: true, encoding: 'utf8', timeout: 20000, windowsHide: true });
    let status = null;
    try { status = JSON.parse(r.stdout || ''); } catch { status = null; }
    // With shell:true a missing command does NOT throw: it returns a non-zero
    // status / empty stdout. Treat that as "package absent", not "daemon idle".
    if (r.error || r.status !== 0 || !status) {
      daemonAvailable = false;
      log(manualHint);
      return;
    }
    daemonAvailable = true;
    if (status.daemon && status.daemon.running) return;
    spawn(`${CONFIG.daemonCli} start --no-connect`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('Started chrome-auto-connect-win daemon (auto-clicks the remote-debugging confirmation dialog)');
  } catch (e) {
    daemonAvailable = false;
    log(manualHint + ' (' + e.message + ')');
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

  lobby() { return this.cdp.evaluate(this.sid, `(${pageLobby.toString()})()`); }

  // Synthetic click on a lobby/setup element resolved by pageClick(spec).
  clickSpec(spec) { return this.cdp.evaluate(this.sid, `(${pageClick.toString()})(${JSON.stringify(spec)})`); }
}

// ---------------------------------------------------------------------------
// Engine client: drives the UCI handshake over the server.js WS protocol.
// ---------------------------------------------------------------------------

// Parse a UCI `info` line into the fields we display/track. lc0 emits
// `score cp` (logistic-derived from Q) plus native `wdl` per-mille, both from
// the side-to-move perspective; `score mate N` appears near forced mates.
function parseInfo(line) {
  const t = line.split(/\s+/);
  const num = (key) => { const i = t.indexOf(key); return i >= 0 ? Number(t[i + 1]) : null; };
  const info = { depth: num('depth'), nps: num('nps'), cp: null, mate: null, wdl: null, pv: [] };
  const si = t.indexOf('score');
  if (si >= 0) {
    if (t[si + 1] === 'cp') info.cp = Number(t[si + 2]);
    else if (t[si + 1] === 'mate') info.mate = Number(t[si + 2]);
  }
  const wi = t.indexOf('wdl');
  if (wi >= 0) info.wdl = [Number(t[wi + 1]), Number(t[wi + 2]), Number(t[wi + 3])];
  const pi = t.indexOf('pv');
  if (pi >= 0) info.pv = t.slice(pi + 1, pi + 4);
  return info;
}

// lichess win% model (cp clamped to ±1000 like lichess does).
function winPercent(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

// lichess per-move accuracy from the win% a move cost its own side.
function moveAccuracy(winLoss) {
  const acc = 103.1668 * Math.exp(-0.04354 * Math.max(0, winLoss)) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

class EngineClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.ready = false;
    this.pending = null;       // { resolve, timer }
    this.ignoreBestmove = false;
    this.stopped = false;
    this.lastInfo = null;      // final `info` line of the current/last search
  }

  start() { this.stopped = false; this._connect(); }

  _connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      log('Connected to engine bridge ' + this.url + ', starting UCI handshake');
      // A reconnect re-handshakes but does NOT emit 'reset'; without clearing
      // this flag a stale watchdog 'ignoreBestmove' would swallow every future
      // bestmove (each search then times out forever).
      this.ignoreBestmove = false;
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
      this.lastInfo = null;
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
    if (line.startsWith('info ') && line.includes(' score ')) {
      this.lastInfo = parseInfo(line); // last one before bestmove wins
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
      this.lastInfo = null; // fresh stats per search
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

// Quick-pairing pool ids shown on the lichess homepage (data-id attribute).
// "custom" opens a manual setup dialog, so it is not auto-startable.
const POOL_IDS = new Set(['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+0', '30+20']);

// Resolve the auto-start configuration into a concrete mode, or null when
// auto-start is off / the mode is invalid (the bridge then stays takeover-only).
function resolveAutoMode(cfg) {
  if (!cfg.autoStart) return null;
  const m = String(cfg.autoMode || '').trim().toLowerCase();
  if (m === 'ai' || m === 'computer') {
    const lv = parseInt(cfg.aiLevel, 10);
    const level = Math.max(1, Math.min(8, Number.isFinite(lv) ? lv : 8));
    const color = ['white', 'black', 'random'].includes(cfg.aiColor) ? cfg.aiColor : 'random';
    const time = cfg.aiTime === 'realtime' ? 'realtime' : 'unlimited';
    const preset = /^\d+\+\d+$/.test(String(cfg.aiPreset || '')) ? String(cfg.aiPreset) : '5+3';
    return { kind: 'ai', level, color, time, preset };
  }
  if (POOL_IDS.has(m)) return { kind: 'pool', id: m };
  return null;
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
    this.evalChain = null;          // { win, ply, gameId } of our previous search
    this.oppAcc = { sum: 0, n: 0 }; // running opponent-accuracy estimate
    // Auto-start state machine: idle -> seeking -> (game taken over) -> cooldown -> idle
    this.autoMode = resolveAutoMode(CONFIG);
    this.autoPhase = 'idle';
    this.autoSeekAt = 0;            // when the current seek/setup was initiated
    this.autoNextAt = 0;            // cooldown deadline after a finished game
    this.autoBusy = false;          // re-entrancy guard for the start subroutine
    this.autoFails = 0;             // consecutive failed starts; circuit breaker at 4
    this.stopRequested = false;     // stop hotkey: finish current game, then exit
    this.gameInProgress = false;    // a live takeover game still being played
    this.badTabs = new Map();       // targetId -> url of tabs that are not playable rounds
    this.roundPending = new Map();  // targetId -> first-seen ts of a not-yet-loaded round
    this.lobbyTargetId = null;
    this.lobbySid = null;
    this.lobbyAgent = null;
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

  // Log the search evaluation and update the opponent-accuracy estimate.
  // Searches always run on our turn, so cp/WDL are already our perspective.
  // Between two consecutive searches exactly two plies pass (our engine-best
  // move + the opponent's reply). Our move is assumed eval-neutral, so any
  // RISE in our win% is the opponent's loss (their win% = 100 - ours); a drop
  // means they played well. Takebacks/resyncs break the ply+2 chain and skip
  // the sample.
  reportEval(info, sans, ply) {
    if (!info || (info.cp == null && info.mate == null)) return;
    const cp = info.cp != null ? info.cp : 0;
    // A forced mate is a certain result, outside the cp->win% logistic model.
    const win = info.mate != null ? (info.mate > 0 ? 100 : 0) : winPercent(cp);
    const scoreText = info.mate != null
      ? (info.mate > 0 ? 'M' : '-M') + Math.abs(info.mate)
      : (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
    const parts = ['eval ' + scoreText];
    if (info.wdl) parts.push(`W ${Math.round(info.wdl[0] / 10)}% D ${Math.round(info.wdl[1] / 10)}% L ${Math.round(info.wdl[2] / 10)}%`);
    if (info.depth != null) parts.push('d' + info.depth);
    if (info.nps) parts.push(Math.round(info.nps / 1000) + 'k nps');
    if (this.evalChain && this.evalChain.gameId === this.gameId && this.evalChain.ply + 2 === ply) {
      const acc = moveAccuracy(win - this.evalChain.win);
      this.oppAcc.sum += acc;
      this.oppAcc.n++;
      parts.push(`opp ${sans[ply - 1] || '?'} acc ${acc.toFixed(1)}% (avg ${(this.oppAcc.sum / this.oppAcc.n).toFixed(1)}%, ${this.oppAcc.n} moves)`);
    }
    this.evalChain = { win, ply, gameId: this.gameId };
    log('  ' + parts.join(' | '));
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
    this.lobbyTargetId = null;
    this.lobbySid = null;
    this.lobbyAgent = null;
    log('CDP connected');
  }

  // Chrome pauses requestAnimationFrame for hidden/occluded pages, which
  // freezes chessground move animations and leaves piece transforms stale.
  // Focus emulation keeps the page rendering regardless of window visibility.
  async keepRendering(sid = this.sid) {
    if (!this.cdp || !sid) return;
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid).catch(() => {});
    await this.cdp.send('Page.setWebLifecycleState', { state: 'active' }, sid).catch(() => {});
  }

  // ---- Auto-start: create the next game once the current one is over ----

  scheduleNext() {
    if (!this.autoMode || this.autoPhase === 'cooldown' || this.stopRequested) return;
    this.autoPhase = 'cooldown';
    this.autoNextAt = Date.now() + CONFIG.nextGameDelayMs;
    const label = this.autoMode.kind === 'ai' ? `AI level ${this.autoMode.level}` : this.autoMode.id;
    log(`Game over; next (${label}) in ${Math.round(CONFIG.nextGameDelayMs / 1000)}s`);
  }

  // Shared auto-start failure counter (seek timeouts AND missing UI elements)
  // so every failure mode feeds the same circuit breaker.
  noteAutoFail(msg) {
    this.autoFails++;
    if (this.autoFails >= 4) {
      this.autoMode = null;
      log('⚠ Auto-start DISABLED after 4 failed attempts: ' + msg + '. Check the page/Chrome, then restart the bridge.');
    } else {
      logThrottled('auto-fail', 5000, `${msg} (${this.autoFails}/4)`);
    }
  }

  // Stop hotkey: no new games; finish any live takeover game, then exit.
  requestStop() {
    if (this.stopRequested) return;
    this.stopRequested = true;
    log(this.gameInProgress
      ? `Stop key "${CONFIG.stopKey}" pressed: finishing the current game, then exiting (no new games).`
      : `Stop key "${CONFIG.stopKey}" pressed: no active game, exiting.`);
  }

  // Called when no game tab exists: drive a homepage tab to create a game.
  async autoStartStep(allTabs) {
    if (!this.autoMode || this.autoBusy || this.stopRequested) return;
    if (this.autoPhase === 'cooldown' && Date.now() < this.autoNextAt) return;
    if (!this.engine.ready) { logThrottled('auto-engine-wait', 10000, 'Auto-start waiting for the engine to be ready…'); return; }
    this.autoBusy = true;
    try {
      // Only reuse a tab already on the homepage; never hijack the user's own
      // study/puzzle/forum tab by navigating it away.
      let tab = allTabs.find((t) => HOME_URL_RE.test(t.url));
      if (!tab) {
        const targetId = await this.cdp.createTarget('https://lichess.org/');
        tab = { targetId, url: 'https://lichess.org/' };
        await sleep(2500); // let the homepage load
      }
      if (tab.targetId !== this.lobbyTargetId || !this.lobbyAgent) {
        await this.cdp.detach(this.lobbySid);
        this.lobbyTargetId = tab.targetId;
        this.lobbySid = await this.cdp.attach(tab.targetId);
        this.lobbyAgent = new PageAgent(this.cdp, this.lobbySid);
        await this.keepRendering(this.lobbySid);
      }
      // CDP mouse input on a background tab is unreliable (the AI submit would
      // silently no-op); focus the lobby tab before driving it.
      await this.cdp.send('Page.bringToFront', {}, this.lobbySid).catch(() => {});
      const lobby = await this.lobbyAgent.lobby();
      // A game already lives in this tab (we just created it, or the user did).
      // NEVER navigate away from a live game: doing so mid-seek abandoned each
      // created game and the retry spawned another (the runaway). Just reset to
      // idle and let the main game-tab filter pick it up on the next poll.
      if (GAME_URL_RE.test(lobby.url)) {
        this.autoPhase = 'idle'; this.autoSeekAt = 0; this.autoFails = 0;
        return;
      }
      if (!lobby.isHome) {
        if (this.autoPhase === 'seeking') { this.autoPhase = 'idle'; return; }
        await this.cdp.navigate(this.lobbySid, 'https://lichess.org/');
        await sleep(2000);
        return;
      }
      // Already submitted: wait for the game tab. On timeout, reload a clean
      // homepage (clears any stuck dialog) before retrying - never re-submit
      // onto a possibly-pending dialog. A circuit breaker stops runaway creation.
      if (this.autoPhase === 'seeking') {
        const limit = this.autoMode.kind === 'ai' ? 30000 : CONFIG.seekTimeoutMs;
        if (limit > 0 && Date.now() - this.autoSeekAt > limit) {
          // Re-read: a match may have landed between the snapshot and now;
          // never cancel/navigate away a live game (runaway race window).
          const fresh = await this.lobbyAgent.lobby();
          if (GAME_URL_RE.test(fresh.url)) { this.autoPhase = 'idle'; this.autoSeekAt = 0; this.autoFails = 0; return; }
          if (this.autoMode.kind === 'pool' && fresh.seeking) await this.lobbyAgent.clickSpec({ sel: '.lpool.active' });
          await this.cdp.navigate(this.lobbySid, 'https://lichess.org/').catch(() => {});
          this.autoPhase = 'idle';
          this.autoFails++;
          if (this.autoFails >= 4) {
            this.autoMode = null;
            log('⚠ Auto-start DISABLED after 4 failed attempts (games created but not detected). Check Chrome focus/page, then restart the bridge.');
          } else {
            log(`Auto-start timed out (${this.autoFails}/4), reloaded homepage to retry`);
          }
        }
        return;
      }
      if (this.autoMode.kind === 'pool') await this.seekPool(lobby);
      else await this.startAi(lobby);
    } catch (e) {
      logThrottled('auto-err', 5000, 'Auto-start error: ' + e.message);
      await this.cdp.detach(this.lobbySid);
      this.lobbyTargetId = null; this.lobbySid = null; this.lobbyAgent = null;
    } finally {
      this.autoBusy = false;
    }
  }

  async seekPool(lobby) {
    const id = this.autoMode.id;
    if (lobby.seeking) { this.autoPhase = 'seeking'; this.autoSeekAt = Date.now(); return; }
    const poolSel = { sel: `.lpool[data-id=${JSON.stringify(id)}]` };
    let ok = await this.lobbyAgent.clickSpec(poolSel);
    if (!ok) {
      // lichess restores the last lobby tab (e.g. "ongoing games"), which hides
      // the quick-pairing pools. Switch back to quick pairing (tab 0) and retry.
      await this.lobbyAgent.clickSpec({ lobbyTab: 0 });
      await sleep(600);
      ok = await this.lobbyAgent.clickSpec(poolSel);
    }
    if (!ok) { this.noteAutoFail(`Pool "${id}" not on the homepage (rating/locale filter?)`); return; }
    this.autoPhase = 'seeking';
    this.autoSeekAt = Date.now();
    log(`Auto-seek ${id} (waiting for an opponent)…`);
  }

  async startAi(lobby) {
    const m = this.autoMode;
    const a = this.lobbyAgent;
    if (!lobby.dialogOpen) {
      if (!lobby.aiButton) { this.noteAutoFail('AI entry button not found on the homepage'); return; }
      await a.clickSpec({ sel: '.lobby__start__button--ai' });
      await sleep(800);
    }
    await a.clickSpec({ tab: m.time === 'realtime' ? 1 : 0 }); // 0 unlimited, 1 realtime
    await sleep(300);
    if (m.time === 'realtime') { await a.clickSpec({ preset: m.preset }); await sleep(200); }
    await a.clickSpec({ radio: 'sf_level_' + m.level });
    await sleep(150);
    await a.clickSpec({ radio: 'color-picker-' + m.color });
    await sleep(150);
    const ok = await a.clickSpec({ sel: '.game-setup .lobby__start__button--ai' });
    if (!ok) { this.noteAutoFail('AI submit button not found'); return; }
    this.autoPhase = 'seeking';
    this.autoSeekAt = Date.now();
    log(`Auto-start AI game (level ${m.level}, ${m.color}, ${m.time}${m.time === 'realtime' ? ' ' + m.preset : ''})…`);
  }

  async tick() {
    await this.ensureCdp();
    const allTabs = await this.cdp.pages();
    const tabs = allTabs.filter((p) => GAME_URL_RE.test(p.url));
    // GAME_URL_RE also matches /analysis, /training, 8-12-char usernames, etc.
    // Skip tabs already proven non-rounds (re-probe if their URL changed).
    const usable = tabs.filter((t) => !(this.badTabs.has(t.targetId) && this.badTabs.get(t.targetId) === t.url));
    if (!usable.length) {
      await this.cdp.detach(this.sid);
      this.targetId = null; this.sid = null; this.agent = null; this.gameId = null;
      this.gameInProgress = false;
      if (this.stopRequested) {
        // Don't leave a dangling pool seek behind when stopping.
        if (this.autoPhase === 'seeking' && this.autoMode && this.autoMode.kind === 'pool' && this.lobbyAgent) {
          await this.lobbyAgent.clickSpec({ sel: '.lpool.active' }).catch(() => {});
        }
        return; // run loop sees stopRequested + no active game and exits
      }
      if (this.autoMode) { await this.autoStartStep(allTabs); return; }
      const seen = allTabs.slice(0, 6).map((p) => p.url).join(' | ') || 'none';
      logThrottled('no-tab', 10000, `Waiting for a lichess game tab… (start a game manually in Chrome, or set bridge.autoStart in config.json) current tabs: ${seen}`);
      return;
    }
    const tab = usable.find((t) => t.targetId === this.targetId) || usable[0];
    if (tab.targetId !== this.targetId) {
      await this.cdp.detach(this.sid);
      this.targetId = tab.targetId;
      this.sid = await this.cdp.attach(tab.targetId);
      this.agent = new PageAgent(this.cdp, this.sid);
      this.gameId = null;
      await this.keepRendering();
      // Focus the game tab BEFORE the started/turn gates: a background tab
      // stalls lichess's clock and animations, so `started` reads false at
      // ply 0 and the first move (opening book) would never fire.
      await this.cdp.send('Page.bringToFront', {}, this.sid).catch(() => {});
      log('Attached game tab: ' + tab.url);
    }

    const snap = await this.agent.snapshot();

  // -- 1. Playable-round gate (with load grace) --
  // A freshly-created game tab is briefly !isRound / !isPlayer while the round
  // app and player identity load; blacklisting instantly would discard a good
  // game and spawn another. Only blacklist a tab that stays non-playable for a
  // grace period (analysis/puzzle/profile/spectator pages never become ours).
  if (!snap.isRound || !snap.isPlayer) {
    const now = Date.now();
    const since = this.roundPending.get(this.targetId);
    if (since == null) this.roundPending.set(this.targetId, now);
    if (since == null || now - since < 5000) {
      logThrottled('no-board', 5000, 'Board/players not ready yet, waiting…');
      return;
    }
    this.roundPending.delete(this.targetId);
    this.badTabs.set(this.targetId, snap.url);
    await this.cdp.detach(this.sid);
    this.targetId = null; this.sid = null; this.agent = null;
    logThrottled('not-round', 5000, snap.isRound ? 'Spectator view, not taking over' : 'Tab is not a playable game round, skipping it');
    return;
  }
  this.roundPending.delete(this.targetId);
  if (!snap.boardReady) {
    logThrottled('no-board', 5000, 'Board not laid out yet, waiting…');
    return;
  }

  // -- 2. Game switch: decide identity in one place --
  if (snap.gameId !== this.gameId) {
    this.gameId = snap.gameId;
    this.warned.clear();
    this.evalChain = null;
    this.oppAcc = { sum: 0, n: 0 };
    this.autoPhase = 'idle'; // a game appeared: any pending seek resolved
    this.autoSeekAt = 0;
    this.autoFails = 0;

    const spectator     = !snap.isPlayer;
    const humanVsHuman  = !snap.opponentIsAi && !snap.ourIsBot; // online human game
    const alreadyDone   = this.doneGames.has(snap.gameId);

    //   Human games are no longer excluded; they take the same entry as bot games
    this.takeover     = !spectator && !alreadyDone;
    this.isHumanGame  = humanVsHuman;
    this.gameInProgress = this.takeover && !snap.finished;

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

  // Opponent abandoned: claim the win so the game ends and the chain continues
  // (otherwise it hangs until our own clock flags). Green button = victory claim.
  if (CONFIG.claimVictory && this.takeover && snap.claimVictory && !snap.finished) {
    const ok = await this.agent.clickSpec({ sel: '.round__app .button-green, main.round .button-green' });
    if (ok) logThrottled('claim', 3000, 'Opponent left the game; claiming victory');
    return;
  }

  // -- 3. Fast skip conditions --
  // Auto-start: once a finished game's cooldown elapses, reuse its tab to go
  // back to the homepage; the next poll (no game tab) creates the next game.
  if (this.autoMode && !this.stopRequested && this.autoPhase === 'cooldown' && Date.now() >= this.autoNextAt && (snap.finished || this.doneGames.has(this.gameId))) {
    log('Loading the next game…');
    await this.cdp.navigate(this.sid, 'https://lichess.org/').catch(() => {});
    await this.cdp.detach(this.sid);
    this.targetId = null; this.sid = null; this.agent = null; this.gameId = null;
    this.autoPhase = 'idle';
    return;
  }
  if (this.doneGames.has(this.gameId)) return;

  if (snap.finished) {
    log(`Game ${this.gameId} finished, releasing takeover`);
    this.doneGames.add(this.gameId);
    this.takeover = false;
    this.gameInProgress = false;
    this.scheduleNext();
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
      this.gameInProgress = false;
      this.scheduleNext();
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
      // Keep the tab focused while waiting: if it drifted to the background the
      // clock stalls and `started` would never flip (deadlock at ply 0).
      await this.cdp.send('Page.bringToFront', {}, this.sid).catch(() => {});
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
      // Opening book: as White on move 1, push the queen's pawn two squares
      // (1.d4, the Queen's Gambit) by default instead of searching. Set
      // bridge.whiteFirstMove to "" to let the engine choose the first move.
      let uci = null;
      if (ply === 0 && snap.ourColor === 'w' && CONFIG.whiteFirstMove) {
        const b = CONFIG.whiteFirstMove;
        try {
          const m = new Chess(fen).move({ from: b.slice(0, 2), to: b.slice(2, 4), promotion: b[4] || 'q' });
          uci = b;
          this.engine.lastInfo = null; // no search ran; don't report a stale eval
          log(`Opening book: ${m.san} (${b})`);
        } catch { /* illegal book move in this position: fall back to the engine */ }
      }
      if (!uci) uci = await this.engine.requestMove(fen, this.thinkTime(snap.ourClockSec));
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
          // A promotion dialog that appeared after promoWaitMs would otherwise
          // mask the board and swallow the retry clicks.
          if (sr.promotion && uci.length > 4) {
            await this.agent.choosePromotion(PROMO_ROLE[uci[4]] || 'queen', snap.ourColor === 'w' ? 'white' : 'black');
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
      if (played) {
        this.reportEval(this.engine.lastInfo, snap.sans, ply);
      } else {
        log(`⚠ Move failed after ${CONFIG.moveAttempts} attempts (expected ${mv.san}), releasing this game to avoid desync.`);
        this.doneGames.add(this.gameId);
        // Release fully so auto-start can move on and the stop hotkey can exit;
        // leaving gameInProgress/takeover set would wedge both forever.
        this.takeover = false;
        this.gameInProgress = false;
        this.scheduleNext();
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
    log('lc0 lichess bridge started');
    log(`Engine bridge: ${CONFIG.engineUrl} · think time: ${CONFIG.movetimeMs}ms per move (auto-shortened when a clock is present)`);
    if (this.autoMode) {
      const m = this.autoMode;
      const desc = m.kind === 'ai'
        ? `AI level ${m.level}, ${m.color}, ${m.time}${m.time === 'realtime' ? ' ' + m.preset : ''}`
        : `online pool ${m.id}`;
      log(`Auto-start ON: ${desc}; chains to the next game ${Math.round(CONFIG.nextGameDelayMs / 1000)}s after each finish. Never resigns or rematches.`);
      if (m.kind === 'pool') log('Note: engine use in online human games on a normal account violates lichess fair-play rules; BOT accounts are the sanctioned option.');
    } else {
      log(CONFIG.autoStart
        ? `Auto-start requested but autoMode "${CONFIG.autoMode}" is invalid; staying takeover-only. Use a pool id (e.g. "5+3") or "ai".`
        : 'Auto-start OFF: takeover-only. Any already-started game (computer / human / BOT); spectators and finished games excluded.');
    }
    ensureDaemon();
    this.engine.start();
    for (;;) {
      try {
        await this.tick();
      } catch (e) {
        log('Poll error: ' + e.message);
        // A detached session (tab closed/navigated) must be re-attached.
        if (this.cdp) { await this.cdp.detach(this.sid); await this.cdp.detach(this.lobbySid); }
        this.targetId = null; this.sid = null; this.agent = null;
        this.lobbyTargetId = null; this.lobbySid = null; this.lobbyAgent = null;
        this.autoBusy = false;
        if (this.cdp && !this.cdp.connected) this.cdp = null;
        await sleep(1000);
      }
      // Stop hotkey: exit only once no live takeover game remains.
      if (this.stopRequested && !this.gameInProgress) { shutdown(); return; }
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
  // Restore the console from raw mode so the user's terminal keeps echo/Ctrl+C.
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* not raw */ }
    process.stdin.pause();
  }
  setTimeout(() => process.exit(0), 300);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);

// Stop hotkey (config bridge.stopKey, default "s"): finish the current game then
// exit without starting a new one. Ctrl+C still stops immediately.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    if (buf.toString() === CONFIG.stopKey) controller.requestStop();
    else if (buf[0] === 3) shutdown(); // Ctrl+C
  });
} else {
  log('No TTY: stop hotkey disabled; use Ctrl+C to stop.');
}

controller.run().catch((e) => { console.error('Fatal error:', e); process.exit(1); });