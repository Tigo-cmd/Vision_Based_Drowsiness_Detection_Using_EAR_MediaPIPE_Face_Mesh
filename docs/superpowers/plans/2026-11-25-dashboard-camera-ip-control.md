# Dashboard Camera-IP Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the camera's local stream IP be viewed and changed from the dashboard, instead of only through `setup_local.ps1`'s one-time prompt or hand-editing `local_config.json`.

**Architecture:** A new `LocalStreamManager` class in `MainLogic/local_stream.py` wraps the puller thread's lifecycle (start/stop/restart), built on a new `_start_puller()` helper shared with the existing, already-tested `start_puller_thread()`. Two new Flask routes (`GET`/`POST /local/camera`) expose it. The frontend adds a small inline control in the Camera panel, visible only when `source === 'esp32'` and the backend reports local-stream support.

**Tech Stack:** Python/Flask (backend, unchanged libs), pytest (backend tests), React/TypeScript + Vite (frontend, no new libs).

## Global Constraints

- `start_puller_thread(process_frame_fn) -> threading.Thread | None` is shipped and already tested (`MainLogic/test_local_stream.py`'s `test_start_puller_thread_returns_none_without_config` and `test_start_puller_thread_calls_process_frame_fn`) — its public signature and observable behavior must not change.
- The new routes and manager must have zero effect on the Fly.io/Docker deployment: `app.local_stream_manager` is only ever set inside `app.py`'s `if __name__ == '__main__':` block, which gunicorn never executes — so `getattr(app, 'local_stream_manager', None)` is always `None` there, same as today's `local_stream` module already has zero effect under Docker.
- No new frontend test harness — this repo has none for `Client/` (confirmed: no `*.test.tsx` files exist anywhere), and this change follows that existing convention with a manual verification step instead.

---

### Task 1: `LocalStreamManager` in `local_stream.py`

**Files:**
- Modify: `MainLogic/local_stream.py` (add `save_local_config()`, extract `_start_puller()`, refactor `start_puller_thread()` to use it, add `LocalStreamManager`)
- Modify: `MainLogic/test_local_stream.py` (add tests; the two existing tests listed in Global Constraints must keep passing unmodified)

**Interfaces:**
- Produces: `save_local_config(cfg: dict) -> None` — writes `cfg` as JSON to `LOCAL_CONFIG_PATH`.
- Produces: `_start_puller(stream_url: str, device_id: str, process_frame_fn) -> (threading.Thread, threading.Event)` — starts the daemon thread, returns both handles.
- Produces: `LocalStreamManager` class — `__init__(process_frame_fn)` (loads config and starts a puller if one exists), `.available` (bool property), `.camera_stream_url` / `.camera_device_id` (str or `None`), `.restart(stream_url: str, device_id: str = 'local-cam') -> None` (stops the old puller, persists, starts a new one).
- Consumes: nothing new from outside this file. `run_puller`, `load_local_config`, `LOCAL_CONFIG_PATH` all already exist in this file.

- [ ] **Step 1: Write the failing tests**

Add to `MainLogic/test_local_stream.py` (keep all existing tests in the file exactly as they are; add these below them):

```python
def test_save_local_config_round_trip(tmp_path, monkeypatch):
    cfg_path = tmp_path / "local_config.json"
    monkeypatch.setattr(local_stream, "LOCAL_CONFIG_PATH", str(cfg_path))
    local_stream.save_local_config({"camera_stream_url": "http://x/stream", "camera_device_id": "x"})
    assert local_stream.load_local_config() == {"camera_stream_url": "http://x/stream", "camera_device_id": "x"}


def test_start_puller_returns_thread_and_stop_event(monkeypatch):
    frame = b"\xff\xd8" + b"Z" * 10 + b"\xff\xd9"
    raw = b"--boundary\r\n" + frame
    monkeypatch.setattr(local_stream.urllib.request, "urlopen", lambda url, timeout=10: io.BytesIO(raw))

    seen = []
    thread, stop_event = local_stream._start_puller("http://fake/stream", "dev-x", lambda b, d: seen.append(d))
    assert isinstance(thread, threading.Thread)
    assert isinstance(stop_event, threading.Event)
    time.sleep(0.1)
    assert "dev-x" in seen
    stop_event.set()


def test_local_stream_manager_no_config_not_available(tmp_path, monkeypatch):
    monkeypatch.setattr(local_stream, "LOCAL_CONFIG_PATH", str(tmp_path / "missing.json"))
    manager = local_stream.LocalStreamManager(lambda *_: None)
    assert manager.available is False
    assert manager.camera_stream_url is None
    assert manager.camera_device_id is None


def test_local_stream_manager_restart_stops_old_puller_and_updates_state(tmp_path, monkeypatch):
    cfg_path = tmp_path / "local_config.json"
    monkeypatch.setattr(local_stream, "LOCAL_CONFIG_PATH", str(cfg_path))

    frame_a = b"\xff\xd8" + b"A" * 10 + b"\xff\xd9"
    raw_a = b"--boundary\r\n" + frame_a
    frame_b = b"\xff\xd8" + b"B" * 10 + b"\xff\xd9"
    raw_b = b"--boundary\r\n" + frame_b

    cfg_path.write_text(json.dumps({"camera_stream_url": "http://camera-a/stream",
                                     "camera_device_id": "cam-a"}))

    def fake_urlopen(url, timeout=10):
        return io.BytesIO(raw_a if "camera-a" in url else raw_b)

    monkeypatch.setattr(local_stream.urllib.request, "urlopen", fake_urlopen)

    calls = []
    lock = threading.Lock()

    def record(jpeg_bytes, device_id):
        with lock:
            calls.append(device_id)

    manager = local_stream.LocalStreamManager(record)
    time.sleep(0.2)
    with lock:
        assert "cam-a" in calls

    old_stop_event = manager._stop_event
    manager.restart("http://camera-b/stream", "cam-b")

    # The old puller's stop_event must be signalled synchronously - this is
    # deterministic, no sleep/race needed to verify the stop was requested.
    assert old_stop_event.is_set()

    assert manager.camera_stream_url == "http://camera-b/stream"
    assert manager.camera_device_id == "cam-b"
    assert json.loads(cfg_path.read_text()) == {
        "camera_stream_url": "http://camera-b/stream",
        "camera_device_id": "cam-b",
    }

    time.sleep(0.2)
    with lock:
        assert "cam-b" in calls
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `MainLogic/`, with the venv active):
```bash
.venv/bin/python -m pytest test_local_stream.py -v
```
Expected: the 4 new tests FAIL — `save_local_config`, `_start_puller`, and `LocalStreamManager` don't exist yet (`AttributeError`). The 5 existing tests should still PASS (you haven't touched the implementation yet).

- [ ] **Step 3: Implement**

In `MainLogic/local_stream.py`, add this immediately after `load_local_config()` (after its closing `return json.load(f)` line):

```python
def save_local_config(cfg):
    """Writes cfg as local_config.json - the write-side counterpart to
    load_local_config()."""
    with open(LOCAL_CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f)
```

Then replace the existing `start_puller_thread()` function (its current full body) with:

```python
def _start_puller(stream_url, device_id, process_frame_fn):
    """Starts the puller as a daemon thread against stream_url. Returns
    (Thread, stop_event) so a caller can stop it later; start_puller_thread()
    below is the public, config-driven wrapper that only exposes the Thread."""
    stop_event = threading.Event()
    t = threading.Thread(
        target=run_puller,
        args=(stream_url, device_id, process_frame_fn, stop_event),
        daemon=True,
    )
    t.start()
    return t, stop_event


def start_puller_thread(process_frame_fn):
    """Starts the puller as a daemon thread if local_config.json exists and
    names a camera_stream_url. Returns the Thread, or None if there's no
    local config to act on."""
    cfg = load_local_config()
    if not cfg or not cfg.get('camera_stream_url'):
        return None
    device_id = cfg.get('camera_device_id', 'local-cam')
    thread, _ = _start_puller(cfg['camera_stream_url'], device_id, process_frame_fn)
    return thread


class LocalStreamManager:
    """Owns the puller thread's lifecycle so it can be restarted with a new
    camera URL (e.g. from a dashboard control) without restarting the whole
    backend process. Built on _start_puller(), the same helper
    start_puller_thread() uses, just keeping the stop_event handle that
    function doesn't expose."""

    def __init__(self, process_frame_fn):
        self._process_frame_fn = process_frame_fn
        self._stop_event = None
        self.camera_stream_url = None
        self.camera_device_id = None
        cfg = load_local_config()
        if cfg and cfg.get('camera_stream_url'):
            self._start(cfg['camera_stream_url'], cfg.get('camera_device_id', 'local-cam'))

    def _start(self, stream_url, device_id):
        _, self._stop_event = _start_puller(stream_url, device_id, self._process_frame_fn)
        self.camera_stream_url = stream_url
        self.camera_device_id = device_id

    @property
    def available(self):
        return self.camera_stream_url is not None

    def restart(self, stream_url, device_id='local-cam'):
        """Stops the current puller (if any), persists the new URL to
        local_config.json, and starts a fresh puller against it."""
        if self._stop_event:
            self._stop_event.set()
        save_local_config({"camera_stream_url": stream_url, "camera_device_id": device_id})
        self._start(stream_url, device_id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
.venv/bin/python -m pytest test_local_stream.py -v
```
Expected: 9 passed (5 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add MainLogic/local_stream.py MainLogic/test_local_stream.py
git commit -m "Add LocalStreamManager so the camera puller can be restarted at runtime"
```

---

### Task 2: `/local/camera` routes in `app.py`

**Files:**
- Modify: `MainLogic/app.py` — add two routes after the `/detect` route and before the `if __name__ == '__main__':` block; replace the `__main__` block's puller-start line
- Create: `MainLogic/test_local_routes.py`

**Interfaces:**
- Consumes: `LocalStreamManager` from Task 1 (`MainLogic/local_stream.py`) — specifically its `.available`, `.camera_stream_url`, `.camera_device_id`, `.restart(url, device_id)`.
- Produces: `GET /local/camera` → `{"available": bool, "camera_stream_url": str|None, "camera_device_id": str|None}`. `POST /local/camera` with JSON body `{"camera_stream_url": str, "camera_device_id"?: str}` → same shape on success (200), or `{"error": str}` with 400 if there's no manager or the URL is empty/missing.
- Produces (informational, for Task 3): `app.local_stream_manager` is the attribute name routes read via `getattr(app, 'local_stream_manager', None)`.

- [ ] **Step 1: Write the failing tests**

Create `MainLogic/test_local_routes.py`:

```python
"""Tests for the /local/camera routes. Run from MainLogic/: pytest test_local_routes.py -v"""
import pytest

import app as appmod


@pytest.fixture
def client():
    return appmod.app.test_client()


@pytest.fixture(autouse=True)
def clean_manager():
    yield
    if hasattr(appmod.app, 'local_stream_manager'):
        del appmod.app.local_stream_manager


class _FakeManager:
    def __init__(self):
        self.camera_stream_url = "http://1.2.3.4/stream"
        self.camera_device_id = "cam-1"
        self.restart_calls = []

    @property
    def available(self):
        return self.camera_stream_url is not None

    def restart(self, url, device_id='local-cam'):
        self.restart_calls.append((url, device_id))
        self.camera_stream_url = url
        self.camera_device_id = device_id


def test_get_local_camera_without_manager(client):
    resp = client.get('/local/camera')
    assert resp.status_code == 200
    assert resp.get_json() == {"available": False, "camera_stream_url": None, "camera_device_id": None}


def test_get_local_camera_with_manager(client):
    appmod.app.local_stream_manager = _FakeManager()
    resp = client.get('/local/camera')
    assert resp.status_code == 200
    assert resp.get_json() == {
        "available": True,
        "camera_stream_url": "http://1.2.3.4/stream",
        "camera_device_id": "cam-1",
    }


def test_post_local_camera_without_manager(client):
    resp = client.post('/local/camera', json={"camera_stream_url": "http://9.9.9.9/stream"})
    assert resp.status_code == 400


def test_post_local_camera_empty_url(client):
    appmod.app.local_stream_manager = _FakeManager()
    resp = client.post('/local/camera', json={"camera_stream_url": "  "})
    assert resp.status_code == 400
    assert appmod.app.local_stream_manager.restart_calls == []


def test_post_local_camera_restarts_manager(client):
    manager = _FakeManager()
    appmod.app.local_stream_manager = manager
    resp = client.post('/local/camera', json={"camera_stream_url": "http://5.5.5.5/stream",
                                                "camera_device_id": "cam-2"})
    assert resp.status_code == 200
    assert resp.get_json() == {
        "available": True,
        "camera_stream_url": "http://5.5.5.5/stream",
        "camera_device_id": "cam-2",
    }
    assert manager.restart_calls == [("http://5.5.5.5/stream", "cam-2")]
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `MainLogic/`):
```bash
.venv/bin/python -m pytest test_local_routes.py -v
```
Expected: FAIL — `404 NOT FOUND` on both routes (they don't exist yet).

- [ ] **Step 3: Implement**

In `MainLogic/app.py`, add these two routes immediately after the `/detect` route's closing (after its `except Exception as e:` block's final `return jsonify({"error": str(e)}), 500` line) and before the blank lines leading into `if __name__ == '__main__':`:

```python
@app.route('/local/camera', methods=['GET'])
def get_local_camera():
    m = getattr(app, 'local_stream_manager', None)
    if not m:
        return jsonify({"available": False, "camera_stream_url": None, "camera_device_id": None})
    return jsonify({
        "available": m.available,
        "camera_stream_url": m.camera_stream_url,
        "camera_device_id": m.camera_device_id,
    })


@app.route('/local/camera', methods=['POST'])
def set_local_camera():
    m = getattr(app, 'local_stream_manager', None)
    if not m:
        return jsonify({"error": "local stream mode is not available on this server"}), 400
    data = request.get_json(force=True) or {}
    url = (data.get('camera_stream_url') or '').strip()
    if not url:
        return jsonify({"error": "camera_stream_url is required"}), 400
    device_id = (data.get('camera_device_id') or 'local-cam').strip()
    m.restart(url, device_id)
    return jsonify({
        "available": True,
        "camera_stream_url": m.camera_stream_url,
        "camera_device_id": m.camera_device_id,
    })
```

Then replace the `if __name__ == '__main__':` block (currently):
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
with:
```python
if __name__ == '__main__':
    # WERKZEUG_RUN_MAIN is only 'true' in the process that actually serves
    # requests under the debug reloader - the watcher process that forks it
    # also executes this block, and starting the puller there would run it
    # against a copy of `state` nothing ever answers requests from.
    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        from local_stream import LocalStreamManager
        app.local_stream_manager = LocalStreamManager(process_frame)
    app.run(host='0.0.0.0', port=8000, debug=True)
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
.venv/bin/python -m pytest test_local_routes.py -v
```
Expected: 5 passed.

Then run the full backend suite once to confirm nothing else broke:
```bash
.venv/bin/python -m pytest test_local_stream.py test_process_frame.py test_local_routes.py -v
```
Expected: 18 passed (9 + 4 + 5).

- [ ] **Step 5: Commit**

```bash
git add MainLogic/app.py MainLogic/test_local_routes.py
git commit -m "Add GET/POST /local/camera routes backed by LocalStreamManager"
```

---

### Task 3: Dashboard control

**Files:**
- Modify: `Client/src/types/index.ts` — add `LocalCameraInfo` interface
- Modify: `Client/src/services/api.ts` — add `getLocalCamera()` / `setLocalCamera()`
- Modify: `Client/src/App.tsx` — fetch on mount, pass down to `CameraPanel`
- Modify: `Client/src/components/CameraPanel.tsx` — new inline control, new `LocalCameraBar` component

**Interfaces:**
- Consumes: `GET`/`POST /local/camera` from Task 2.
- Produces: `LocalCameraInfo` type (`{ available: boolean; cameraStreamUrl: string | null; cameraDeviceId: string | null }`) in `Client/src/types/index.ts`, used by `api.ts`, `App.tsx`, and `CameraPanel.tsx`.

- [ ] **Step 1: Add the type**

In `Client/src/types/index.ts`, add at the end of the file:

```typescript
/** GET/POST /local/camera - only meaningful when the backend is running
 * locally with a camera puller active; always `available: false` on the
 * Fly.io deployment. */
export interface LocalCameraInfo {
  available: boolean;
  cameraStreamUrl: string | null;
  cameraDeviceId: string | null;
}
```

- [ ] **Step 2: Add the API methods**

In `Client/src/services/api.ts`, change the top import line from:
```typescript
import { AlertEvent, AlertState, ServerStatus, Settings } from '../types';
```
to:
```typescript
import { AlertEvent, AlertState, LocalCameraInfo, ServerStatus, Settings } from '../types';
```

Add these two methods to the `api` object, after the existing `latestFrameUrl` method (before the object's closing `};`):

```typescript
  async getLocalCamera(): Promise<LocalCameraInfo> {
    const r = await request<any>('/local/camera');
    return {
      available: !!r.available,
      cameraStreamUrl: r.camera_stream_url ?? null,
      cameraDeviceId: r.camera_device_id ?? null,
    };
  },

  async setLocalCamera(url: string): Promise<LocalCameraInfo> {
    const r = await request<any>('/local/camera', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera_stream_url: url }),
    });
    return {
      available: !!r.available,
      cameraStreamUrl: r.camera_stream_url ?? null,
      cameraDeviceId: r.camera_device_id ?? null,
    };
  },
```

- [ ] **Step 3: Wire it into `App.tsx`**

Change the types import line from:
```typescript
import { Settings } from './types';
```
to:
```typescript
import { LocalCameraInfo, Settings } from './types';
```

Add a new state declaration right after the existing `const [landmarks, setLandmarks] = useState<boolean>(() => readPref('landmarks', true));` line:
```typescript
  const [localCamera, setLocalCamera] = useState<LocalCameraInfo | null>(null);
```

Add a new effect right after the existing one that fetches settings (`useEffect(() => { api.settings().then(setSettings).catch(() => {}); }, [online]);`):
```typescript
  useEffect(() => {
    api.getLocalCamera().then(setLocalCamera).catch(() => {});
  }, []);
```

In the JSX, find where `<CameraPanel ... />` is rendered and add three new props:
```tsx
          <CameraPanel
            source={source}
            onSourceChange={setSource}
            running={running}
            onRunningChange={setRunning}
            state={state}
            devices={status?.devices ?? []}
            alert={alert}
            landmarks={landmarks}
            onLandmarksChange={setLandmarks}
            localCamera={localCamera}
            onLocalCameraChange={setLocalCamera}
            toast={toast}
          />
```

- [ ] **Step 4: Add the control to `CameraPanel.tsx`**

Change the top import lines from:
```tsx
import { useEffect, useRef, useState } from 'react';
import { Camera, Cpu, ScanEye, Play, Square } from 'lucide-react';
import { api } from '../services/api';
import { AlertState, DeviceInfo } from '../types';
```
to:
```tsx
import { useEffect, useRef, useState } from 'react';
import { Camera, Cpu, ScanEye, Play, Square } from 'lucide-react';
import { api } from '../services/api';
import { AlertState, DeviceInfo, LocalCameraInfo } from '../types';
```

Change the `Props` interface from:
```tsx
interface Props {
  source: Source;
  onSourceChange: (s: Source) => void;
  running: boolean;
  onRunningChange: (r: boolean) => void;
  state: DisplayState;
  devices: DeviceInfo[];
  alert: AlertState | null;
  landmarks: boolean;
  onLandmarksChange: (on: boolean) => void;
}
```
to:
```tsx
interface Props {
  source: Source;
  onSourceChange: (s: Source) => void;
  running: boolean;
  onRunningChange: (r: boolean) => void;
  state: DisplayState;
  devices: DeviceInfo[];
  alert: AlertState | null;
  landmarks: boolean;
  onLandmarksChange: (on: boolean) => void;
  localCamera: LocalCameraInfo | null;
  onLocalCameraChange: (info: LocalCameraInfo) => void;
  toast: (text: string, kind?: 'ok' | 'err') => void;
}
```

Change the `CameraPanel` function's destructured parameters from:
```tsx
export function CameraPanel({
  source,
  onSourceChange,
  running,
  onRunningChange,
  state,
  devices,
  alert,
  landmarks,
  onLandmarksChange,
}: Props) {
```
to:
```tsx
export function CameraPanel({
  source,
  onSourceChange,
  running,
  onRunningChange,
  state,
  devices,
  alert,
  landmarks,
  onLandmarksChange,
  localCamera,
  onLocalCameraChange,
  toast,
}: Props) {
```

Add a new line right after the `</header>` closing tag (before the `<div className={...aspect-video...}>` that holds the video):
```tsx
      {source === 'esp32' && localCamera?.available && (
        <LocalCameraBar camera={localCamera} onChange={onLocalCameraChange} toast={toast} />
      )}
```

Add this new component at the end of the file, after the existing `Overlay` function:

```tsx
function LocalCameraBar({
  camera,
  onChange,
  toast,
}: {
  camera: LocalCameraInfo;
  onChange: (info: LocalCameraInfo) => void;
  toast: (text: string, kind?: 'ok' | 'err') => void;
}) {
  const [url, setUrl] = useState(camera.cameraStreamUrl ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setUrl(camera.cameraStreamUrl ?? '');
  }, [camera.cameraStreamUrl]);

  const save = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const info = await api.setLocalCamera(trimmed);
      onChange(info);
      toast('Camera stream updated');
    } catch {
      toast('Could not update the camera stream', 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2 border-b border-line bg-paper px-4 py-2 text-sm">
      <span className="text-ink-faint">Camera stream</span>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="http://192.168.1.42/stream"
        className="flex-1 rounded border border-line bg-panel px-2 py-1 font-mono text-xs"
      />
      <button onClick={save} disabled={saving} className="btn-outline px-3 py-1 text-xs">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Manual verification**

There's no automated frontend test harness in this repo. Verify by hand:

1. In one terminal, start a throwaway fake MJPEG server so there's something to point at (same trick used when this area was first built):
   ```bash
   cd MainLogic
   .venv/bin/python -c "
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
2. In a second terminal, seed a starting config and run the backend:
   ```bash
   cd MainLogic
   echo '{"camera_stream_url": "http://127.0.0.1:8099/stream", "camera_device_id": "fake-cam-1"}' > local_config.json
   .venv/bin/python app.py
   ```
3. In a third terminal, create `Client/.env.local` with `VITE_API_BASE_URL=http://localhost:8000`, then:
   ```bash
   cd Client
   npm install
   npm run dev
   ```
4. Open the printed dashboard URL. Select the "ESP32-CAM" source tab. Confirm a "Camera stream" bar appears below the header, pre-filled with `http://127.0.0.1:8099/stream`.
5. Change the field to a different, still-fake URL, e.g. start a second instance of the fake server on port 8098 first (same script, change the port), then type `http://127.0.0.1:8098/stream` and click Save.
6. Confirm a success toast appears, the field keeps showing the new URL, and `curl -s http://localhost:8000/local/camera` reflects the new URL. Confirm `MainLogic/local_config.json` on disk was updated to the new URL too.
7. Stop both fake servers and the backend afterward; delete `local_config.json` and `Client/.env.local` (both are gitignored, but they were only for this manual check).

- [ ] **Step 6: Commit**

```bash
git add Client/src/types/index.ts Client/src/services/api.ts Client/src/App.tsx Client/src/components/CameraPanel.tsx
git commit -m "Add a dashboard control to view and change the local camera stream IP"
```
