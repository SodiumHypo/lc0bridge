'use strict';
// Shared configuration loader for server.js and lichess-bridge.js.
// Machine-specific values live in config.json next to this file; every key
// falls back to the defaults below, so a partial (or missing) config.json
// still works. Field names are the historical CONFIG fields of both scripts,
// so their interfaces stay unchanged.
const fs = require('fs');
const path = require('path');

// Defaults are machine-neutral placeholders. Copy config.example.json to
// config.json (git-ignored) and fill in this machine's WSL distro, mount and
// network file; every key you omit falls back to the values below.
const DEFAULTS = {
  // server.js: WSL2/Docker engine backend.
  engine: {
    distro: 'Ubuntu',
    image: 'nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04',
    hostMount: '/home/YOUR_USER/lc0-deploy',
    containerName: 'lc0-uci',
    binary: '/work/bin/lc0',
    weightsDir: '/work/weights',
    weightsFile: 'network.pb.gz',
    backend: 'cuda-fp16',
    port: 8642,
  },
  // lichess-bridge.js: takeover bridge.
  bridge: {
    engineUrl: 'ws://127.0.0.1:8642',
    portFile: '',            // empty = %LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort
    movetimeMs: 3000,        // lc0 thinking time per move
    threads: 2,              // UCI Threads option, same as the local GUI
    pollMs: 400,             // page polling interval
    clickGapMs: 120,         // gap between from-square and to-square clicks
    verifyTimeoutMs: 6000,   // max wait for our move to appear in the move list
    promoWaitMs: 2000,       // max wait for the promotion dialog to appear
    engineWatchdogMs: 45000, // extra grace on top of movetime before giving up
    clockSafetyMs: 1200,     // keep this much of our own clock in reserve
    minMoveTimeMs: 200,      // never search for less than this, even when low on time
    moveAttempts: 3,         // click+verify attempts per move before giving up
    retryGapMs: 400,         // pause before a retry (let the user's mouse settle)
    debugPort: 0,            // >0: fixed Chrome debugging port instead of the port file
    daemonCli: 'chrome-auto-connect-win',
    // Auto-start: create games and chain to the next one without manual clicks.
    autoStart: false,        // master switch (false = takeover-only, the historical behavior)
    autoMode: '5+3',         // homepage pool data-id ("1+0".."30+20") or "ai"
    aiLevel: 8,              // AI strength 1-8 (autoMode "ai")
    aiColor: 'random',       // white | black | random (autoMode "ai")
    aiTime: 'unlimited',     // unlimited | realtime (autoMode "ai")
    aiPreset: '5+3',         // realtime time-control preset "M+I" (aiTime "realtime")
    nextGameDelayMs: 4000,   // cooldown after a game ends before seeking the next
    seekTimeoutMs: 120000,   // cancel an unmatched pool seek after this (0 = never)
    whiteFirstMove: 'd2d4',  // opening book: White's move 1 (queen's pawn two squares, 1.d4); "" = engine decides
    stopKey: 's',            // console hotkey: finish the current game, then exit without starting a new one
    claimVictory: true,      // auto-click "claim victory" when the opponent abandons (ends the game, chains on)
  },
};

function load() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[config] ignoring unreadable config.json: ' + e.message);
  }
  const merged = {};
  for (const section of Object.keys(DEFAULTS)) {
    merged[section] = { ...DEFAULTS[section], ...(file[section] || {}) };
  }
  if (!merged.bridge.portFile) {
    merged.bridge.portFile = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
  }
  return merged;
}

module.exports = load();
