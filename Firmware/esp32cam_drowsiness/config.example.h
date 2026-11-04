// Copy this file to config.h and fill it in. config.h is gitignored.
#pragma once

// 1 = camera test: no Wi-Fi needed; type "snap" in the Serial Monitor.
// Set back to 0 for real use.
#define BENCH_TEST 0

// Optional first-boot network. Leave empty and set Wi-Fi over Bluetooth instead
// (see Firmware/README.md). Once anything is saved on the device, these are ignored.
#define WIFI_SSID ""
#define WIFI_PASS ""

// How long to try each saved network at boot before moving on.
#define WIFI_CONNECT_TIMEOUT_MS 12000

// Bluetooth setup mode gives up after this and retries the saved networks.
#define SETUP_MODE_TIMEOUT_MS 300000

// Same backend the dashboard uses. Must end in /detect.
#define API_URL "https://vision-based-drowsiness-detection-using-ear-mediapipe-face-mesh.fly.dev/detect"

// Shown in the dashboard, Telegram captions and the event log.
#define DEVICE_ID "esp32cam-01"

// Time between frames. 350-500 ms is realistic over TLS to fly.dev.
#define FRAME_INTERVAL_MS 400

// If the server hasn't answered for this long, the OLED shows NO SERVER.
#define LINK_TIMEOUT_MS 6000

// fly.dev cold starts can take several seconds.
#define HTTP_TIMEOUT_MS 8000

// Turn the on-board flash LED (GPIO 4) on for night driving. It is very bright;
// for real use a dim IR LED is kinder to the driver.
#define USE_FLASH_LED 0

// 1 = this board drives the OLED and buzzer itself.
// 0 = a separate alert unit does (Firmware/alert_unit: an ESP32-C3 or a
//     second ESP32-CAM board with no camera).
#define USE_LOCAL_ALERTS 1

// Bluetooth setup PIN used when USE_LOCAL_ALERTS is 0 (no screen to show a
// random one). Change it: anyone nearby who knows it can set the Wi-Fi.
#define SETUP_PIN "changeme"

// Buzzer driven through an NPN transistor: HIGH = on. Set to 0 if your module is active-low.
#define BUZZER_ACTIVE_HIGH 1
