from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import traceback
import cv2
import numpy as np
import mediapipe as mp
from io import BytesIO
from collections import deque
from datetime import datetime
import time
import os
import telegram
import asyncio
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

app = Flask(__name__, static_folder='../static')

# Optional: enable CORS if your frontend is served from a different origin
CORS(app, resources={r"/*": {"origins": "*"}})

@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET,PUT,POST,DELETE,OPTIONS'
    return response

app.url_map.strict_slashes = False

# Telegram Configuration
BOT_TOKEN = "8579934462:AAG7ItuNpjkuQ8lqflntPEUATZL4HdhYk5g"
CHAT_ID = "@EARdrowsines_alert"

# Global state for dashboard
class AppState:
    def __init__(self):
        self.current_ear = 0.0
        self.threshold = 0.20 # Lowered from 0.25 for better accuracy
        self.drowsy_time_sec = 3.0 # Increased from 2.0
        self.consecutive_frames = 0
        self.max_buffer = 15 # (3.0s * 5) at ~2-5 FPS
        self.is_drowsy = False
        self.events = deque(maxlen=100)
        self.start_time = time.time()
        self.telegram_configured = True
        self.last_telegram_time = 0
        self.telegram_cooldown = 60 # Seconds between telegram alerts
        
state = AppState()

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

async def send_telegram_alert(message, image_bytes=None):
    try:
        # Use async context manager to ensure proper session handling
        async with telegram.Bot(token=BOT_TOKEN) as bot_client:
            if image_bytes:
                await bot_client.send_photo(chat_id=CHAT_ID, photo=image_bytes, caption=message)
            else:
                await bot_client.send_message(chat_id=CHAT_ID, text=message)
        print("[Telegram] Alert sent successfully")
        return True
    except Exception as e:
        print(f"[Telegram] Failed to send alert: {e}")
        traceback.print_exc()
        return False

@app.route('/', methods=['GET'])
def index():
    return jsonify({"status": "ok deployed"})

@app.route('/static/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

@app.route('/status', methods=['GET'])
def get_status():
    uptime = int(time.time() - state.start_time)
    return jsonify({
        "status": "online",
        "uptime": uptime,
        "camera": "connected",
        "telegram": "configured" if state.telegram_configured else "not_configured"
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
        "consecutive_frames": state.consecutive_frames,
        "max_buffer": state.max_buffer
    })

@app.route('/events', methods=['GET'])
def get_events():
    return jsonify({
        "events": list(state.events)
    })

@app.route('/settings', methods=['POST'])
def update_settings():
    try:
        data = request.json
        if 'ear_threshold' in data:
            state.threshold = float(data['ear_threshold'])
        if 'drowsy_time' in data:
            state.drowsy_time_sec = float(data['drowsy_time'])
            state.max_buffer = max(2, int(state.drowsy_time_sec * 5))  # Use 5 as multiplier for web FPS
        if 'telegram_cooldown' in data:
            state.telegram_cooldown = int(data['telegram_cooldown'])
        return jsonify({"success": True, "message": "Settings updated"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route('/detect', methods=['POST'])
def detect():
    try:
        # 1) Read image bytes
        img_bytes = BytesIO(request.data).read()
        nparr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({"error": "invalid image"}), 400

        # 2) Convert to MediaPipe Image and run FaceLandmarker
        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = landmarker.detect(mp_image)

        if not result.face_landmarks:
            return jsonify({"error": "no face detected"}), 200

        # 3) Compute EAR
        landmarks = result.face_landmarks[0]
        left_ear  = compute_ear(landmarks, LEFT_EYE,  w, h)
        right_ear = compute_ear(landmarks, RIGHT_EYE, w, h)
        avg_ear   = (left_ear + right_ear) / 2.0

        # 4) Update global state
        state.current_ear = avg_ear
        drowsy_np = avg_ear < state.threshold
        drowsy = bool(drowsy_np)
        
        # Track consecutive frames
        if drowsy:
            state.consecutive_frames += 1
        else:
            state.consecutive_frames = 0
            
        was_drowsy = state.is_drowsy
        state.is_drowsy = state.consecutive_frames >= state.max_buffer
        
        # Telegram Alert Logic
        now = time.time()
        if state.is_drowsy and (not was_drowsy or (now - state.last_telegram_time >= state.telegram_cooldown)):
            timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            msg = (f"🚨 Drowsiness Detected!\n"
                   f"Time: {timestamp}\n"
                   f"EAR: {avg_ear:.3f}\n"
                   f"Threshold: {state.threshold:.2f}")
            
            # Send alert with image asynchronously
            _, img_encoded = cv2.imencode('.jpg', frame)
            asyncio.run(send_telegram_alert(msg, img_encoded.tobytes()))
            state.last_telegram_time = now

        # Log event if drowsy
        if state.is_drowsy:
            should_log = False
            if not len(state.events):
                should_log = True
            else:
                last_event_time = datetime.fromisoformat(state.events[0]['timestamp'])
                if (datetime.now() - last_event_time).total_seconds() > 30: # Log every 30s if persistent
                    should_log = True
            
            if should_log or state.consecutive_frames == state.max_buffer:
                event = {
                    "timestamp": datetime.now().isoformat(),
                    "ear": round(avg_ear, 3),
                    "alert_sent": True,
                    "type": "critical"
                }
                state.events.appendleft(event)

        # 5) Return JSON
        return jsonify({
            "drowsy": drowsy,
            "confidence": round(avg_ear, 3),
            "consecutive_frames": state.consecutive_frames,
            "max_buffer": state.max_buffer
        })

    except Exception as e:
        print("[ERROR] in /detect:", e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
