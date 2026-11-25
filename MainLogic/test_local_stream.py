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
