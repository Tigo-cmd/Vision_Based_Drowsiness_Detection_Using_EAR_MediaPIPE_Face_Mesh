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
