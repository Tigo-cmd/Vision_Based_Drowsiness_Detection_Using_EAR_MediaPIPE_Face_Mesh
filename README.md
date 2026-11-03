# 👁️ Driver Drowsiness Monitor

A high-performance, real-time safety system that monitors driver alertness using computer vision and provides instant feedback through a modern web dashboard and Telegram notifications.

![Dashboard Preview](https://via.placeholder.com/1200x630.png?text=Driver+Drowsiness+Monitor+Dashboard)

## 🌟 Features

*   **Real-time Eye Tracking**: Uses MediaPipe and EAR (Eye Aspect Ratio) calculation for high-precision drowsiness detection.
*   **Stable Live Feed**: Optimized React-based vision system with manual Start/Stop controls.
*   **Intelligent Alerting**:
    *   **Warning State**: eyes closed for half the alert duration (default 1.5 s).
    *   **Critical Alert**: eyes closed for the full alert duration (default 3 s). Timing is measured in seconds on the server, so it's the same at any frame rate.
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
export TELEGRAM_BOT_TOKEN=<token from @BotFather>
export TELEGRAM_CHAT_ID=@EARdrowsines_alert
python app.py
```

### 3. Frontend Setup
```bash
cd Client
npm install
npm run dev
```

## ⚙️ Configuration

### Telegram Bot
The bot token is read from the environment, not from the code:

| Variable | Example |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `123456:ABC...` from @BotFather |
| `TELEGRAM_CHAT_ID` | `@EARdrowsines_alert` (default) |

On fly.io:
```bash
fly secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=@EARdrowsines_alert
```

The bot must be an admin of the channel. To check it works, press **Send test**
under System Health on the dashboard, or:
```bash
curl -X POST https://<your-app>.fly.dev/telegram/test
```
`GET /status` reports `telegram` as `configured`, `not_configured`, `disabled`
or `error` (with `telegram_last_error`), based on what actually happened.

### ESP32-CAM hardware unit
See [Firmware/README.md](Firmware/README.md) for an in-car unit with an OLED
and buzzer that uses the same backend and thresholds.

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
│   ├── app.py               # Core logic and API
│   ├── face_landmarker.task # MediaPipe model file
│   └── requirements.txt     # Backend dependencies
├── Firmware/               # ESP32-CAM + OLED + buzzer unit
└── vercel.json             # Deployment configuration
```

## 📝 Deployment

This project is optimized for deployment on **Vercel**:
1. Connect your repository to Vercel.
2. The `vercel.json` file in the root will automatically configure the Python serverless functions.
3. Ensure serverless functions environment allows for enough memory for MediaPipe (at least 512MB recommended).

## 📜 License
MIT License - See [LICENSE](LICENSE) for details............
