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
    with open(LOCAL_CONFIG_PATH, encoding='utf-8-sig') as f:
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
    with urllib.request.urlopen(stream_url, timeout=10) as reader:
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
        # Also pause after a clean EOF: without this, a camera that closes
        # its stream gets reconnected to in a hot loop.
        time.sleep(2)


def save_local_config(cfg):
    """Writes cfg as local_config.json - the write-side counterpart to
    load_local_config()."""
    with open(LOCAL_CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f)


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
