'use strict';
// Minimal CDP helper shared by diagnostics and self-tests. Connects to the
// user's Chrome (remote debugging via DevToolsActivePort, or a fixed port).
// Read-only by default; click/navigate/createTarget are explicit opt-ins.
const fs = require('fs');
const path = require('path');
const http = require('http');
const GUI = path.join(__dirname, '..', 'lc0-gui');
const WebSocket = require(path.join(GUI, 'node_modules', 'ws'));

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: { Host: 'localhost:' + port } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad JSON from ' + p + ': ' + b.slice(0, 80))); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + p)); });
    req.on('error', reject);
  });
}

async function endpoint(fixedPort) {
  if (fixedPort > 0) {
    const v = await httpJson(fixedPort, '/json/version');
    return v.webSocketDebuggerUrl;
  }
  const pf = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
  const lines = fs.readFileSync(pf, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
}

class Cdp {
  constructor() { this.ws = null; this.nextId = 0; this.pending = new Map(); }
  async connect(fixedPort = 9222) {
    const url = await endpoint(fixedPort);
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws connect timeout')), 15000);
      this.ws.once('open', () => { clearTimeout(t); res(); });
      this.ws.once('error', (e) => { clearTimeout(t); rej(e); });
    });
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
    return this;
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async pages() { const { targetInfos } = await this.send('Target.getTargets'); return targetInfos.filter((t) => t.type === 'page'); }
  async attach(targetId) { const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }); return sessionId; }
  async evaluate(sid, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async click(sid, x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sid);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sid);
  }
  async navigate(sid, url) { return this.send('Page.navigate', { url }, sid); }
  async createTarget(url) { const { targetId } = await this.send('Target.createTarget', { url }); return targetId; }
  async closeTarget(targetId) { return this.send('Target.closeTarget', { targetId }); }
  close() { try { this.ws && this.ws.close(); } catch { /* ignore */ } }
}

module.exports = { Cdp, httpJson };
