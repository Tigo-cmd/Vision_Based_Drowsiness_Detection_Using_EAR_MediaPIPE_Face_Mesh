# Local LAN stream mode — design

## Problem

The deployed system (ESP32-CAM -> HTTPS POST -> Fly.io backend in `lhr`) still shows
1-2s of lag on the dashboard preview for the user (Abia, Nigeria), worse during
network jitter. Earlier fixes (QVGA capture, faster dashboard polling, region
migration to London, gunicorn keep-alive) reduced this but didn't eliminate it —
it's now believed to be close to the physical limit of the user's mobile/WiFi
uplink's round-trip time to any cloud region.

## Goal

Add a second, fully local operating mode: run the same backend and frontend on a
machine on the camera's own WiFi network, with the camera serving a pull-able
local stream instead of relying on a WAN round-trip. The existing Fly.io
deployment is not modified and keeps working exactly as it does today — this is
an additive mode, not a replacement.

## Non-goals

- Changing anything about the Fly.io/cloud deployment path.
- Supporting OSes other than Windows for the local setup script (explicitly
  scoped down from an earlier Linux/macOS/Windows option — Windows only, with
  the script telling the user what to install rather than installing it for them).
- Removing or disabling the camera's existing push-to-cloud behavior.

## Architecture

```
ESP32-CAM ──POST /detect (unchanged)──────────────▶ Fly.io (lhr) ──▶ Telegram
    │                                                    ▲
    └──GET /stream (new, local only)──▶ local backend ───┘ (same detection code,
                                           │                reused via a shared
                                           ▼                process_frame() fn)
                                     local dashboard
                                           ▲
                                           │ polls alert state
                                     alert unit (server URL now configurable,
                                     points at local backend's IP in local mode)
```

Both the camera's push loop and its new stream server run concurrently, always.
No build flag, no mode switch, no reflash required to move between cloud-only
and cloud+local.

## Components

### 1. Camera firmware (`Firmware/esp32cam_drowsiness/esp32cam_drowsiness.ino`)

- Add an `esp_http_server.h`-based HTTP server (the same component Espressif's
  own CameraWebServer example uses — built for chunked/streaming responses,
  unlike the `WebServer` library already in the sketch, which is used only for
  the Wi-Fi setup captive portal).
- New route `GET /stream` serving standard MJPEG multipart
  (`multipart/x-mixed-replace; boundary=...`) — the common format ESP32-CAM
  stream viewers and the user's existing YOLO Python script already expect.
- Runs on its own task, independent of `loop()`'s existing push behavior.
- Relies on the existing `fb_count = 2` (PSRAM boards, set during the earlier
  QVGA change) so the stream handler and the push loop aren't fighting over a
  single frame buffer. Non-PSRAM boards (`fb_count = 1`) will see more
  contention between the two jobs; acceptable at QVGA for a single local
  viewer, not re-evaluated further here.
- Known trade-off: running both jobs raises the board's constant CPU/network
  load versus push-only. Not addressed further in this design.
- No change to OLED/status reporting — still reflects the push loop's
  `/detect` response, same as today.

### 2. Alert unit firmware (`Firmware/alert_unit/alert_unit.ino`)

- Server URL moves from a `config.h`-only compile-time constant to a value
  stored via the existing `wifi_store.h` NVS-backed setup flow, alongside
  Wi-Fi credentials. The `config.h` value becomes only the first-boot default
  (mirroring how `WIFI_SSID`/`WIFI_PASS` already work).
- Changing the target (cloud vs local backend IP) happens through the same
  phone-based setup page (double-reset into setup mode) already used for
  Wi-Fi — no reflash needed to retarget.

### 3. Backend (`MainLogic/app.py`)

- Extract the per-frame detection logic currently inline in the `/detect`
  route (decode -> MediaPipe -> EAR -> alert state -> Telegram) into a shared
  function, `process_frame(frame, device_id)`. Both the HTTP route and the
  new puller thread call this function — no duplicated detection logic.
- New background thread (started only in local/dev run mode, not in the
  Docker/Fly image): connects to the camera's `/stream` URL, parses MJPEG
  multipart boundaries, decodes each JPEG, and calls `process_frame()` per
  frame. The existing cadence-independent state machine in
  `update_alert_state()` handles this rate the same way it already handles
  the browser's ~2 FPS vs the ESP32's push rate — no changes needed there.
- Windows-specific note: gunicorn (used in the Docker/Fly image) does not run
  on Windows. Local runs use Flask's own dev server via `python app.py`
  (the existing `__main__` block, port 8000), extended to also start the
  puller thread when local stream config is present.
- New local-only config file, e.g. `MainLogic/local_config.json`, holding the
  camera's stream URL (and optionally the alert unit's URL, informational
  only since the alert unit now gets this from its own setup flow). Read at
  backend startup if present; absent entirely from the Docker image, so the
  cloud deployment is untouched.

### 4. Frontend (`Client/`)

- No code change. `Client/src/services/api.ts` already reads
  `VITE_API_BASE_URL` with a fallback to the Fly.dev URL. The setup script
  writes a local-only `Client/.env.local` setting
  `VITE_API_BASE_URL=http://localhost:8000`. This file is never used by
  whatever process builds/deploys the live site.

### 5. Windows setup script (`setup_local.ps1`, repo root)

PowerShell, chosen over `.bat` for easier prerequisite checks and prompting.

1. Check for `python` (3.10+) and `node`/`npm` on PATH. If either is missing,
   print the exact download link (python.org, nodejs.org) and stop. The
   script never attempts to install these itself.
2. Backend: create/reuse a venv at `MainLogic/.venv`, install
   `MainLogic/requirements.txt` into it.
3. Frontend: run `npm install` in `Client/`.
4. Prompt once for the camera's local IP (e.g. `192.168.1.42`); derive the
   stream URL (`http://<ip>/stream`) and write it to
   `MainLogic/local_config.json` and the frontend's `.env.local`.
5. Start both: backend via `python app.py`, frontend via `npm run dev`, as
   two background processes; print the dashboard URL to open.
6. Re-running the script later skips reinstalling anything already present,
   and only re-prompts for the camera IP if the user asks to change it.

## Testing / validation

- Camera: confirm `/stream` serves valid MJPEG independently of the push
  loop (e.g. open the stream URL directly in a browser) while push-to-cloud
  keeps working unaffected (check Fly.io `/status` still shows the device
  online).
- Alert unit: confirm the setup page accepts and saves a server URL, and that
  double-reset setup mode still works for Wi-Fi exactly as before.
- Backend: unit-level check that `process_frame()` produces identical output
  whether called from the `/detect` route or the puller thread, for the same
  input bytes. Confirm the Docker image still builds and runs unchanged
  (no local-only imports/config required at import time).
- Script: dry run on a clean Windows machine/VM without Python or Node
  installed first, confirming it prints the correct download links and exits
  cleanly rather than erroring.
