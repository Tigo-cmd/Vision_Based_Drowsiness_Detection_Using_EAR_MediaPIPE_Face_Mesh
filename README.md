# 👁️ Driver Drowsiness Monitor

A high-performance, real-time safety system that monitors driver alertness using computer vision and provides instant feedback through a modern web dashboard and Telegram notifications.

![Dashboard Preview](https://via.placeholder.com/1200x630.png?text=Driver+Drowsiness+Monitor+Dashboard)

## 🌟 Features

*   **Real-time Eye Tracking**: Uses MediaPipe and EAR (Eye Aspect Ratio) calculation for high-precision drowsiness detection.
*   **Stable Live Feed**: Optimized React-based vision system with manual Start/Stop controls.
*   **Intelligent Alerting**:
    *   **Warning State**: Triggered after ~2 seconds of sustained drowsiness (Visual amber glow).
    *   **Critical Alert**: Triggered after ~6 seconds of sustained drowsiness (Visual red pulse + alarming).
*   **Telegram Integration**: Automated alerts sent to `@EARdrowsines_alert` including JPEG snapshots of the driver and precise timestamps.
*   **Modern Analytics Dashboard**: Real-time graphs for EAR value, system health status, and a detailed event log.
*   **Customizable Thresholds**: Adjustable EAR sensitivity and notification cooldowns via the settings panel.

## 🛠️ Tech Stack

-   **Frontend**: React 18, TypeScript, Tailwind CSS, Lucide React.
-   **Backend**: Flask (Python), MediaPipe, OpenCV, Asyncio.
-   **Communication**: REST API, Telegram Bot API.
-   **Deployment**: Vercel ready (Backend & Frontend).

## 🚀 Installation & Setup

### 1. Prerequisites
- Python 3.10+
- Node.js 18+
- A webcam

### 2. Backend Setup
```bash
cd MainLogic
pip install -r requirements.txt --break-system-packages
# Ensure face_landmarker.task is in the MainLogic folder
python Drowniness_detect.py
```

### 3. Frontend Setup
```bash
cd Client
npm install
npm run dev
```

## ⚙️ Configuration

### Telegram Bot
The system is pre-configured to send alerts to the `@EARdrowsines_alert` channel. To use your own bot:
1. Update `BOT_TOKEN` and `CHAT_ID` in `MainLogic/Drowniness_detect.py`.
2. Ensure your bot has permission to post to the specified channel.

### Accuracy Tuning
- **EAR Threshold**: Default is set to `0.20`. Lower values make the system less sensitive (requiring more eye closure).
- **Notification Cooldown**: Default is `60s` to prevent alert spamming.

## 🏗️ Project Structure

```text
├── Client/                 # React Frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/     # UI Components (CameraFeed, EventLog, etc.)
│   │   ├── services/       # API Integration
│   │   └── types/          # TypeScript Definitions
├── MainLogic/              # Python Backend (Flask)
│   ├── Drowniness_detect.py # Core logic and API
│   ├── face_landmarker.task # MediaPipe model file
│   └── requirements.txt     # Backend dependencies
└── vercel.json             # Deployment configuration
```

## 📝 Deployment

This project is optimized for deployment on **Vercel**:
1. Connect your repository to Vercel.
2. The `vercel.json` file in the root will automatically configure the Python serverless functions.
3. Ensure serverless functions environment allows for enough memory for MediaPipe (at least 512MB recommended).

## 📜 License
MIT License - See [LICENSE](LICENSE) for details.
