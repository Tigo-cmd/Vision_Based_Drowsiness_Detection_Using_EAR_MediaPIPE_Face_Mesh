# Local LAN Stream Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an additive local/LAN operating mode — camera serves a pull-able local MJPEG stream, a locally-run backend pulls and processes it through the existing detection pipeline, and a Windows setup script wires the whole local stack up — without touching the existing Fly.io cloud deployment.

**Architecture:** The camera firmware gains a second, always-on job (an `esp_http_server.h` MJPEG `/stream` route) alongside its existing push-to-cloud behavior. The Flask backend's per-frame detection logic is extracted into a shared `process_frame()` function so a new background puller thread (local-run only, never started under the Docker/gunicorn image) can feed it pulled frames exactly like the `/detect` route feeds it pushed ones. The alert unit's server URL becomes field-editable through its existing Wi-Fi setup captive portal instead of being a compile-time constant. A `setup_local.ps1` PowerShell script installs backend/frontend deps, prompts once for the camera's local IP, and starts both local servers.

**Tech Stack:** Python 3.12 / Flask / OpenCV / MediaPipe (backend, unchanged libs), pytest (new, test-only), Arduino-ESP32 core's `esp_http_server.h` (firmware, no new library install), PowerShell 5.1+ (Windows setup script), existing Vite/React frontend (no code changes).

## Global Constraints

- The Fly.io/Docker deployment path must not change behavior. `gunicorn` imports `app:app` directly and never executes the `if __name__ == '__main__':` block, so anything local-only must live behind that guard or in a module the Docker image never imports at startup.
- The camera's existing push-to-`API_URL` behavior must keep working completely unmodified; the new stream server is additive, not a replacement, and needs no build flag to enable/disable.
- Windows-only for the setup script (no macOS/Linux variant) — this was explicitly scoped down from a broader cross-platform option during design.
- The script must never attempt to install Python or Node itself — only detect their absence and print the exact download URL.
- No secrets or camera/network-specific values (camera IP, stream URL) get committed to git.

---

### Task 1: Extract `process_frame()` from the `/detect` route

**Files:**
- Modify: `MainLogic/app.py:446-563` (the existing `detect()` route)
- Create: `MainLogic/test_process_frame.py`
- Modify: `MainLogic/requirements-dev.txt` (create if absent)

**Interfaces:**
- Produces: `process_frame(img_bytes: bytes, device_id: str) -> tuple[dict, int]` in `MainLogic/app.py`, module-level, next to `update_alert_state`. Returns a JSON-serializable payload dict and an HTTP status code. Does all the same work the old inline `detect()` body did: decode, `state.sources`/`state.latest_frames` bookkeeping (only when `session is state`), MediaPipe detection, EAR math, alert-state update, Telegram dispatch, event logging.
- Consumes: nothing new — only the module-level names already in `app.py` (`state`, `get_or_create_session`, `landmarker`, `landmarker_lock`, `compute_ear`, `LEFT_EYE`, `RIGHT_EYE`, `eye_points`, `update_alert_state`, `annotate_eyes`, `send_telegram_alert_async`, `telegram_configured`).

This task is a pure refactor: the `/detect` route's observable behavior (response JSON, status codes, side effects) must be identical before and after.

- [ ] **Step 1: Write the failing test**

Create `MainLogic/requirements-dev.txt`:

```
pytest==8.3.4
```

Create `MainLogic/test_process_frame.py`:

```python
"""Tests for process_frame(), the shared per-frame detection logic used by
both the /detect route (pushed frames) and the local stream puller (pulled
frames). Run from MainLogic/ with the venv active: pytest test_process_frame.py -v
"""
import numpy as np
import cv2

import app as appmod

# Each test below uses its own device_id string, so sources/sessions
# bookkeeping from one test can never leak into another - no shared-state
# cleanup needed between them.


def _blank_jpeg(width=320, height=240):
    """A plain gray frame — guaranteed no face for MediaPipe to find."""
    img = np.full((height, width, 3), 128, dtype=np.uint8)
    ok, buf = cv2.imencode('.jpg', img)
    assert ok
    return buf.tobytes()


def test_invalid_image_returns_400():
    payload, status = appmod.process_frame(b"not a jpeg", "test-device-invalid")
    assert status == 400
    assert payload == {"error": "invalid image"}


def test_no_face_returns_200_with_face_false():
    payload, status = appmod.process_frame(_blank_jpeg(), "test-device-noface")
    assert status == 200
    assert payload["face"] is False
    assert payload["drowsy"] is False
    assert payload["level"] in ("normal", "warning", "critical")


def test_shared_device_tracked_in_sources():
    device_id = "test-device-sources"
    appmod.process_frame(_blank_jpeg(), device_id)
    assert device_id in appmod.state.sources
    assert appmod.state.sources[device_id]["frames"] >= 1
    assert device_id in appmod.state.latest_frames


def test_browser_session_not_tracked_in_sources():
    device_id = "browser-00000000-0000-0000-0000-000000000000"
    appmod.process_frame(_blank_jpeg(), device_id)
    assert device_id not in appmod.state.sources
    assert device_id not in appmod.state.latest_frames
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `MainLogic/`, with the venv active):
```bash
pip install -r requirements.txt -r requirements-dev.txt
pytest test_process_frame.py -v
```
Expected: collection or run fails with `AttributeError: module 'app' has no attribute 'process_frame'` — the function doesn't exist yet.

- [ ] **Step 3: Extract `process_frame()` and slim the route**

Replace `MainLogic/app.py:446-563` (the full `detect()` function) with:

```python
def process_frame(img_bytes, device_id):
    """Decode one JPEG and run full detection for device_id: EAR math, alert
    state, Telegram dispatch, event logging. Returns (payload, status_code).
    Used by both the /detect route (frame pushed by hardware/browser) and the
    local stream puller thread (frame pulled from a camera's /stream)."""
    nparr = np.frombuffer(img_bytes, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if frame is None:
        return {"error": "invalid image"}, 400

    now = time.time()
    session = get_or_create_session(device_id)
    # Hardware (and anything not an isolated browser tab) also gets tracked
    # in state.sources/latest_frames; an isolated browser tab renders its own
    # camera locally and doesn't need a place in the Cameras list.
    if session is state:
        src = state.sources.setdefault(device_id, {"last_seen": now, "frames": 0})
        src["last_seen"] = now
        src["frames"] += 1
        if device_id != 'browser':
            state.latest_frames[device_id] = {"jpeg": img_bytes, "time": now}

    h, w = frame.shape[:2]
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    with landmarker_lock:
        result = landmarker.detect(mp_image)

    with state.lock:
        if session is state:
            state.last_source = device_id
        if not result.face_landmarks:
            session.face_detected = False
            session.current_ear = 0.0
            session.eye_points = None
            session.frame_size = [w, h]
            update_alert_state(session, False, now)
            return {
                "error": "no face detected",
                "face": False,
                "drowsy": False,
                "level": session.level,
                "ear": 0.0,
                "threshold": state.threshold,
                "closed_for": 0.0,
            }, 200

        landmarks = result.face_landmarks[0]
        left_ear = compute_ear(landmarks, LEFT_EYE, w, h)
        right_ear = compute_ear(landmarks, RIGHT_EYE, w, h)
        avg_ear = float((left_ear + right_ear) / 2.0)

        session.face_detected = True
        session.eye_points = {"left": eye_points(landmarks, LEFT_EYE),
                               "right": eye_points(landmarks, RIGHT_EYE)}
        session.frame_size = [w, h]
        session.current_ear = avg_ear
        eyes_closed = avg_ear < state.threshold

        prev_level = session.level
        update_alert_state(session, eyes_closed, now)
        entered_critical = session.is_drowsy and prev_level != "critical"

        alert_queued = False
        if (session.is_drowsy and state.telegram_enabled and telegram_configured()
                and (entered_critical or now - session.last_telegram_time >= state.telegram_cooldown)):
            timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            msg = (f"🚨 Drowsiness Detected!\n"
                   f"Time: {timestamp}\n"
                   f"Source: {device_id}\n"
                   f"Eyes closed: {session.closed_for:.1f}s\n"
                   f"EAR: {avg_ear:.3f}\n"
                   f"Threshold: {state.threshold:.2f}")
            annotated = annotate_eyes(frame, session.eye_points, avg_ear, True)
            _, img_encoded = cv2.imencode('.jpg', annotated)
            send_telegram_alert_async(msg, img_encoded.tobytes(), session=session)
            session.last_telegram_time = now
            alert_queued = True

        if session.is_drowsy:
            last = session.events[0] if session.events else None
            stale = last is None or (
                datetime.now() - datetime.fromisoformat(last['timestamp'])
            ).total_seconds() > 30
            if entered_critical or stale:
                session.events.appendleft({
                    "timestamp": datetime.now().isoformat(),
                    "ear": round(avg_ear, 3),
                    "duration": round(session.closed_for, 1),
                    "source": device_id,
                    "alert_sent": alert_queued,
                    "type": "critical",
                })

        return {
            "face": True,
            "drowsy": session.is_drowsy,
            "eyes_closed": bool(eyes_closed),
            "level": session.level,
            "ear": round(avg_ear, 3),
            "eyes": session.eye_points,
            "frame_size": session.frame_size,
            "threshold": state.threshold,
            "closed_for": round(session.closed_for, 2),
            "drowsy_time": state.drowsy_time_sec,
            # kept for older clients
            "confidence": round(avg_ear, 3),
            "consecutive_frames": session.consecutive_frames,
        }, 200


@app.route('/detect', methods=['POST'])
def detect():
    try:
        device_id = request.headers.get('X-Device-Id', 'browser')[:64]
        img_bytes = request.get_data()
        payload, status = process_frame(img_bytes, device_id)
        return jsonify(payload), status
    except Exception as e:
        print("[ERROR] in /detect:", e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pytest test_process_frame.py -v
```
Expected: 4 passed. (First run will be slow — MediaPipe model load — a few seconds is normal.)

- [ ] **Step 5: Manually confirm `/detect` behavior is unchanged**

Run the backend (`python app.py`), then from another terminal:
```bash
curl -s -X POST --data-binary @/dev/null http://localhost:8000/detect -H "X-Device-Id: manual-check"
```
Expected: a 500 (empty body isn't a valid image) is fine here — the point is the server doesn't crash and the route still responds. Then check `curl -s http://localhost:8000/status` shows no new device added for that malformed request (since `cv2.imdecode` on empty bytes returns `None` before any bookkeeping happens — confirms the 400/500 ordering wasn't broken by the refactor).

- [ ] **Step 6: Commit**

```bash
git add MainLogic/app.py MainLogic/test_process_frame.py MainLogic/requirements-dev.txt
git commit -m "Extract process_frame() from /detect so it can be reused by a local stream puller"
```

---

### Task 2: Local MJPEG stream puller + local-only config

**Files:**
- Create: `MainLogic/local_stream.py`
- Create: `MainLogic/test_local_stream.py`
- Modify: `MainLogic/app.py` — the `if __name__ == '__main__':` block at the end of the file (its line number shifted after Task 1's edit lengthened the file; find it by content, not by the line number noted in Task 1)
- Modify: `.gitignore` (root)
- Modify: `MainLogic/.dockerignore`

**Interfaces:**
- Consumes: `process_frame(img_bytes: bytes, device_id: str) -> tuple[dict, int]` from Task 1 (`MainLogic/app.py`).
- Produces (all in `MainLogic/local_stream.py`):
  - `LOCAL_CONFIG_PATH: str` — absolute path to `MainLogic/local_config.json`.
  - `load_local_config() -> dict | None` — parsed JSON, or `None` if the file doesn't exist.
  - `_iter_mjpeg_frames_from_reader(reader, chunk_size: int = 4096) -> Iterator[bytes]` — yields each JPEG's raw bytes (including SOI/EOI markers) from a multipart MJPEG byte stream. `reader` is anything with a `.read(n) -> bytes` method (a `urllib` response or a test double).
  - `start_puller_thread(process_frame_fn) -> threading.Thread | None` — reads local config; if absent or missing `camera_stream_url`, returns `None` and starts nothing; otherwise starts and returns a daemon `Thread` that calls `process_frame_fn(jpeg_bytes, device_id)` for every frame pulled, forever, reconnecting after a 2s delay on any error.
- Local config file schema (`MainLogic/local_config.json`, written by the Task 5 setup script, read only by this module):
  ```json
  {"camera_stream_url": "http://192.168.1.42/stream", "camera_device_id": "local-cam"}
  ```

- [ ] **Step 1: Write the failing test**

Create `MainLogic/test_local_stream.py`:

```python
"""Tests for local_stream.py. Run from MainLogic/: pytest test_local_stream.py -v"""
import io
import json
import threading
import time

import local_stream


def test_load_local_config_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(local_stream, "LOCAL_CONFIG_PATH", str(tmp_path / "missing.json"))
    assert local_stream.load_local_config() is None


def test_load_local_config_present(tmp_path, monkeypatch):
    cfg_path = tmp_path / "local_config.json"
    cfg_path.write_text(json.dumps({"camera_stream_url": "http://1.2.3.4/stream"}))
    monkeypatch.setattr(local_stream, "LOCAL_CONFIG_PATH", str(cfg_path))
    assert local_stream.load_local_config() == {"camera_stream_url": "http://1.2.3.4/stream"}


def test_iter_mjpeg_frames_from_reader_parses_two_frames():
    frame1 = b"\xff\xd8" + b"A" * 10 + b"\xff\xd9"
    frame2 = b"\xff\xd8" + b"B" * 10 + b"\xff\xd9"
    raw = b"--boundary\r\n" + frame1 + b"\r\n--boundary\r\n" + frame2
    fake_stream = io.BytesIO(raw)
    frames = list(local_stream._iter_mjpeg_frames_from_reader(fake_stream, chunk_size=8))
    assert frames == [frame1, frame2]


def test_start_puller_thread_returns_none_without_config(tmp_path, monkeypatch):
    monkeypatch.setattr(local_stream, "LOCAL_CONFIG_PATH", str(tmp_path / "missing.json"))
    assert local_stream.start_puller_thread(lambda *_: None) is None


def test_start_puller_thread_calls_process_frame_fn(tmp_path, monkeypatch):
    frame = b"\xff\xd8" + b"Z" * 10 + b"\xff\xd9"
    raw = b"--boundary\r\n" + frame

    class FakeResponse(io.BytesIO):
        pass

    def fake_urlopen(url, timeout=10):
        return FakeResponse(raw)

    cfg_path = tmp_path / "local_config.json"
    cfg_path.write_text(json.dumps({"camera_stream_url": "http://fake/stream",
                                     "camera_device_id": "local-cam"}))
    monkeypatch.setattr(local_stream, "LOCAL_CONFIG_PATH", str(cfg_path))
    monkeypatch.setattr(local_stream.urllib.request, "urlopen", fake_urlopen)

    seen = []
    stop = threading.Event()
    t = local_stream.start_puller_thread(lambda b, d: (seen.append((b, d)), stop.set()))
    assert t is not None
    stop.wait(timeout=2)
    time.sleep(0.05)  # let the append land before we read `seen`
    assert seen == [(frame, "local-cam")]
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `MainLogic/`):
```bash
pytest test_local_stream.py -v
```
Expected: `ModuleNotFoundError: No module named 'local_stream'`.

- [ ] **Step 3: Write `MainLogic/local_stream.py`**

```python
"""Pulls MJPEG frames from a camera's local /stream endpoint and feeds them
through the shared detection pipeline (process_frame in app.py).

Only used for local/LAN runs. app.py only imports this module from inside
its `if __name__ == '__main__':` block, which gunicorn (used by the Docker
image) never executes - so this file has zero effect on the Fly.io
deployment.
"""
import json
import os
import threading
import time
import urllib.request

LOCAL_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'local_config.json')


def load_local_config():
    """Returns the parsed local_config.json, or None if it doesn't exist
    (the normal case for the Docker image and for anyone not running the
    Windows local setup script)."""
    if not os.path.exists(LOCAL_CONFIG_PATH):
        return None
    with open(LOCAL_CONFIG_PATH) as f:
        return json.load(f)


def _iter_mjpeg_frames_from_reader(reader, chunk_size=4096):
    """Yields each JPEG's bytes (SOI..EOI inclusive) from a
    multipart/x-mixed-replace MJPEG stream already opened as `reader`."""
    buf = b""
    while True:
        chunk = reader.read(chunk_size)
        if not chunk:
            break
        buf += chunk
        while True:
            start = buf.find(b"\xff\xd8")
            end = buf.find(b"\xff\xd9", start + 2) if start != -1 else -1
            if start == -1 or end == -1:
                break
            yield buf[start:end + 2]
            buf = buf[end + 2:]


def _iter_mjpeg_frames(stream_url, chunk_size=4096):
    reader = urllib.request.urlopen(stream_url, timeout=10)
    yield from _iter_mjpeg_frames_from_reader(reader, chunk_size)


def run_puller(stream_url, device_id, process_frame_fn, stop_event):
    """Runs until stop_event is set. Reconnects after 2s on any error, so a
    camera reboot or a dropped Wi-Fi link doesn't kill the thread."""
    while not stop_event.is_set():
        try:
            for jpeg_bytes in _iter_mjpeg_frames(stream_url):
                if stop_event.is_set():
                    return
                process_frame_fn(jpeg_bytes, device_id)
        except Exception as e:
            print(f"[local_stream] {e}, retrying in 2s")
            time.sleep(2)


def start_puller_thread(process_frame_fn):
    """Starts the puller as a daemon thread if local_config.json exists and
    names a camera_stream_url. Returns the Thread, or None if there's no
    local config to act on."""
    cfg = load_local_config()
    if not cfg or not cfg.get('camera_stream_url'):
        return None
    stop_event = threading.Event()
    device_id = cfg.get('camera_device_id', 'local-cam')
    t = threading.Thread(
        target=run_puller,
        args=(cfg['camera_stream_url'], device_id, process_frame_fn, stop_event),
        daemon=True,
    )
    t.start()
    return t
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
pytest test_local_stream.py -v
```
Expected: 5 passed.

- [ ] **Step 5: Wire the puller into `app.py`'s local run path**

Find the `if __name__ == '__main__':` block at the end of `MainLogic/app.py` (it moved from its original line 566-567 after Task 1's edit) and replace it:
```python
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)
```
with:
```python
if __name__ == '__main__':
    # WERKZEUG_RUN_MAIN is only 'true' in the process that actually serves
    # requests under the debug reloader - the watcher process that forks it
    # also executes this block, and starting the puller there would run it
    # against a copy of `state` nothing ever answers requests from.
    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        from local_stream import start_puller_thread
        start_puller_thread(process_frame)
    app.run(host='0.0.0.0', port=8000, debug=True)
```

- [ ] **Step 6: Keep local-only config out of git and out of the Docker image**

Append to `.gitignore` (root), under the existing ESP32 secrets comment block:
```
MainLogic/local_config.json
```

Append to `MainLogic/.dockerignore`:
```
local_config.json
```

- [ ] **Step 7: Manually verify end-to-end with a fake stream server**

With no real camera yet, simulate one. In one terminal:
```bash
cd MainLogic
python -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=X')
        self.end_headers()
        import cv2, numpy as np, time
        img = np.full((240, 320, 3), 128, dtype=np.uint8)
        ok, jpg = cv2.imencode('.jpg', img)
        while True:
            self.wfile.write(b'--X\r\n' + jpg.tobytes() + b'\r\n')
            time.sleep(0.5)
socketserver.TCPServer(('127.0.0.1', 8099), H).serve_forever()
"
```
In another terminal:
```bash
cd MainLogic
echo '{"camera_stream_url": "http://127.0.0.1:8099/stream", "camera_device_id": "fake-local-cam"}' > local_config.json
python app.py
```
Expected: no `[local_stream]` error lines printed; after a few seconds, `curl -s http://localhost:8000/status` shows `"fake-local-cam"` in `devices` with `"online": true`. Delete `local_config.json` afterward (it's gitignored, but it was only for this manual check).

- [ ] **Step 8: Commit**

```bash
git add MainLogic/local_stream.py MainLogic/test_local_stream.py MainLogic/app.py .gitignore MainLogic/.dockerignore
git commit -m "Add a local MJPEG stream puller thread for LAN-only runs"
```

---

### Task 3: Camera firmware — add a local MJPEG `/stream` route

**Files:**
- Modify: `Firmware/esp32cam_drowsiness/esp32cam_drowsiness.ino`

**Interfaces:**
- Produces: an HTTP server on port 80 serving `GET /stream` as `multipart/x-mixed-replace` MJPEG, running continuously once Wi-Fi and the camera are up — independent of (and concurrent with) the existing push loop in `loop()`.
- Consumes: nothing new from other tasks. `esp_http_server.h` ships with the Arduino-ESP32 core already installed for this board — no new library to add in the Arduino IDE.

No automated test harness exists for this firmware in the repo (confirmed: `Firmware/README.md`'s "Testing step by step" section is entirely manual, serial-monitor-driven). This task's verification is a manual hardware check, matching that existing convention.

- [ ] **Step 1: Add the stream server code**

In `Firmware/esp32cam_drowsiness/esp32cam_drowsiness.ino`, add near the top, after the existing includes (after line 22, `#include <DNSServer.h>`):

```cpp
#include "esp_http_server.h"
```

Add this new block after `captureAndSend()` (after line 279, the closing brace of that function) and before the "Wi-Fi setup mode" comment block:

```cpp
// ---------------------------------------------------------------------------
// Local MJPEG stream (runs alongside the push loop above, always on once
// Wi-Fi and the camera are up - no config flag, no reflash to turn it on or
// off). Lets a local backend on the same network pull frames directly
// instead of waiting for this board to push them, cutting out any WAN
// round-trip for whoever's viewing the /stream URL on the LAN.
// ---------------------------------------------------------------------------

#define PART_BOUNDARY "dcam-frame-boundary"
static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char *STREAM_PART_HEADER = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

httpd_handle_t streamServer = nullptr;

static esp_err_t streamHandler(httpd_req_t *req) {
  esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  char partHeader[64];
  while (true) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[stream] capture failed");
      return ESP_FAIL;
    }
    res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
    if (res == ESP_OK) {
      size_t hlen = snprintf(partHeader, sizeof(partHeader), STREAM_PART_HEADER, fb->len);
      res = httpd_resp_send_chunk(req, partHeader, hlen);
    }
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
    }
    esp_camera_fb_return(fb);
    if (res != ESP_OK) return res;  // client disconnected or a send failed
  }
}

void startStreamServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.ctrl_port = 32768;
  httpd_uri_t streamUri = {
    .uri = "/stream",
    .method = HTTP_GET,
    .handler = streamHandler,
    .user_ctx = nullptr
  };
  if (httpd_start(&streamServer, &config) == ESP_OK) {
    httpd_register_uri_handler(streamServer, &streamUri);
    Serial.println("[stream] serving MJPEG on :80/stream");
  } else {
    Serial.println("[stream] failed to start");
  }
}
```

- [ ] **Step 2: Start it once Wi-Fi is up**

In `setup()`, immediately before the final `chirpRequest = true;  // audible "I'm alive"` line (currently line 618), add:

```cpp
  startStreamServer();
```

So the end of `setup()` reads:
```cpp
  if (!connectSavedWifi()) {
    Serial.println("[wifi] no saved network reachable, restarting into setup");
    Preferences p; p.begin("boot", false); p.putBool("armed", true); p.end();
    delay(200);
    ESP.restart();
  }
  startStreamServer();
  chirpRequest = true;  // audible "I'm alive"
```

- [ ] **Step 3: Flash and manually verify**

Upload to the camera board. In the Serial Monitor (115200), confirm `[stream] serving MJPEG on :80/stream` appears after Wi-Fi connects. Find the board's IP (same way as always — check your router's device list, or add a temporary `Serial.println(WiFi.localIP())` if you don't already have it noted). From a laptop on the same Wi-Fi, open `http://<camera-ip>/stream` directly in a browser: it should show a live, continuously-updating image (Chrome/Firefox render MJPEG natively). While that's open, confirm the existing push behavior still works too — check the Fly.io dashboard (or `curl https://<fly-app>.fly.dev/status`) still shows this device's `last_seen_sec` ticking down, i.e. both jobs are running at once.

- [ ] **Step 4: Commit**

```bash
git add Firmware/esp32cam_drowsiness/esp32cam_drowsiness.ino
git commit -m "Camera: serve a local MJPEG /stream alongside the existing push loop"
```

---

### Task 4: Alert unit firmware — make the server URL field-editable

**Files:**
- Modify: `Firmware/alert_unit/wifi_store.h`
- Modify: `Firmware/alert_unit/alert_unit.ino`

**Interfaces:**
- Produces (in `wifi_store.h`, new, alongside the existing `wifistore::` functions): `wifistore::loadServerUrl(const String &fallback) -> String`, `wifistore::saveServerUrl(const String &url) -> void`. Stored in NVS under a new `"cfg"` Preferences namespace (separate from the existing `"wifi"` and `"boot"` namespaces already used in this file), key `"server"`.
- Consumes: `API_BASE` from `config.h` (unchanged, now used only as the first-boot fallback instead of the only value).

No automated test harness exists for this firmware either — same manual verification convention as Task 3.

- [ ] **Step 1: Add server URL storage to `wifi_store.h`**

In `Firmware/alert_unit/wifi_store.h`, add this inside the `namespace wifistore { ... }` block, after the existing `disarmDoubleReset()` function (after line 81) and before the closing `}  // namespace wifistore` (line 83):

```cpp
// ---- Server URL: changeable from the setup page, same as Wi-Fi ----
inline String loadServerUrl(const String &fallback) {
  Preferences p;
  p.begin("cfg", true);
  String url = p.getString("server", "");
  p.end();
  return url.length() ? url : fallback;
}

inline void saveServerUrl(const String &url) {
  Preferences p;
  p.begin("cfg", false);
  p.putString("server", url);
  p.end();
}
```

- [ ] **Step 2: Load it at boot and use it instead of the `API_BASE` macro**

In `Firmware/alert_unit/alert_unit.ino`, add a global near the other globals (after line 62, `HTTPClient http;`):

```cpp
String serverBase;  // set in setup() from NVS, falling back to API_BASE
```

In `poll()` (line 182), change:
```cpp
  http.begin(tls, String(API_BASE) + "/alert");
```
to:
```cpp
  http.begin(tls, serverBase + "/alert");
```

In `setup()`, immediately after `tls.setInsecure();  // see the TLS note in Firmware/README.md` (line 525), add:
```cpp
  serverBase = wifistore::loadServerUrl(API_BASE);
```

- [ ] **Step 3: Add the field to the setup page**

In `handleRoot()` (line 281), change:
```cpp
void handleRoot() {
  String b = "<h2>Alert unit Wi-Fi setup</h2><form method=post action=/save>"
             "<label>Network</label><input name=ssid list=nets required autocomplete=off>"
             "<datalist id=nets>" + optionsHtml + "</datalist>"
             "<label>Password</label><input name=pass type=password>"
             "<label class=small><input type=checkbox name=skip style='width:auto'> "
             "Save without testing (tick this if the network is this phone's own hotspot)</label>"
             "<button>Save</button></form>";
  web->send(200, "text/html", page(b));
}
```
to:
```cpp
void handleRoot() {
  String b = "<h2>Alert unit Wi-Fi setup</h2><form method=post action=/save>"
             "<label>Network</label><input name=ssid list=nets required autocomplete=off>"
             "<datalist id=nets>" + optionsHtml + "</datalist>"
             "<label>Password</label><input name=pass type=password>"
             "<label class=small><input type=checkbox name=skip style='width:auto'> "
             "Save without testing (tick this if the network is this phone's own hotspot)</label>"
             "<label>Server URL</label><input name=server value=\"" + htmlEscape(serverBase) +
             "\" placeholder=\"https://... or http://192.168.x.x:8000\">"
             "<label class=small>Leave as-is to keep using the same server.</label>"
             "<button>Save</button></form>";
  web->send(200, "text/html", page(b));
}
```

In `handleSave()` (line 292), immediately after `pendingSsid.trim();` (line 295), add:
```cpp
  String server = web->arg("server");
  server.trim();
  if (server.length()) {
    wifistore::saveServerUrl(server);
    serverBase = server;
  }
```

- [ ] **Step 4: Flash and manually verify**

Upload to the alert unit. Double-reset into setup mode, join its `DROWSY-ALERT-xxxx` hotspot, open the setup page: confirm the "Server URL" field is present and pre-filled with the current `API_BASE` value from `config.h`. Change it to a different URL (e.g. your PC's LAN IP and port 8000, `http://192.168.1.50:8000`), save, and confirm in the Serial Monitor that subsequent `poll()` calls (`[http] ...` lines on failure, or just normal operation on success) are hitting the new URL — easiest check: point it at a URL that doesn't exist and confirm the OLED shows `NO SERVER`, then fix it back and confirm it recovers. Separately, power-cycle the board (no double-reset) and confirm it keeps using the saved URL rather than reverting to `config.h`'s default — this is the NVS persistence check.

- [ ] **Step 5: Commit**

```bash
git add Firmware/alert_unit/wifi_store.h Firmware/alert_unit/alert_unit.ino
git commit -m "Alert unit: make the server URL changeable from the setup page, not just config.h"
```

---

### Task 5: Windows setup script

**Files:**
- Create: `setup_local.ps1` (repo root)

**Interfaces:**
- Consumes: `MainLogic/requirements.txt` (existing), `Client/package.json` (existing, via `npm install`), the `local_config.json` schema from Task 2 (`camera_stream_url`, `camera_device_id`), the `VITE_API_BASE_URL` env var name already read by `Client/src/services/api.ts`.
- Produces: `MainLogic/.venv` (created/reused), `MainLogic/local_config.json`, `Client/.env.local`, and two running local processes (backend on port 8000, frontend's Vite dev server).

No automated test for a PowerShell script in this repo and no Windows machine available in this environment — verification is manual, run on an actual Windows machine.

- [ ] **Step 1: Write the script**

Create `setup_local.ps1` at the repo root:

```powershell
# Sets up and starts the local/LAN mode of the drowsiness monitor: the same
# backend and frontend as the Fly.io deployment, run on this machine instead,
# pulling frames from a camera's local stream instead of the cloud. The
# Fly.io deployment is untouched by anything this script does.
#
# Re-run any time - it skips what's already installed and only re-prompts
# for the camera IP if you pass -ChangeCamera.

param(
    [switch]$ChangeCamera
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $RepoRoot "MainLogic"
$FrontendDir = Join-Path $RepoRoot "Client"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "== Checking prerequisites ==" -ForegroundColor Cyan

if (-not (Test-Command "python")) {
    Write-Host "Python was not found on PATH." -ForegroundColor Red
    Write-Host "Download and install Python 3.10 or newer from: https://www.python.org/downloads/windows/"
    Write-Host "During install, tick 'Add python.exe to PATH', then re-run this script."
    exit 1
}

if (-not (Test-Command "npm")) {
    Write-Host "Node.js (which includes npm) was not found on PATH." -ForegroundColor Red
    Write-Host "Download and install the LTS version from: https://nodejs.org/en/download"
    Write-Host "Then re-run this script."
    exit 1
}

Write-Host "Python and Node.js found." -ForegroundColor Green

Write-Host "== Backend: virtualenv + dependencies ==" -ForegroundColor Cyan
$VenvDir = Join-Path $BackendDir ".venv"
if (-not (Test-Path $VenvDir)) {
    python -m venv $VenvDir
}
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
& $VenvPython -m pip install --quiet --upgrade pip
& $VenvPython -m pip install --quiet -r (Join-Path $BackendDir "requirements.txt")

Write-Host "== Frontend: npm install ==" -ForegroundColor Cyan
Push-Location $FrontendDir
npm install
Pop-Location

$LocalConfigPath = Join-Path $BackendDir "local_config.json"
$NeedsCameraPrompt = $ChangeCamera -or -not (Test-Path $LocalConfigPath)

if ($NeedsCameraPrompt) {
    Write-Host "== Camera setup ==" -ForegroundColor Cyan
    $CameraIp = Read-Host "Camera's local IP address (e.g. 192.168.1.42)"
    $StreamUrl = "http://$CameraIp/stream"
    $CameraDeviceId = "local-cam"

    $Config = @{
        camera_stream_url = $StreamUrl
        camera_device_id  = $CameraDeviceId
    }
    $Config | ConvertTo-Json | Set-Content -Path $LocalConfigPath -Encoding utf8
    Write-Host "Saved $LocalConfigPath"

    $EnvLocalPath = Join-Path $FrontendDir ".env.local"
    "VITE_API_BASE_URL=http://localhost:8000" | Set-Content -Path $EnvLocalPath -Encoding utf8
    Write-Host "Saved $EnvLocalPath"

    Write-Host ""
    Write-Host "Reminder: if you also run a physical alert unit board, point its" -ForegroundColor Yellow
    Write-Host "server URL at this PC's own LAN IP and port 8000 (not 'localhost')" -ForegroundColor Yellow
    Write-Host "from its own Wi-Fi setup page - see Firmware/README.md." -ForegroundColor Yellow
} else {
    Write-Host "Using existing local_config.json (pass -ChangeCamera to update the camera IP)."
}

Write-Host "== Starting backend and frontend ==" -ForegroundColor Cyan
$BackendProc = Start-Process -FilePath $VenvPython -ArgumentList "app.py" -WorkingDirectory $BackendDir -PassThru -WindowStyle Normal
$FrontendProc = Start-Process -FilePath "npm" -ArgumentList "run", "dev" -WorkingDirectory $FrontendDir -PassThru -WindowStyle Normal

Write-Host ""
Write-Host "Backend running (PID $($BackendProc.Id)), frontend running (PID $($FrontendProc.Id))." -ForegroundColor Green
Write-Host "Open the dashboard at the URL the frontend window prints (usually http://localhost:5173)."
Write-Host "Close both windows, or stop processes $($BackendProc.Id) and $($FrontendProc.Id), to shut down."
```

- [ ] **Step 2: Manually verify on a Windows machine**

Copy the repo to a Windows machine (or a VM) that does not already have Python/Node installed, and run `powershell -ExecutionPolicy Bypass -File setup_local.ps1`. Confirm it prints the Python download link and exits cleanly (exit code 1, no stack trace). Install Python only, re-run: confirm it now prints the Node link and exits. Install Node, re-run: confirm it creates `MainLogic\.venv`, runs `npm install` in `Client\`, prompts for a camera IP, writes `MainLogic\local_config.json` and `Client\.env.local`, and opens two windows (backend, frontend). Open the printed dashboard URL in a browser and confirm the page loads. Run the script a second time without `-ChangeCamera` and confirm it skips the camera prompt and reuses the existing config.

- [ ] **Step 3: Commit**

```bash
git add setup_local.ps1
git commit -m "Add setup_local.ps1 for running the full stack on a local LAN"
```

---

### Task 6: Documentation

**Files:**
- Modify: `Firmware/README.md`

**Interfaces:** None — documentation only, no code interfaces.

- [ ] **Step 1: Document the local mode**

In `Firmware/README.md`, add a new section after the existing "Two-board build: camera board + alert unit" section (after line 213, before "## Things to know"):

```markdown
## Running fully local (lower latency than the cloud)

If the cloud round-trip is too slow for your network, you can run the exact
same backend and dashboard on a Windows PC on the camera's own Wi-Fi
network instead. The camera's push-to-cloud behavior (and Telegram alerts)
keeps working unmodified the whole time - this is additive, not a
replacement.

1. The camera board already serves a live MJPEG stream at
   `http://<camera-ip>/stream` once it's on Wi-Fi - no setup needed on the
   camera's side. Find its IP from your router's device list.
2. On a Windows PC on the same Wi-Fi, run `setup_local.ps1` from the repo
   root (right-click → Run with PowerShell, or
   `powershell -ExecutionPolicy Bypass -File setup_local.ps1` from a
   terminal). It tells you exactly what to install if Python or Node.js is
   missing, then asks for the camera's IP once and starts both the backend
   and the dashboard.
3. Open the dashboard URL it prints. The local backend pulls frames
   straight from the camera's `/stream` over your own Wi-Fi - no cloud
   round-trip in that path at all.
4. If you also run a physical alert unit board, double-reset it into setup
   mode and set its **Server URL** field (on the same Wi-Fi setup page used
   for passwords) to this PC's LAN IP and port 8000, e.g.
   `http://192.168.1.50:8000`. Leave it as the Fly.dev URL to keep the alert
   unit on the cloud path instead.
5. Re-run `setup_local.ps1 -ChangeCamera` any time you want to point it at
   a different camera IP.
```

- [ ] **Step 2: Read it through**

Read the new section back in context with the rest of the file — confirm it doesn't contradict "One hardware camera at a time" (it doesn't: that line is about two ESP32-CAM boards sharing one *cloud* state; this section is about an additional local path for one camera) and that the step order matches what Tasks 3-5 actually built.

- [ ] **Step 3: Commit**

```bash
git add Firmware/README.md
git commit -m "Document the local LAN stream mode in Firmware/README.md"
```
