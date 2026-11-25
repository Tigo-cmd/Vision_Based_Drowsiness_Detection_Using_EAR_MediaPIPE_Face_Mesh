# Dashboard camera-IP control — design

## Problem

The local LAN stream mode (merged, commit 063a8da) lets a locally-run backend
pull frames straight from a camera's `/stream` URL instead of waiting for a
cloud round-trip. The camera's local IP currently has to be set once via
`setup_local.ps1`'s one-time prompt, or by hand-editing
`MainLogic/local_config.json` and restarting the backend. There's no way to
change it from the dashboard while the backend is running.

## Goal

Add a small control in the dashboard's Camera panel (visible only when
running locally) to view and change the camera's stream IP without editing
files or restarting the backend process.

## Non-goals

- No change to the Fly.io/cloud deployment path. The control is invisible
  there (the backend reports no local-stream support), and no new code runs
  under the Docker/gunicorn image.
- No change to how the camera itself serves `/stream`.
- No change to the alert unit's own server-URL setup flow (separate, already
  shipped).

## Design

### Backend (`MainLogic/`)

`start_puller_thread(process_frame_fn) -> Thread | None` is shipped and
tested (`test_start_puller_thread_returns_none_without_config`,
`test_start_puller_thread_calls_process_frame_fn`) — it must keep its exact
current signature and behavior. Its logic (read config, create a
`stop_event`, start a daemon thread) gets factored into a new private
helper, `_start_puller(stream_url, device_id, process_frame_fn) -> (Thread, threading.Event)`,
that returns BOTH handles instead of just the thread. `start_puller_thread()`
becomes a thin wrapper: read the config, call `_start_puller()`, return only
the `Thread` — identical observable behavior, so the existing tests pass
unmodified.

`local_stream.py` gains a small manager class that uses `_start_puller()`
directly (it needs the `stop_event` the public wrapper throws away):

```python
class LocalStreamManager:
    """Owns the puller thread's lifecycle so it can be restarted with a new
    camera URL without restarting the whole backend process. Built on top
    of the same _start_puller() the module-level start_puller_thread() uses,
    just keeping the stop_event handle that function doesn't expose."""

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
        """Stop the current puller (if any), persist the new URL to
        local_config.json, and start a fresh puller against it."""
        if self._stop_event:
            self._stop_event.set()
        save_local_config({"camera_stream_url": stream_url, "camera_device_id": device_id})
        self._start(stream_url, device_id)
```

`local_stream.py` also gains `save_local_config(cfg: dict) -> None`, the
write-side counterpart to the existing `load_local_config()` — same file,
same schema, just writing instead of reading.

`app.py`'s `__main__` block replaces its direct `start_puller_thread(process_frame)`
call with constructing one `LocalStreamManager(process_frame)` and storing it
as `app.local_stream_manager`. When running under Docker/gunicorn, `__main__`
never executes, so `app.local_stream_manager` is simply never set — routes
below handle that with `getattr(app, 'local_stream_manager', None)`.

Two new routes in `app.py`:

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
    return jsonify({"available": True, "camera_stream_url": m.camera_stream_url,
                     "camera_device_id": m.camera_device_id})
```

### Frontend (`Client/`)

- `api.ts` gains `getLocalCamera()` and `setLocalCamera(url: string)`,
  following the existing `request()` helper pattern used by `settings()`/
  `saveSettings()`.
- `App.tsx` fetches `/local/camera` once on mount (same pattern as the
  existing `api.settings()` effect) and keeps the result in state
  (`{available, camera_stream_url, camera_device_id} | null`). Passed down
  to `CameraPanel`.
- `CameraPanel.tsx`: when `source === 'esp32'` and `localCamera?.available`,
  render a small inline control next to the ESP32-CAM tab — the current
  `camera_stream_url` in an editable text field, a Save button. On save,
  calls `api.setLocalCamera(url)`, shows a toast (same `toast()` callback
  already threaded through from `App.tsx` for settings saves), and updates
  local state with the response. Hidden entirely when `available` is false
  (the Fly.io-deployed dashboard always sees `available: false`, so nothing
  changes there) or when `source !== 'esp32'`.

### Data flow for a change

1. User edits the IP field in the Camera panel and clicks Save.
2. `POST /local/camera {"camera_stream_url": "http://<new-ip>/stream"}`.
3. Backend: `LocalStreamManager.restart()` signals the old puller's
   `stop_event`, writes the new URL to `local_config.json`, starts a fresh
   puller thread against the new URL.
4. Response confirms the new URL; dashboard shows a success toast.
5. The existing `/frame/latest` and `/status` polling (unchanged) now reflect
   frames from the new camera as soon as the new puller thread's first frame
   arrives — no page reload, no backend restart.

### Error handling

- Empty/missing URL: 400, frontend shows an error toast, doesn't touch the
  running puller.
- No local-stream support (Docker/Fly, or local run with no manager for some
  other reason): 400, though the frontend should never actually hit this
  since the control is hidden whenever `available` is false.
- A bad URL (unreachable camera): `restart()` still succeeds (it just starts
  a new thread), and `run_puller`'s existing reconnect-with-backoff logic
  handles the failure the same way it always has for any other bad URL —
  no new error handling needed here.

## Testing

- Backend: the existing `test_start_puller_thread_returns_none_without_config`
  and `test_start_puller_thread_calls_process_frame_fn` tests in
  `MainLogic/test_local_stream.py` must keep passing unmodified — they pin
  `start_puller_thread()`'s existing public contract, which the
  `_start_puller()` refactor must not change.
- Backend: `MainLogic/test_local_stream.py` gains tests for
  `LocalStreamManager`: starting with no config leaves `available is False`;
  `restart()` updates `camera_stream_url`/`camera_device_id`, calls
  `save_local_config()` (verify the file contents), and actually stops the
  old thread (verify via a stub `process_frame_fn` that records calls, and
  confirming no further calls arrive on the old URL after `restart()`).
  Also test `save_local_config()` round-trips through `load_local_config()`.
- Backend: `MainLogic/test_process_frame.py` or a new test file covers the
  two new Flask routes with Flask's test client: GET with/without a manager
  attached to the test app; POST with a valid URL, an empty URL, and no
  manager attached.
- Frontend: no existing test harness for `Client/` in this repo (confirmed
  by the rest of the codebase — no `*.test.tsx` files exist); this change
  follows that same convention, verified manually instead.
