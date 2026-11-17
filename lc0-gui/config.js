'use strict';
// Shared configuration loader for server.js and lichess-bridge.js.
// Machine-specific values live in config.json next to this file; every key
// falls back to the defaults below, so a partial (or missing) config.json
// still works. Field names are the historical CONFIG fields of both scripts,
// so their interfaces stay unchanged.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // server.js: WSL2/Docker engine backend.
  engine: {
    distro: 'Ubuntu-26.10',
    image: 'nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04',
    hostMount: '/home/sodiumhypo/lc0-deploy',
    containerName: 'lc0-uci',
    binary: '/work/bin/lc0',
    weightsDir: '/work/weights',
    weightsFile: 'BT4-1024x15x32h-swa-6147500-policytune-332.pb.gz',
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
