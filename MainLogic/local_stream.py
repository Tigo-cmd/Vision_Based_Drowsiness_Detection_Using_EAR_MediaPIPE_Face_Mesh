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
        # Also pause after a clean EOF: without this, a camera that closes
        # its stream gets reconnected to in a hot loop.
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
