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
