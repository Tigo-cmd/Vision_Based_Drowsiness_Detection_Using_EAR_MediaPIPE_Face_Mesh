import cv2
import numpy as np
import mediapipe as mp
import time
import os
from collections import deque
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

# --- Configuration ---
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'face_landmarker.task')
EAR_THRESHOLD = 0.25
DROWSY_TIME_SEC = 2
FPS = 30
MAX_BUFFER = DROWSY_TIME_SEC * FPS

# Eye landmark indices for EAR calculation
# Mediapipe Tasks FaceLandmarker uses the same 468 mesh points as the legacy FaceMesh
LEFT_EYE = [33, 160, 158, 133, 153, 144]
RIGHT_EYE = [362, 385, 387, 263, 373, 380]

def euclidean(p1, p2):
    return np.linalg.norm(np.array(p1) - np.array(p2))

def compute_ear(landmarks, eye_indices, image_width, image_height):
    # landmarks is a list of NormalizedLandmark objects
    points = [(int(landmarks[i].x * image_width), int(landmarks[i].y * image_height)) for i in eye_indices]
    A = euclidean(points[1], points[5])
    B = euclidean(points[2], points[4])
    C = euclidean(points[0], points[3])
    ear = (A + B) / (2.0 * C)
    return ear

def main():
    # --- Mediapipe FaceLandmarker Setup ---
    base_options = python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.FaceLandmarkerOptions(
        base_options=base_options,
        output_face_blendshapes=False,
        output_facial_transformation_matrixes=False,
        num_faces=1,
        running_mode=vision.RunningMode.VIDEO)
    
    # Initialize the landmarker
    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        
        # Smoothing buffer
        ear_buffer = deque(maxlen=MAX_BUFFER)
        consec_frames = 0
        
        # Start webcam
        cap = cv2.VideoCapture(0)
        print("[i] Press 'q' to quit.")
        
        start_time = time.time()

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            # Convert to Mediapipe Image
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            
            # Timestamp in ms
            frame_timestamp_ms = int((time.time() - start_time) * 1000)
            
            # Detect
            face_landmarker_result = landmarker.detect_for_video(mp_image, frame_timestamp_ms)
            
            status = "No face"
            color = (0, 255, 255)

            if face_landmarker_result.face_landmarks:
                # face_landmarks is a list of lists (one per face)
                landmarks = face_landmarker_result.face_landmarks[0]
                
                left_ear = compute_ear(landmarks, LEFT_EYE, w, h)
                right_ear = compute_ear(landmarks, RIGHT_EYE, w, h)
                avg_ear = (left_ear + right_ear) / 2.0

                ear_buffer.append(avg_ear)

                if avg_ear < EAR_THRESHOLD:
                    consec_frames += 1
                else:
                    consec_frames = 0

                drowsy = consec_frames >= MAX_BUFFER

                status = f"{'DROWSY' if drowsy else 'ALERT'} (EAR: {avg_ear:.2f})"
                color = (0, 0, 255) if drowsy else (0, 255, 0)
                
                # Optional: visual debug of eye points
                for i in LEFT_EYE + RIGHT_EYE:
                    pt = (int(landmarks[i].x * w), int(landmarks[i].y * h))
                    cv2.circle(frame, pt, 2, (0, 255, 0), -1)

            # Overlay status
            cv2.putText(frame, status, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, color, 2, cv2.LINE_AA)
            cv2.imshow('EAR-Based Drowsiness Detector', frame)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

        cap.release()
        cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
