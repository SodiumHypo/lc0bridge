# lc0xl

Local lc0 (BT4 network) inference on Windows via WSL2/Docker, with a browser
GUI and a lichess.org takeover bridge.

Everything lives in [`lc0-gui/`](lc0-gui/README.md) — see its README for the
full protocol, usage and troubleshooting docs.

## Quick start

```bat
cd lc0-gui
npm install
notepad config.json   :: machine-specific: WSL distro, mounts, weights, ports
start-engine.cmd      :: backend (WSL2 + Docker + CUDA lc0)
start-gui.cmd         :: local board GUI
start-lichess.cmd     :: lichess takeover bridge (Chrome remote debugging required)
```

`diag/` holds read-only diagnostic scripts (e.g. `diag-sans.js` attaches to
the live lichess tab via CDP and reports move-list extraction problems).
