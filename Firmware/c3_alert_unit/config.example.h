// Copy this file to config.h and fill it in. config.h is gitignored.
#pragma once

// Optional first-boot network. Leave empty and set Wi-Fi over Bluetooth instead.
#define WIFI_SSID ""
#define WIFI_PASS ""

// Same backend as the camera, without a trailing slash.
#define API_BASE "https://vision-based-drowsiness-detection-using-ear-mediapipe-face-mesh.fly.dev"

// Name on the OLED top line.
#define UNIT_NAME "alert-c3"

// How often to ask the server for the alert state.
#define POLL_INTERVAL_MS 250

// Camera counts as stopped if the server has had no frame for this long.
#define CAMERA_STALE_SEC 5.0

// Server counts as unreachable after this long without an answer.
#define LINK_TIMEOUT_MS 4000
#define HTTP_TIMEOUT_MS 6000

// While monitoring is off (no Wi-Fi, server or camera), chirp this often.
#define MONITOR_OFF_CHIRP_MS 30000

// Pins (ESP32-C3 SuperMini). Set VIBRATION_PIN or BUTTON_PIN to -1 if not fitted.
#define OLED_SDA 8
#define OLED_SCL 9
#define BUZZER_PIN 4
#define VIBRATION_PIN 5
#define BUTTON_PIN 3

// Buzzer through an NPN transistor: HIGH = on. Set to 0 if your module is active-low.
#define BUZZER_ACTIVE_HIGH 1

#define WIFI_CONNECT_TIMEOUT_MS 12000
#define SETUP_MODE_TIMEOUT_MS 300000
