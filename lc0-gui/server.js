/**
 * Lc0 WSL bridge server.
 * Serves the local chess GUI and pipes UCI commands to lc0 running in Docker/WSL.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');

// Machine-specific environment: edit config.json (engine section).
const CONFIG = require('./config').engine;

const PUBLIC_DIR = path.join(__dirname, 'public');

let engine = null;
let engineReady = false;

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

let engineGen = 0;
let restartAttempts = 0;
let restartTimer = null;
let shuttingDown = false;
let ownsEngine = false;
const MAX_RESTARTS = 5;

function startEngine() {
  const gen = ++engineGen;
  const weights = `${CONFIG.weightsDir}/${CONFIG.weightsFile}`;
  const engineCmd = [
    `docker rm -f ${CONFIG.containerName} >/dev/null 2>&1;`,
    `exec docker run --rm -i --name ${CONFIG.containerName} --gpus all`,
    `-v ${CONFIG.hostMount}:/work`,
    CONFIG.image,
    CONFIG.binary,
    `--backend=${CONFIG.backend}`,
    `--weights=${weights}`,
  ].join(' ');

  broadcast({ type: 'status', text: 'starting engine container...' });
  engine = spawn(
    'wsl.exe',
    ['-d', CONFIG.distro, '--', 'bash', '-lc', engineCmd],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  ownsEngine = true;
  // Writing to a dying engine's stdin raises an async EPIPE; without a listener
  // that uncaught 'error' would kill the whole backend (and orphan the container).
  engine.stdin.on('error', () => {});
  // A fresh process knows nothing about UCI yet; clients must re-handshake.
  broadcast({ type: 'reset' });

  let outBuf = '';
  engine.stdout.on('data', (chunk) => {
    if (gen !== engineGen) return;
    outBuf += chunk.toString('utf8');
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, idx).replace(/\r$/, '');
      outBuf = outBuf.slice(idx + 1);
      if (!line.trim()) continue;
      if (line === 'uciok') { engineReady = true; restartAttempts = 0; }
      broadcast({ type: 'engine', line });
    }
  });

  engine.stderr.on('data', (chunk) => {
    if (gen !== engineGen) return;
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    // Only forward meaningful lines, skip the CUDA banner noise.
    for (const line of text.split('\n')) {
      if (/^=+$|^\|\s*$|^Cuda compilation|container image|NVIDIA Deep Learning|license|copy of this|developer.nvidia|GPU |CUDA Runtime|Latest version|L2 cache|Network format|Creating backend|Loading weights|multihead|WARNING|Error|error/.test(line.trim())) {
        console.log('[engine]', line.trim());
        broadcast({ type: 'log', line: line.trim() });
      }
    }
  });

  engine.on('exit', (code) => {
    if (gen !== engineGen) return; // superseded by a newer start
    console.log(`[engine] exited with code ${code}`);
    engineReady = false;
    engine = null;
    broadcast({ type: 'status', text: `engine exited (code ${code})`, dead: true });
    if (shuttingDown) return;
    if (restartAttempts < MAX_RESTARTS) {
      restartAttempts++;
      broadcast({ type: 'status', text: `restarting engine (${restartAttempts}/${MAX_RESTARTS})...`, dead: true });
      setTimeout(() => { if (!shuttingDown) startEngine(); }, 1500);
    } else {
      broadcast({ type: 'status', text: 'engine keeps crashing - check the log', dead: true });
    }
  });

  engine.on('error', (err) => {
    if (gen !== engineGen) return;
    console.log('[engine] spawn error:', err.message);
    broadcast({ type: 'status', text: `engine spawn error: ${err.message}`, dead: true });
  });
}

function sendToEngine(cmd) {
  if (!engine || !engine.stdin.writable) return false;
  engine.stdin.write(cmd + '\n');
  return true;
}

// Graceful shutdown: close lc0 stdin (it exits on EOF), then force-remove the
// container. On a hard window close this never runs, but killing the docker
// client also closes the container's stdin, so the engine exits on its own.
function cleanup() {
  shuttingDown = true;
  engineGen++; // ignore the exit event of a deliberately stopped engine
  engineReady = false;
  if (engine) {
    try { engine.stdin.end(); } catch { /* already closed */ }
    try { engine.kill(); } catch { /* already dead */ }
    engine = null;
  }
  // Only remove the container if this process is the one that started it.
  // A second instance that failed to bind must never kill the live engine.
  if (!ownsEngine) return;
  try {
    spawnSync('wsl.exe', ['-d', CONFIG.distro, '--', 'docker', 'rm', '-f', CONFIG.containerName],
      { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  } catch { /* best effort */ }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { cleanup(); process.exit(0); });
}
process.on('exit', cleanup);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // Malformed percent-escapes make decodeURIComponent throw; an uncaught
  // exception here would kill the whole backend (and the engine with it).
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { res.writeHead(400).end('bad request'); return; }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
// The WS server re-emits the HTTP server's listen errors; without this handler
// a second instance dies with an unhandled 'error' event.
wss.on('error', onListenError);

function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${CONFIG.port} is already in use - another backend window is still running.`);
    console.error('Close that window (or run stop-engine.cmd), then start again.');
    process.exit(2);
  }
  throw err;
}

wss.on('connection', (ws) => {
  broadcast({ type: 'status', text: engineReady ? 'engine ready' : 'engine starting...' });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'cmd' && typeof msg.cmd === 'string') {
      const ok = sendToEngine(msg.cmd);
      if (!ok) ws.send(JSON.stringify({ type: 'status', text: 'engine not running', dead: true }));
    } else if (msg.type === 'restart') {
      restartAttempts = 0;
      engineGen++; // the old engine's exit event must not trigger a restart
      if (engine) {
        try { engine.stdin.end(); } catch { /* already closed */ }
        try { engine.kill(); } catch { /* already dead */ }
        engine = null;
      }
      engineReady = false;
      // Coalesce rapid consecutive 'restart' messages into a single relaunch.
      clearTimeout(restartTimer);
      restartTimer = setTimeout(startEngine, 300);
    }
  });
});

server.on('error', onListenError);

server.listen(CONFIG.port, '127.0.0.1', () => {
  console.log(`Lc0 GUI: http://127.0.0.1:${CONFIG.port}`);
  startEngine();
});
