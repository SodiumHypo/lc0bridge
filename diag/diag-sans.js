'use strict';
// Diagnostic: attach to the live lichess game tab via CDP, run the bridge's
// pageSnapshot, dump the move-list DOM, and replay the extracted SANs locally
// to find exactly which move fails. Read-only: no clicks, no page mutation.
const fs = require('fs');
const path = require('path');
const GUI = path.join(__dirname, '..', 'lc0-gui');
const WebSocket = require(path.join(GUI, 'node_modules', 'ws'));
const { Chess } = require(path.join(GUI, 'node_modules', 'chess.js'));

const portFile = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
const lines = fs.readFileSync(portFile, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
const wsEndpoint = `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;

// Extract pageSnapshot source verbatim from the bridge (self-contained function).
const src = fs.readFileSync(path.join(GUI, 'lichess-bridge.js'), 'utf8');
const start = src.indexOf('function pageSnapshot()');
const end = src.indexOf('function pageGeometry()');
if (start < 0 || end < 0) throw new Error('cannot locate pageSnapshot in bridge source');
const snapshotSrc = src.slice(start, end).trim();

const GAME_URL_RE = /^https?:\/\/(?:www\.)?lichess\.org\/(?:game\/)?([A-Za-z0-9]{8,12})(?:[/?#]|$)/;

const ws = new WebSocket(wsEndpoint, { perMessageDeflate: false });
let nextId = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
  });
}
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});

const DIAG_EXPR = `(() => {
  const root = document.querySelector('.round__app') || document.querySelector('main.round');
  if (!root) return { err: 'no round root' };
  const SAN_RE = /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/;
  const leaves = Array.from(root.querySelectorAll('*')).filter((e) => e.children.length === 0 && !e.closest('cg-board'));
  const matched = leaves.filter((e) => SAN_RE.test((e.textContent || '').trim()))
    .map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 60), txt: (e.textContent || '').trim(),
                   pTag: e.parentElement.tagName, pCls: String(e.parentElement.className).slice(0, 60) }));
  const containers = Array.from(root.querySelectorAll('*'))
    .filter((e) => /tview|moves|rm-|l4x|analyse|analysis/i.test(e.tagName + ' ' + e.className))
    .slice(0, 8)
    .map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 100), html: e.outerHTML.slice(0, 2000) }));
  return { url: location.href, matchedCount: matched.length, matched: matched.slice(0, 80), containers };
})()`;

async function main() {
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const { targetInfos } = await send('Target.getTargets');
  const tabs = targetInfos.filter((t) => t.type === 'page' && GAME_URL_RE.test(t.url));
  if (!tabs.length) {
    console.log('NO GAME TAB. Open pages:', targetInfos.filter((t) => t.type === 'page').map((t) => t.url).join(' | '));
    ws.close(); return;
  }
  for (const tab of tabs) console.log('game tab:', tab.url);
  const tab = tabs.find((t) => t.url.includes('AOOS42r8JuVI')) || tabs[0];
  const { sessionId } = await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });

  const snapRes = await send('Runtime.evaluate', { expression: `(${snapshotSrc})()`, returnByValue: true }, sessionId);
  const snap = snapRes.result && snapRes.result.value;
  if (!snap) { console.log('snapshot failed:', JSON.stringify(snapRes).slice(0, 500)); ws.close(); return; }
  console.log('snapshot: gameId=%s isRound=%s boardReady=%s finished=%s ourColor=%s initialFen=%s',
    snap.gameId, snap.isRound, snap.boardReady, snap.finished, snap.ourColor, snap.initialFen);
  console.log('sans (%d): %s', snap.sans.length, JSON.stringify(snap.sans));
  console.log('pieces on board:', Object.keys(snap.pieces).length, 'animating:', snap.animating);

  // Local replay: find the first failing move.
  let chess = null, ctorErr = null;
  try { chess = snap.initialFen ? new Chess(snap.initialFen) : new Chess(); } catch (e) { ctorErr = e.message; }
  if (ctorErr) console.log('FEN CONSTRUCTOR FAILED:', ctorErr);
  else {
    let fail = null;
    for (let i = 0; i < snap.sans.length; i++) {
      try { chess.move(snap.sans[i]); } catch (e) { fail = { i, san: snap.sans[i], err: e.message, fenBefore: chess.fen() }; break; }
    }
    if (fail) console.log('REPLAY FAILS at ply %d: san=%s err=%s\n  fen before: %s', fail.i, fail.san, fail.err, fail.fenBefore);
    else console.log('replay OK, final fen:', chess.fen());
  }

  const diagRes = await send('Runtime.evaluate', { expression: DIAG_EXPR, returnByValue: true }, sessionId);
  const diag = diagRes.result && diagRes.result.value;
  console.log('\n--- DOM diagnostics ---');
  console.log(JSON.stringify(diag, null, 1).slice(0, 6000));
  await send('Target.detachFromTarget', { sessionId }).catch(() => {});
  ws.close();
}
main().catch((e) => { console.error('DIAG ERROR:', e.message); ws.close(); process.exit(1); });
