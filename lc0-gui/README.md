# lc0bridge

Local **lc0** inference on Windows (WSL2 + Docker + NVIDIA GPU) with two front-ends:

1. a **browser board GUI** for manual play / analysis against the engine, and
2. a **lichess.org takeover bridge** that plays your games for you — optionally
   fully autonomous: it creates games, plays them, chains to the next, and stops
   gracefully on a hotkey.

The engine backend is engine-agnostic at the protocol level (UCI over a local
WebSocket), so the same front-ends can drive other UCI engines or, via a small
adapter, non-UCI models — see [Extending to other engines & models](#extending-to-other-engines--models).

```
 ┌────────────────────────┐        ┌──────────────────────────────┐
 │ Browser GUI            │        │ Chrome: lichess.org game tab │
 │ public/index.html      │        │ (CDP trusted input + DOM)    │
 └───────────┬────────────┘        └──────────────┬───────────────┘
             │ WebSocket (UCI JSON)               │ WebSocket (UCI JSON)
             v                                    v
 ┌───────────────────────────────────────────────────────────────┐
 │ server.js  — HTTP static + WS bridge + engine lifecycle        │
 └───────────┬───────────────────────────────────────────────────┘
             │ wsl.exe -d <distro> -- bash -lc "docker run -i …"
             v
 ┌───────────────────────────────────────────────────────────────┐
 │ Docker container: lc0 (UCI over stdin/stdout), CUDA backend    │
 └───────────────────────────────────────────────────────────────┘
```

Validated in continuous real play: **95 consecutive automated games** with no
desync, runaway, or crash (see [Acceptance](#acceptance--fair-play)).

---

## Features

**Engine backend (`server.js`)**
- Runs lc0 inside WSL2/Docker with `--gpus all`; UCI piped over stdin/stdout.
- Local HTTP static server + WebSocket bridge; multiple clients supported.
- Engine crash auto-restart (up to 5 consecutive), generation-guarded so a dying
  process can't trigger spurious restarts; clients re-handshake on `reset`.
- Container always force-removed before start and on shutdown (`--rm` + `rm -f`),
  so GPU memory never accumulates across restarts.
- Graceful shutdown on window close / signals; a second instance refuses to kill
  a live engine owned by the first.

**Browser GUI (`public/index.html`)**
- Play either colour against the engine, takebacks, stop/search control.
- Drives the same UCI handshake as the bridge; turn order decided by the UI.

**lichess takeover bridge (`lichess-bridge.js`)**
- Takes over **any already-started game** you are a player in: computer
  (Stockfish) games, normal-account online human games, and BOT-account games.
  Spectator views and finished games are ignored.
- Reads the position from the SAN move list + chessground piece transforms,
  replays it with chess.js and cross-checks against the board (`piecesMatch`)
  before every move — robust against history browsing and animation artifacts.
- Trusted CDP mouse input for the board (chessground rejects synthetic pointer
  events); synthetic DOM clicks for lobby/dialog buttons (immune to the Chrome
  window being occluded).
- Move retry (default 3 attempts) with resync-on-different-move; promotion
  dialog handling (incl. late dialogs); takeback recovery; frozen-animation
  recovery for background tabs.
- Clock-aware think time: auto-shortens searches to keep a configurable reserve.
- **Opening book**: as White, move 1 is played from config (default `1.d4`)
  without searching.
- **Auto-start & chaining**: creates games via homepage quick-pairing pools or
  the AI dialog, plays them, and starts the next after a cooldown — indefinitely.
  Circuit breaker prevents runaway game creation.
- **Opponent-abandon handling**: auto-clicks the green "claim victory" button so
  an abandoned game ends as a win and the chain continues.
- **Graceful stop hotkey** (default `s`): finishes the current game, then exits
  without starting a new one. Ctrl+C = immediate.
- **Live evaluation log**: score (cp/mate), native WDL %, depth, nps, plus a
  running estimate of the opponent's per-move accuracy.
- Optional `chrome-auto-connect-win` daemon auto-accepts Chrome's remote-debugging
  dialog; without it the bridge tells you to click **Allow** manually.
- Long-run hygiene: CDP sessions detached on every switch, bounded collections,
  per-game state reset, terminal raw-mode restored on exit.

---

## Requirements

- Windows 10/11, **Node >= 22**.
- **WSL2** with a Linux distro (config `engine.distro`).
- **Docker** inside that distro with GPU support (`--gpus all`) and an NVIDIA
  CUDA image (config `engine.image`); NVIDIA driver + CUDA container toolkit.
- The **lc0 binary** and a **network/weights file** under a host directory
  (config `engine.hostMount`), mounted into the container at `/work`.
- For the lichess bridge: **Chrome with remote debugging enabled**
  (`chrome://inspect/#remote-debugging`, then restart Chrome).
- Optional: `npm i -g chrome-auto-connect-win` (auto-clicks the Allow dialog).
- `npm install` in `lc0-gui/` (deps: `ws`, `chess.js`).

## Install & quick start

```bat
cd lc0-gui
npm install
copy config.example.json config.json
notepad config.json        :: set engine.distro / hostMount / weightsFile / backend

start-engine.cmd           :: backend only  -> http://127.0.0.1:8642
start-gui.cmd              :: backend + open the browser GUI
start-lichess.cmd          :: lichess takeover bridge (backend must be running)
stop-engine.cmd            :: force-stop backend + remove container
```

- Closing a start window stops inference (lc0 exits on stdin EOF; `--rm` cleans up).
- **Do not run the GUI and the lichess bridge against the same backend at once** —
  both would drive the same engine.

### Reproducing on another machine

```bat
git clone https://github.com/SodiumHypo/lc0bridge.git
cd lc0bridge\lc0-gui
npm install
copy config.example.json config.json
notepad config.json        :: machine-specific engine paths / distro / backend
start-engine.cmd
```

`config.json` is git-ignored; `config.example.json` is the machine-neutral
template. Every key omitted from `config.json` falls back to a default in
`config.js`, so a partial config still works.

---

## Configuration reference

Loaded by `config.js`, shared by `server.js`, `lichess-bridge.js` and the `.cmd`
scripts. CLI flags `--movetime <ms>` and `--debug-port <port>` override
temporarily.

### `engine` (backend)

| Key | Default | Meaning |
|---|---|---|
| `distro` | `Ubuntu` | WSL2 distro name |
| `image` | `nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04` | Docker image with CUDA |
| `hostMount` | `/home/YOUR_USER/lc0-deploy` | Host dir mounted at `/work` |
| `containerName` | `lc0-uci` | Docker container name |
| `binary` | `/work/bin/lc0` | Engine executable inside container |
| `weightsDir` | `/work/weights` | Weights dir inside container |
| `weightsFile` | `network.pb.gz` | Network/weights file name |
| `backend` | `cuda-fp16` | lc0 backend (`cuda-fp16`, `cuda`, `eigen`, …) |
| `port` | `8642` | HTTP + WebSocket port |

### `bridge` (lichess bridge & shared timings)

| Key | Default | Meaning |
|---|---|---|
| `engineUrl` | `ws://127.0.0.1:8642` | Backend WebSocket URL |
| `portFile` | `""` | Chrome `DevToolsActivePort` path; `""` auto-derives from `%LOCALAPPDATA%` |
| `movetimeMs` | `3000` | Think time per move (auto-shortened when a clock is present) |
| `threads` | `2` | UCI `Threads` option |
| `pollMs` | `400` | Page polling interval |
| `clickGapMs` | `120` | Gap between from-square and to-square clicks |
| `verifyTimeoutMs` | `6000` | Max wait for our move to appear in the move list |
| `promoWaitMs` | `2000` | Max wait for the promotion dialog |
| `engineWatchdogMs` | `45000` | Extra grace on top of movetime before giving up on a search |
| `clockSafetyMs` | `1200` | Own-clock reserve kept when shortening think time |
| `minMoveTimeMs` | `200` | Never search less than this, even low on time |
| `moveAttempts` | `3` | Click+verify attempts per move before releasing the game |
| `retryGapMs` | `400` | Pause before a retry |
| `debugPort` | `0` | `>0`: fixed Chrome debugging port instead of the port file |
| `daemonCli` | `chrome-auto-connect-win` | Daemon CLI name (optional package) |
| `autoStart` | `false` | Master switch for autonomous game creation |
| `autoMode` | `5+3` | `ai` or a quick-pairing pool id (see Auto-start) |
| `aiLevel` | `8` | Stockfish strength 1–8 (`autoMode:"ai"`) |
| `aiColor` | `random` | `white` / `black` / `random` |
| `aiTime` | `unlimited` | `unlimited` / `realtime` |
| `aiPreset` | `5+3` | Realtime preset `M+I` when `aiTime:"realtime"` |
| `nextGameDelayMs` | `4000` | Cooldown after a finish before the next game |
| `seekTimeoutMs` | `120000` | Cancel an unmatched pool seek after this (`0`=never) |
| `whiteFirstMove` | `d2d4` | Opening book: White move 1 (UCI). `""` = engine decides |
| `stopKey` | `s` | Console hotkey: finish current game then exit |
| `claimVictory` | `true` | Auto-claim win when the opponent abandons |

---

## lichess takeover bridge

### Enable Chrome remote debugging

1. Open `chrome://inspect/#remote-debugging`, enable it, **restart Chrome**.
   The setting persists in Chrome's `Local State`; the port is written to
   `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort`.
2. Start the bridge. It auto-starts `chrome-auto-connect-win` (if installed) to
   click the "Allow remote debugging?" dialog; otherwise click **Allow** yourself
   when prompted (the bridge prints a reminder).
3. Self-test alternative: `node lichess-bridge.js --debug-port 9222` against a
   Chrome launched with `--remote-debugging-port=9222`.

### Takeover (manual games)

Start any game yourself (computer / human / BOT). Once the board is laid out and
it's our turn, the bridge plays until the game ends, then releases and waits.
Our colour is read from the page's embedded game JSON or the logged-in seat
(board flipping doesn't matter), falling back to the side at the bottom.

### Auto-start & chaining

With `bridge.autoStart:true` the bridge creates games itself:

- `autoMode:"ai"` → opens the "Play with the computer" dialog, sets
  `aiLevel`/`aiColor`/`aiTime`(+`aiPreset`), submits.
- `autoMode:"<pool>"` → clicks the homepage quick-pairing pool
  (`1+0 2+1 3+0 3+2 5+0 5+3 10+0 10+5 15+10 30+0 30+20`) and waits for a match.
  If the lobby restored a different tab (e.g. "ongoing games"), it switches back
  to Quick-pairing first.

After each finish it waits `nextGameDelayMs`, returns to the homepage and creates
the next game. As White it opens with `whiteFirstMove` without searching.

Not auto-startable: *Correspondence*, *Play with a friend*, *Create a game*
(need a human to join).

**Safety:** never navigates away from a live game; never re-submits onto a pending
dialog; a load-grace prevents blacklisting a freshly-created round; a **circuit
breaker disables auto-start after 4 consecutive failed attempts**. It never
resigns, rematches, or offers draws.

### Opening book

`whiteFirstMove` (default `d2d4` = 1.d4, Queen's Gambit) is played as White's first
move without an engine search; illegal-in-position or `""` falls back to the
engine. Extend to a fuller book by mapping ply/FEN → UCI in the same branch.

### Move input & reliability

- Board clicks are trusted CDP mouse events; lobby/dialog clicks are synthetic
  DOM clicks (work even when the Chrome window is backgrounded).
- Each move is verified against the move list; failures retry up to
  `moveAttempts`. If a *different* move landed meanwhile (you moved manually),
  the engine result is discarded and the bridge resyncs from the new list.
- Promotion: clicks the matching piece; handles dialogs that appear late; with
  lichess "Always queen" it auto-queens.
- Takebacks: position rebuilt from the move list; play continues.
- Desync guard: SAN replay (chess.js) + `piecesMatch` against chessground
  transforms; frozen animations from occluded tabs are recovered by re-enabling
  rendering emulation and re-focusing the tab.
- The move count comes from SAN nodes, **not** `button[data-ply]` (those are
  history-navigation buttons in the current UI).

### Evaluation & opponent accuracy

After each of our moves the log appends e.g.:

```
Played Nf3 (g1f3)
  eval +0.35 | W 62% D 30% L 8% | d18 | 272k nps | opp e6 acc 54.8% (avg 77.4%, 2 moves)
```

- `eval`/`WDL`/`d`/`nps` come from the last UCI `info` line of the search
  (lc0's native WDL; `score cp` is Q-derived). Mate scores show as `M<n>`.
- Opponent accuracy uses the lichess win% model
  `win% = 50 + 50*(2/(1+exp(-0.00368208*cp)) - 1)` (cp clamped ±1000; mate = 100/0)
  and per-move accuracy `103.1668*exp(-0.04354*winLoss) - 3.1669` (clamped 0–100).
  Between two consecutive searches exactly two plies pass (our engine-best move +
  the opponent's reply); our win% **rise** is attributed to the opponent's loss.
  Our own accuracy is ~100 by construction (we play the engine's top choice).
- These are local short-search approximations, **not** lichess server analysis;
  takebacks/resyncs skip the affected sample.

### Graceful stop & lifecycle

- Press `stopKey` (default `s`) in the bridge console: no new game is started, the
  current takeover game is played to completion, then the script exits. Ctrl+C
  exits immediately. Terminal raw mode is restored on exit. With no TTY the
  hotkey is disabled.
- Opponent abandons → the green "claim victory" button is clicked
  (`claimVictory`), ending the game as a win so the chain continues. Never claims
  a draw, never resigns.
- Engine crashes auto-restart (≤5 consecutive); after that the backend stays down
  until restarted manually.

---

## Extending to other engines & models

The front-ends (GUI + bridge) never talk to lc0 directly — they speak **UCI over
the local WebSocket** (`server.js`). That seam is the extension point.

### 1. Swap in another UCI engine (no code change)

Anything that implements UCI can replace lc0 by editing `config.json` `engine`:

- **Different lc0 network**: point `weightsFile` at another `.pb.gz` (BT4, T60,
  Maia-style nets, …). Adjust `backend` if the net requires it (multihead BT4
  needs `cuda-fp16`, not cuDNN).
- **Stockfish / other UCI engines**: set `binary` to that executable inside the
  container (or change `image` to one that ships it), and `weightsFile`/`backend`
  accordingly (Stockfish ignores lc0-only options; the bridge only sends
  `Threads`, `position`, `go`, `stop`, which are universal UCI).
- **Native Windows engine**: bypass WSL/Docker by replacing the `wsl.exe … docker
  run …` spawn in `server.js#startEngine` with a direct `spawn(binaryPath)`; the
  stdin/stdout UCI piping and the WS protocol stay identical.

The bridge's eval/accuracy display adapts automatically: it reads whatever
`info … score cp|mate … [wdl …]` the engine emits. Engines without `wdl` simply
omit the WDL column; the win% model still works from `cp`.

### 2. Non-UCI models via an adapter

For a model that is not UCI (a Python policy/value net, a remote inference API,
a custom search), write an **adapter** that exposes the same WebSocket contract
and translates to/from UCI text. The bridge/GUI only require:

- accept `{"type":"cmd","cmd":"<uci line>"}` and understand at least
  `uci`, `isready`, `position fen …`, `go movetime …`, `stop`;
- emit `{"type":"engine","line":"uciok"}`, `"readyok"`,
  `"info depth … score cp … [wdl …] …"`, and `"bestmove <uci>"`;
- emit `{"type":"reset"}` when the underlying model/process is replaced, and
  `{"type":"status",…,"dead":true}` when unavailable.

Sketch (Node adapter fronting a hypothetical model server):

```js
// adapter.js — replaces server.js's engine spawn; keeps the WS protocol.
wss.on('connection', (ws) => {
  ws.on('message', async ({ type, cmd }) => {
    if (type !== 'cmd') return;
    if (cmd === 'uci')      return send(ws, 'engine', 'uciok');
    if (cmd === 'isready')  return send(ws, 'engine', 'readyok');
    if (cmd.startsWith('position')) fen = parseFen(cmd);
    if (cmd.startsWith('go')) {
      const { move, cp, wdl, depth } = await model.search(fen, ms(cmd));
      send(ws, 'engine', `info depth ${depth} score cp ${cp} wdl ${wdl.join(' ')}`);
      send(ws, 'engine', `bestmove ${move}`);
    }
    if (cmd === 'stop') model.cancel();
  });
});
```

Because the handshake, `bestmove` parsing, watchdog and `ignoreBestmove`
late-reply handling all live in the front-ends, a correct adapter needs no
front-end changes. Keep `info` lines coming during long searches so the eval log
and watchdog behave naturally.

### 3. Notes & gotchas

- `Threads`/`backend`/weights options are engine-specific; harmless extras are
  ignored by most UCI engines, but validate against your engine's `uci` output.
- The accuracy model assumes centipawn-like scores; for pure WDL/policy models
  convert to an equivalent cp (or supply `score cp`) or the accuracy column will
  be meaningless.
- MultiPV is not used; the bridge plays the single `bestmove`.
- The GUI is also UCI-driven, so any adapter that satisfies the contract works
  for both the GUI and the lichess bridge.

---

## HTTP & WebSocket protocol

HTTP (static root `public/`; out-of-bounds 403, missing 404):

| Method | Path | Description |
|---|---|---|
| GET | `/` | `public/index.html` |
| GET | `/chess.js` | rules library (ESM) |

WebSocket `ws://127.0.0.1:<port>`, JSON messages:

**Client → Server**

| payload | Description |
|---|---|
| `{"type":"cmd","cmd":"<UCI text>"}` | written verbatim to engine stdin |
| `{"type":"restart"}` | kill + relaunch the engine |

**Server → Client**

| payload | Description |
|---|---|
| `{"type":"status","text":…,"dead":true?}` | status; `dead` = engine unavailable |
| `{"type":"log","line":…}` | notable engine stderr lines |
| `{"type":"engine","line":…}` | each UCI stdout line |
| `{"type":"reset"}` | new engine process; redo the UCI handshake |

UCI handshake (front-end driven):

```
WS open  -> uci
uciok    -> setoption name Threads value N / isready
readyok  -> ready
move     -> position fen <fen> / go movetime <ms>
bestmove -> play it
stop     -> stop (discard the late bestmove that follows)
```

The engine never decides the side to move; it plays the FEN it receives.

## External GUI integration

Arena / CuteChess / Nibbler can use the WSL wrapper as the engine executable:

```
\\wsl$\<engine.distro>\<engine.hostMount>\lc0-wsl.bat
```

Set `Threads` explicitly and use a backend your network supports (BT4 multihead
requires `cuda-fp16`, not cuDNN).

---

## Project layout

| Path | Purpose |
|---|---|
| `lc0-gui/server.js` | HTTP + WS bridge + engine lifecycle |
| `lc0-gui/lichess-bridge.js` | lichess takeover / auto-start bridge |
| `lc0-gui/config.js` / `config.example.json` | config loader + machine-neutral template |
| `lc0-gui/config.json` | your machine's config (git-ignored) |
| `lc0-gui/public/` | browser GUI + chess.js |
| `lc0-gui/start-*.cmd`, `stop-engine.cmd` | launchers |
| `diag/cdp.js` | reusable read-only CDP helper for diagnostics |
| `diag/diag-sans.js` | move-list extraction diagnostic |

## Troubleshooting

**Backend**

| Symptom | Cause / fix |
|---|---|
| `Port … already in use` | another backend running; use it or `stop-engine.cmd` |
| stuck "engine restarting" | check `[engine]` output: image/GPU/weights path |
| no response after first move | engine not at `readyok` yet; wait for "engine ready" |
| path change had no effect | edit `config.json`; confirm the dir is mounted in WSL |
| engine stays dead after 5 crashes | consecutive-crash breaker; fix the cause, restart |

**Bridge**

| Symptom | Cause / fix |
|---|---|
| "Chrome debugging port not found" | enable remote debugging, restart Chrome |
| CDP connection timeout | Allow dialog not confirmed; install daemon or click Allow |
| "Engine bridge disconnected… reconnecting" | backend not running; `start-engine.cmd` |
| "Online human game, takeover active" | normal notice (human games are taken over too) |
| "Board and move list out of sync" | history browsing / unsupported variant; return to latest move |
| "Frozen animation detected" | occluded tab; auto-recovered via rendering emulation |
| "Move failed after 3 attempts…" | persistent interference; refresh / new game |
| "Auto-start DISABLED after 4 failed attempts" | circuit breaker; focus Chrome / check homepage, restart |
| auto-start creates no game | homepage not loaded or pool id absent for your account; log names it |
| first move not played as White | ensure `whiteFirstMove` set and the tab is focused; human clocks start only after move 1 (handled) |

## Known boundaries

- lichess DOM selectors (move list, clocks, result banner, lobby pools, claim
  button) can break on a lichess UI redesign; `diag/` helps re-locate them.
- One active game tab is assumed; two bridges / two live tabs → only one played.
- Browser zoom must be 100% (CDP mouse coordinates are viewport-based).
- Hard-killing `server.js` skips cleanup; the container holds GPU memory until the
  next start's `rm -f`.
- The stop hotkey waits for the current game; in an untimed game vs an AFK
  opponent it waits indefinitely (the bridge never resigns by design).
- `clockSafetyMs` doesn't include poll+click latency; sub-2s bullet can flag.

## Acceptance & fair play

Validated over **95 consecutive automated games** (pool + AI, white/black,
promotion, takeback, opponent-abandon, background tabs) with no desync, runaway
game creation, or crash.

**Fair play:** engine assistance in online human games on a *normal* account
violates lichess policy and risks closure. **BOT-flagged accounts are the
sanctioned option** for online engine play; the bridge prints a warning in pool
mode. Computer (Stockfish) games and the local GUI are unaffected. Use responsibly.
