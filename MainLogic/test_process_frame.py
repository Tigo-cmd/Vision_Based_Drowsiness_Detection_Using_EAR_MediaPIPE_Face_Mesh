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
