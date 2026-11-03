from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS
import traceback
import cv2
import numpy as np
import mediapipe as mp
from collections import deque
from datetime import datetime
import threading
import time
import os
import telegram
import asyncio
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

app = Flask(__name__, static_folder='../static')

CORS(app, resources={r"/*": {"origins": "*"}})


@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization,X-Device-Id'
    response.headers['Access-Control-Allow-Methods'] = 'GET,PUT,POST,DELETE,OPTIONS'
    return response


app.url_map.strict_slashes = False

# Telegram configuration comes from the environment so the token never lives in git.
#   fly secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=@EARdrowsines_alert
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "@EARdrowsines_alert").strip()

# A gap longer than this between frames means the stream stalled; don't let an
# old "eyes closed" timestamp carry over into the next frame.
FRAME_GAP_RESET_SEC = 2.0
# A frame source counts as online if it sent a frame within this window.
SOURCE_ONLINE_SEC = 5.0


class AppState:
    def __init__(self):
        self.lock = threading.Lock()
        self.current_ear = 0.0
        self.threshold = 0.20
        self.drowsy_time_sec = 3.0
        # Warning fires at this fraction of drowsy_time_sec.
        self.warning_ratio = 0.5
        self.closed_since = None
        self.last_frame_time = 0.0
        self.consecutive_frames = 0
        self.level = "normal"  # normal | warning | critical
        self.face_detected = False
        self.events = deque(maxlen=100)
        self.start_time = time.time()

        self.telegram_enabled = True
        self.telegram_cooldown = 60
        self.last_telegram_time = 0.0
        self.telegram_last_ok = None      # None = nothing sent yet
        self.telegram_last_error = None
        self.telegram_last_sent_at = None

        # device_id -> {"last_seen": float, "frames": int}
        self.sources = {}
        # Latest JPEG per non-browser device, so the dashboard can show the ESP32 view.
        self.latest_frames = {}

    @property
    def is_drowsy(self):
        return self.level == "critical"

    @property
    def closed_for(self):
        if self.closed_since is None:
            return 0.0
        return max(0.0, self.last_frame_time - self.closed_since)


state = AppState()


def telegram_configured():
    return bool(BOT_TOKEN and CHAT_ID)


# Mediapipe FaceLandmarker setup
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'face_landmarker.task')
base_options = python.BaseOptions(model_asset_path=MODEL_PATH)
options = vision.FaceLandmarkerOptions(
    base_options=base_options,
    output_face_blendshapes=False,
    output_facial_transformation_matrixes=False,
    num_faces=1,
    running_mode=vision.RunningMode.IMAGE)
landmarker = vision.FaceLandmarker.create_from_options(options)
landmarker_lock = threading.Lock()

# EAR landmark indices
LEFT_EYE = [33, 160, 158, 133, 153, 144]
RIGHT_EYE = [362, 385, 387, 263, 373, 380]


def euclidean(p1, p2):
    return np.linalg.norm(np.array(p1) - np.array(p2))


def compute_ear(landmarks, eye_indices, width, height):
    points = [
        (int(landmarks[i].x * width), int(landmarks[i].y * height))
        for i in eye_indices
    ]
    A = euclidean(points[1], points[5])
    B = euclidean(points[2], points[4])
    C = euclidean(points[0], points[3])
    return (A + B) / (2.0 * C)


async def _telegram_send(message, image_bytes=None):
    async with telegram.Bot(token=BOT_TOKEN) as bot_client:
        if image_bytes:
            await bot_client.send_photo(chat_id=CHAT_ID, photo=image_bytes, caption=message)
        else:
            await bot_client.send_message(chat_id=CHAT_ID, text=message)


def send_telegram_alert(message, image_bytes=None):
    """Blocking send. Records the outcome so /status reports real health."""
    if not telegram_configured():
        state.telegram_last_ok = False
        state.telegram_last_error = "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set"
        return False
    try:
        asyncio.run(_telegram_send(message, image_bytes))
        state.telegram_last_ok = True
        state.telegram_last_error = None
        state.telegram_last_sent_at = datetime.now().isoformat()
        print("[Telegram] Alert sent")
        return True
    except Exception as e:
        state.telegram_last_ok = False
        state.telegram_last_error = str(e)
        print(f"[Telegram] Failed to send alert: {e}")
        traceback.print_exc()
        return False


def send_telegram_alert_async(message, image_bytes=None):
    """Fire-and-forget so /detect (and the ESP32 waiting on it) isn't held up."""
    threading.Thread(
        target=send_telegram_alert, args=(message, image_bytes), daemon=True
    ).start()


def telegram_status():
    if not telegram_configured():
        return "not_configured"
    if not state.telegram_enabled:
        return "disabled"
    if state.telegram_last_ok is False:
        return "error"
    return "configured"


def online_sources(now=None):
    now = now or time.time()
    return {
        dev: info for dev, info in state.sources.items()
        if now - info["last_seen"] <= SOURCE_ONLINE_SEC
    }


@app.route('/', methods=['GET'])
def index():
    return jsonify({"status": "ok deployed"})


@app.route('/static/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)


@app.route('/status', methods=['GET'])
def get_status():
    now = time.time()
    uptime = int(now - state.start_time)
    online = online_sources(now)
    return jsonify({
        "status": "online",
        "uptime": uptime,
        "camera": "connected" if online else "idle",
        "telegram": telegram_status(),
        "telegram_last_error": state.telegram_last_error,
        "telegram_last_sent_at": state.telegram_last_sent_at,
        "devices": [
            {
                "id": dev,
                "last_seen_sec": round(now - info["last_seen"], 1),
                "frames": info["frames"],
                "online": dev in online,
            }
            for dev, info in state.sources.items()
        ],
    })


@app.route('/ear', methods=['GET'])
def get_ear():
    return jsonify({
        "ear": round(state.current_ear, 3),
        "threshold": state.threshold,
        "timestamp": int(time.time())
    })


@app.route('/alert', methods=['GET'])
def get_alert():
    return jsonify({
        "drowsy": state.is_drowsy,
        "level": state.level,
        "closed_for": round(state.closed_for, 2),
        "drowsy_time": state.drowsy_time_sec,
        "consecutive_frames": state.consecutive_frames,
        "face": state.face_detected,
    })


@app.route('/events', methods=['GET'])
def get_events():
    return jsonify({"events": list(state.events)})


@app.route('/events', methods=['DELETE'])
def clear_events():
    state.events.clear()
    return jsonify({"success": True})


def settings_payload():
    return {
        "ear_threshold": state.threshold,
        "drowsy_time": state.drowsy_time_sec,
        "telegram_cooldown": state.telegram_cooldown,
        "telegram_enabled": state.telegram_enabled,
    }


@app.route('/settings', methods=['GET'])
def get_settings():
    return jsonify(settings_payload())


@app.route('/settings', methods=['POST'])
def update_settings():
    try:
        data = request.get_json(force=True) or {}
        with state.lock:
            if data.get('ear_threshold') is not None:
                state.threshold = float(data['ear_threshold'])
            if data.get('drowsy_time') is not None:
                state.drowsy_time_sec = max(0.5, float(data['drowsy_time']))
            if data.get('telegram_cooldown') is not None:
                state.telegram_cooldown = int(data['telegram_cooldown'])
            if data.get('telegram_enabled') is not None:
                state.telegram_enabled = bool(data['telegram_enabled'])
        return jsonify({"success": True, "message": "Settings updated", "settings": settings_payload()})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400


@app.route('/telegram/test', methods=['POST'])
def telegram_test():
    """Send a test message and report whether Telegram accepted it."""
    if not telegram_configured():
        return jsonify({"ok": False, "error": "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set"}), 503
    msg = f"Test message from drowsiness monitor ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})"
    ok = send_telegram_alert(msg)
    body = {"ok": ok, "chat_id": CHAT_ID}
    if not ok:
        body["error"] = state.telegram_last_error
    return jsonify(body), 200 if ok else 502


@app.route('/frame/latest', methods=['GET'])
def latest_frame():
    """Most recent JPEG from a hardware camera (e.g. the ESP32-CAM)."""
    device = request.args.get('device')
    frames = state.latest_frames
    if device:
        entry = frames.get(device)
    else:
        entry = max(frames.values(), key=lambda e: e["time"], default=None)
    if not entry:
        return jsonify({"error": "no frame"}), 404
    resp = Response(entry["jpeg"], mimetype='image/jpeg')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


def update_alert_state(eyes_closed, now):
    """Time-based state machine, so it behaves the same at 2 FPS (browser) or 3 FPS (ESP32)."""
    if now - state.last_frame_time > FRAME_GAP_RESET_SEC:
        state.closed_since = None
        state.consecutive_frames = 0
    state.last_frame_time = now

    if eyes_closed:
        state.consecutive_frames += 1
        if state.closed_since is None:
            state.closed_since = now
    else:
        state.consecutive_frames = 0
        state.closed_since = None

    closed_for = state.closed_for
    if closed_for >= state.drowsy_time_sec:
        state.level = "critical"
    elif closed_for >= state.drowsy_time_sec * state.warning_ratio:
        state.level = "warning"
    else:
        state.level = "normal"


@app.route('/detect', methods=['POST'])
def detect():
    try:
        device_id = request.headers.get('X-Device-Id', 'browser')[:64]
        img_bytes = request.get_data()
        nparr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({"error": "invalid image"}), 400

        now = time.time()
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
            if not result.face_landmarks:
                # No face: treat like eyes open for timing, but tell the client.
                state.face_detected = False
                update_alert_state(False, now)
                return jsonify({
                    "error": "no face detected",
                    "face": False,
                    "drowsy": False,
                    "level": state.level,
                    "ear": 0.0,
                    "threshold": state.threshold,
                    "closed_for": 0.0,
                })

            landmarks = result.face_landmarks[0]
            left_ear = compute_ear(landmarks, LEFT_EYE, w, h)
            right_ear = compute_ear(landmarks, RIGHT_EYE, w, h)
            avg_ear = float((left_ear + right_ear) / 2.0)

            state.face_detected = True
            state.current_ear = avg_ear
            eyes_closed = avg_ear < state.threshold

            prev_level = state.level
            update_alert_state(eyes_closed, now)
            entered_critical = state.is_drowsy and prev_level != "critical"

            # Telegram: once on entering critical, then at most every cooldown while it lasts.
            alert_queued = False
            if (state.is_drowsy and state.telegram_enabled and telegram_configured()
                    and (entered_critical or now - state.last_telegram_time >= state.telegram_cooldown)):
                timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                msg = (f"🚨 Drowsiness Detected!\n"
                       f"Time: {timestamp}\n"
                       f"Source: {device_id}\n"
                       f"Eyes closed: {state.closed_for:.1f}s\n"
                       f"EAR: {avg_ear:.3f}\n"
                       f"Threshold: {state.threshold:.2f}")
                _, img_encoded = cv2.imencode('.jpg', frame)
                send_telegram_alert_async(msg, img_encoded.tobytes())
                state.last_telegram_time = now
                alert_queued = True

            # Event log: on entering critical, then every 30s if it persists.
            if state.is_drowsy:
                last = state.events[0] if state.events else None
                stale = last is None or (
                    datetime.now() - datetime.fromisoformat(last['timestamp'])
                ).total_seconds() > 30
                if entered_critical or stale:
                    state.events.appendleft({
                        "timestamp": datetime.now().isoformat(),
                        "ear": round(avg_ear, 3),
                        "duration": round(state.closed_for, 1),
                        "source": device_id,
                        "alert_sent": alert_queued,
                        "type": "critical",
                    })

            return jsonify({
                "face": True,
                "drowsy": state.is_drowsy,
                "eyes_closed": bool(eyes_closed),
                "level": state.level,
                "ear": round(avg_ear, 3),
                "threshold": state.threshold,
                "closed_for": round(state.closed_for, 2),
                "drowsy_time": state.drowsy_time_sec,
                # kept for older clients
                "confidence": round(avg_ear, 3),
                "consecutive_frames": state.consecutive_frames,
            })

    except Exception as e:
        print("[ERROR] in /detect:", e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)
