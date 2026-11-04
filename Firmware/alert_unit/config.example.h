// Copy this file to config.h and fill it in. config.h is gitignored.
#pragma once

// 1 = wiring test: no Wi-Fi needed, the OLED and buzzer repeat
// ALERT -> WARNING -> WAKE UP. Set back to 0 for real use.
#define BENCH_TEST 0

// Optional first-boot network. Leave empty and set Wi-Fi through the setup hotspot instead.
#define WIFI_SSID ""
#define WIFI_PASS ""

// Same backend as the camera, without a trailing slash.
#define API_BASE "https://vision-based-drowsiness-detection-using-ear-mediapipe-face-mesh.fly.dev"

// Name on the OLED top line.
#define UNIT_NAME "alert-unit"

// How often to ask the server for the alert state.
#define POLL_INTERVAL_MS 250

// Camera counts as stopped if the server has had no frame for this long.
#define CAMERA_STALE_SEC 5.0

// Server counts as unreachable after this long without an answer.
#define LINK_TIMEOUT_MS 4000
#define HTTP_TIMEOUT_MS 6000

// While monitoring is off (no Wi-Fi, server or camera), chirp this often.
#define MONITOR_OFF_CHIRP_MS 30000

// Pins are picked from the board selected in Arduino. Set VIBRATION_PIN or
// BUTTON_PIN to -1 if not fitted.
#if CONFIG_IDF_TARGET_ESP32C3
// ESP32-C3 SuperMini
#define OLED_SDA 8
#define OLED_SCL 9
#define BUZZER_PIN 4
#define VIBRATION_PIN 5
#define BUTTON_PIN 3
#else
// ESP32-CAM board with no camera fitted (AI Thinker). Same pins as the
// single-board build. GPIO 4 would also flash the bright LED, so no motor.
#define OLED_SDA 15
#define OLED_SCL 14
#define BUZZER_PIN 13
#define VIBRATION_PIN -1
#define BUTTON_PIN 2
#endif

// Buzzer through an NPN transistor: HIGH = on. Set to 0 if your module is active-low.
#define BUZZER_ACTIVE_HIGH 1

#define WIFI_CONNECT_TIMEOUT_MS 12000
#define SETUP_MODE_TIMEOUT_MS 300000
