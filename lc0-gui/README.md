# Lc0 XL Local Play GUI

A Windows-side single-page board + Node bridge service that forwards moves from the browser to lc0 running in WSL2 / Docker (BT4-1024x15, `cuda-fp16`, RTX 5060).

```
Browser (index.html)
      |  WebSocket
      v
 server.js  --wsl.exe-->  docker run -i lc0  (UCI over stdin/stdout)
```

## Directory

| File | Purpose |
|---|---|
| `start-engine.cmd` | Start backend inference only; close the window to stop the engine |
| `start-gui.cmd` | Start the backend and open the browser (browser only if a backend already exists) |
| `stop-engine.cmd` | Manual stop: kill the bridge process + remove the container |
| `server.js` | HTTP static server + WebSocket bridge + engine lifecycle management |
| `config.json` | Machine-specific settings (engine + bridge), shared by all scripts |
| `config.js` | Config loader with per-key defaults |
| `lichess-bridge.js` | lichess.org takeover bridge: any already-started game (computer / human / BOT account), spectators excluded (reuses server.js, does not modify it) |
| `start-lichess.cmd` | Start the takeover bridge (requires `start-engine.cmd` running first) |
| `public/index.html` | Board UI |
| `public/chess.js` | Rules library (front-end only, not involved in inference) |

## Start & Stop

```bat
start-engine.cmd     :: backend only, browse manually to http://127.0.0.1:8642
start-gui.cmd        :: backend + auto-open browser
stop-engine.cmd      :: force stop
```

- Closing the start window = stop inference (lc0 exits when the container stdin disconnects; `--rm` cleans up the container).
- An unexpected engine crash auto-restarts, up to 5 times; game state is preserved and play resumes after recovery.

## Configuration

All machine-specific values live in **`config.json`** (loaded by `config.js`,
shared by `server.js`, `lichess-bridge.js` and the `.cmd` scripts). Two sections:

- `engine` — WSL distro, Docker image, host mount, container name, lc0 binary /
  weights paths (inside the container), backend, HTTP/WS port.
- `bridge` — engine WS URL, think time, UCI threads, polling/click/verify
  timings, move retry count (`moveAttempts`, default 3), clock reserve,
  Chrome debugging port override, daemon CLI. `portFile: ""` auto-derives
  `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort`.

Every key falls back to a built-in default in `config.js`, so a partial
config still works. CLI flags (`--movetime`, `--debug-port`) override
`config.json` temporarily.

### Reproducing on another machine

```bat
git clone <repo> && cd lc0xl\lc0-gui
npm install
notepad config.json   :: engine.distro / hostMount / weightsFile / backend for this machine
start-engine.cmd
```

Requirements: Windows + Node >= 22, WSL2 with the named distro, Docker with
GPU support (`--gpus all`) and the CUDA image, the lc0 binary + weights under
`hostMount` (mounted at `/work`), and `chrome-auto-connect-win` on PATH for
the lichess bridge (`npm i -g chrome-auto-connect-win`). Chrome remote
debugging must be enabled (see the takeover section below).

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/` | Returns `public/index.html` |
| GET | `/chess.js` | Returns the rules library (ESM module) |

Static root is `public/`; out-of-bounds paths return 403, missing paths return 404.

## WebSocket Protocol

Connect to `ws://127.0.0.1:8642`; all messages are JSON.

**Client -> Server**

| payload | Description |
|---|---|
| `{"type":"cmd","cmd":"<UCI text>"}` | Written verbatim to engine stdin, e.g. `position fen ...`, `go movetime 3000` |
| `{"type":"restart"}` | Kill and relaunch the engine container |

**Server -> Client**

| payload | Description |
|---|---|
| `{"type":"status","text":"...","dead":true?}` | Status message; `dead` means the engine is currently unavailable |
| `{"type":"log","line":"..."}` | Useful info from engine stderr (CUDA/backend/errors, etc.) |
| `{"type":"engine","line":"..."}` | Each line of UCI output from engine stdout |
| `{"type":"reset"}` | The backend switched to a new engine process; the client must redo the UCI handshake |

## UCI Handshake (driven by the front-end)

```
WS open       -> uci
uciok         -> setoption name Threads value 2 / isready
readyok       -> engine ready
user move     -> position fen <current position>  /  go movetime <ms>
bestmove      -> front-end plays the move
takeback/stop -> stop (and discard the late bestmove that follows)
```

The engine itself does not decide which side to move; it only plays the FEN it receives. Turn order is decided by the UI.

## External GUI Integration

Arena / CuteChess / Nibbler etc. can treat the following wrapper as the engine executable:

```
\\wsl$\Ubuntu-26.10\home\sodiumhypo\lc0-deploy\lc0-wsl.bat
```

Set `Threads=2` explicitly in the external GUI, and use the `cuda-fp16` backend (the BT4 multihead network does not support the cuDNN backend).

## lichess.org Takeover Bridge

Lets local lc0 play **any already-started game** on lichess for you: computer (Stockfish) games, online human games on normal accounts, and BOT-account online games — all three take the same takeover entry. Spectator views and finished games are not taken over. (BOT-flagged accounts are the lichess-sanctioned option for online engine play.) **Takeover only**: once a started game's board is laid out it plays automatically; it never starts games, resigns, or clicks rematch, and clicks no page buttons other than board squares and promotion pieces.

```
Chrome (lichess.org game page)
      ^  CDP trusted mouse input / DOM snapshots
      |
lichess-bridge.js  --ws-->  server.js  --wsl/docker-->  lc0 (UCI)
```

### Usage Steps

```bat
start-engine.cmd     :: 1. start backend inference first
start-lichess.cmd    :: 2. start the takeover bridge (think time: config.json bridge.movetimeMs, default 3000ms)
```

3. Enable Chrome remote debugging: open `chrome://inspect/#remote-debugging` in the address bar, check it, then **restart Chrome**. The bridge auto-starts the `chrome-auto-connect-win` daemon to click the "Allow remote debugging" dialog; if the daemon is unavailable, click "Allow" once manually.
4. **Manually** start a game on lichess.org: a computer game (Practice -> Play with the computer, any level/colour/time control) or an online game (any account, including human games). Once the bridge detects the board it takes over our moves until the game ends, then releases automatically and waits for the next manually started game.

### Behavior & Limits

- Default think time 3000ms per move: edit `bridge.movetimeMs` in `config.json` (the `--movetime` CLI flag overrides temporarily), UCI `Threads=2` (`bridge.threads`).
- Fixed debugging port (self-test): `node lichess-bridge.js --debug-port 9222` connects to a Chrome launched with `--remote-debugging-port=9222` (any user-data-dir), bypassing the `DevToolsActivePort` file.
- Takeover scope: any already-started game — computer games (any Stockfish level/colour/time control), normal-account online human games, and BOT-account online games all take the same entry; spectator views and finished games are not taken over. Human-game takeover prints "Online human game, takeover active" once and does not block.
- Our colour comes from the page's embedded game JSON (`page-init-data`) or the logged-in seat; board flipping does not affect it, with a final fallback to the side at the bottom of the board.
- Clocked games auto-shorten think time based on our remaining time (keeping ~1.2s reserve) to avoid flagging.
- No moves are played before the game starts (waiting for opponent, clock not running); takeover releases automatically when it ends.
- **Do not open the local GUI** (index.html) while the bridge runs: both would drive the same engine.
- Supports promotion (including dialog selection; if the lichess preference is "Always queen" it auto-queens), takebacks (rebuilds the position from the move list and continues), and end detection (result banner / status bar / rematch button).
- Safety nets: the move list is read from its SAN move nodes; the bridge does NOT use `button[data-ply]` (in the current lichess UI those are navigation buttons whose data-ply shifts with history browsing and draw/takeback offers, not the move count). Desync is guarded by replaying the SAN list with chess.js and comparing the resulting position to the board (`piecesMatch`); frozen animations from an occluded/background page are recovered by re-enabling rendering emulation; after each move the move list is verified; a failed click/verification is retried up to `bridge.moveAttempts` times (default 3) before takeover of that game stops to prevent desync. If a different move landed meanwhile (e.g. you moved manually), the engine result is discarded and the bridge resyncs from the new move list instead of retrying.

### Bridge Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Keeps showing "Chrome debugging port not found" | Chrome remote debugging not enabled; follow step 3 above and restart Chrome |
| CDP connection timeout | The "Allow remote debugging" dialog was not confirmed; install `chrome-auto-connect-win` or click Allow manually |
| Keeps showing "Engine bridge disconnected… reconnecting" | Backend not started; run `start-engine.cmd` first |
| Shows "Online human game, takeover active" | Normal notice: normal-account online human games are taken over too |
| Shows "Board and move list out of sync" | Browsing history, or a variant chess.js cannot replay; return to the latest move / switch to standard chess and it recovers automatically |
| Shows "Frozen animation detected" | The page was occluded/background so chessground animations froze; the bridge re-enables rendering emulation automatically and recovers |
| "Move failed after 3 attempts, stopping takeover of this game" | Persistent interference (mouse over the board, abnormal page state); refresh the page or start a new game and the bridge re-detects |

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Port 8642 is already in use` | A backend is already running; the script opens it automatically, or run `stop-engine.cmd` first |
| Status stuck on "engine restarting" | Check the `[engine]` output in the window; usually an image/GPU/weights-path issue |
| No response after the first move | The engine has not reached `readyok` yet; wait for the status to become "engine ready" |
| Path change had no effect | Only change `config.json`, and confirm the directory is mounted in WSL |
