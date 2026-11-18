# lc0bridge

Local **lc0** inference on Windows (WSL2 + Docker + NVIDIA GPU) with a browser
board GUI and an autonomous **lichess.org takeover bridge**: it can create games,
play them, chain to the next, claim wins when opponents abandon, and stop
gracefully on a hotkey.

The engine seam is **UCI over a local WebSocket**, so other UCI engines — or
non-UCI models via a small adapter — can drive the same front-ends.

**Full documentation** (features, config reference, protocols, reliability,
extending to other engines/models, troubleshooting): [`lc0-gui/README.md`](lc0-gui/README.md).

## Quick start

```bat
cd lc0-gui
npm install
copy config.example.json config.json
notepad config.json   :: machine-specific: WSL distro, mounts, weights, backend
start-engine.cmd      :: backend (WSL2 + Docker + CUDA lc0)
start-gui.cmd         :: local board GUI
start-lichess.cmd     :: lichess bridge (Chrome remote debugging required)
```

`config.json` is git-ignored; `config.example.json` is the machine-neutral
template. `diag/` holds read-only CDP diagnostics (e.g. `diag-sans.js` reports
move-list extraction problems on a live tab).

Validated over **95 consecutive automated games** with no desync or crash.

> **Fair play:** engine assistance in online human games on a normal account
> violates lichess policy. Use a **BOT-flagged account** for online engine play;
> computer games and the local GUI are unaffected.
