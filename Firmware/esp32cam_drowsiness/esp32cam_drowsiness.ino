/*
  ESP32-CAM drowsiness node

  Captures JPEG frames, POSTs them to the backend's /detect endpoint, and uses
  the answer to drive an SSD1306 OLED and a buzzer. The backend does the EAR
  maths and Telegram alerts, so thresholds changed on the dashboard apply here
  too.

  Board: AI-Thinker ESP32-CAM. Wiring and setup: see Firmware/README.md.
  Libraries: Adafruit SSD1306, Adafruit GFX, ArduinoJson (v7).
*/

#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFiProv.h>
#include "esp_bt.h"

#include "config.h"
#include "wifi_store.h"

// arduino-esp32 3.x renamed the provisioning constants.
#if ESP_ARDUINO_VERSION_MAJOR >= 3
#define PROV_SCHEME_BLE NETWORK_PROV_SCHEME_BLE
#define PROV_FREE_BTDM NETWORK_PROV_SCHEME_HANDLER_FREE_BTDM
#define PROV_SECURITY_1 NETWORK_PROV_SECURITY_1
#else
#define PROV_SCHEME_BLE WIFI_PROV_SCHEME_BLE
#define PROV_FREE_BTDM WIFI_PROV_SCHEME_HANDLER_FREE_BTDM
#define PROV_SECURITY_1 WIFI_PROV_SECURITY_1
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASS
#define WIFI_PASS ""
#endif
#ifndef WIFI_CONNECT_TIMEOUT_MS
#define WIFI_CONNECT_TIMEOUT_MS 12000
#endif
#ifndef SETUP_MODE_TIMEOUT_MS
#define SETUP_MODE_TIMEOUT_MS 300000
#endif
#define DOUBLE_RESET_WINDOW_MS 4000

// ---- AI-Thinker camera pins ----
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// ---- Peripherals ----
// GPIO 14/15/13 are the SD-card pins; they are free as long as no SD card is used.
// Avoid GPIO 12: it is a boot strapping pin and a buzzer pulling it high can stop the board booting.
#define OLED_SDA 15
#define OLED_SCL 14
#define BUZZER_PIN 13
#define FLASH_LED_PIN 4

#define OLED_W 128
#define OLED_H 64
Adafruit_SSD1306 oled(OLED_W, OLED_H, &Wire, -1);
bool oledOk = false;

// ---- Shared state (written by loop, read by the buzzer task) ----
enum Level : uint8_t { LVL_NORMAL, LVL_WARNING, LVL_CRITICAL, LVL_OFFLINE };
volatile Level level = LVL_OFFLINE;
volatile bool chirpRequest = false;

float lastEar = 0, lastThreshold = 0, closedFor = 0, drowsyTime = 3;
bool faceSeen = false;
unsigned long lastOkMs = 0;
unsigned long lastShotMs = 0;
int lastHttpCode = 0;

WiFiClientSecure tls;

// ---------------------------------------------------------------------------

void buzz(bool on) {
  digitalWrite(BUZZER_PIN, (on == (bool)BUZZER_ACTIVE_HIGH) ? HIGH : LOW);
}

// Runs on its own core so beep timing stays steady while HTTP blocks the loop.
void buzzerTask(void *) {
  for (;;) {
    if (chirpRequest) {
      chirpRequest = false;
      buzz(true); vTaskDelay(pdMS_TO_TICKS(40));
      buzz(false); vTaskDelay(pdMS_TO_TICKS(60));
      buzz(true); vTaskDelay(pdMS_TO_TICKS(40));
      buzz(false);
    }
    switch (level) {
      case LVL_CRITICAL:  // fast continuous beeping
        buzz(true);  vTaskDelay(pdMS_TO_TICKS(120));
        buzz(false); vTaskDelay(pdMS_TO_TICKS(80));
        break;
      case LVL_WARNING:   // slow single beeps
        buzz(true);  vTaskDelay(pdMS_TO_TICKS(70));
        buzz(false); vTaskDelay(pdMS_TO_TICKS(530));
        break;
      default:
        buzz(false); vTaskDelay(pdMS_TO_TICKS(50));
    }
  }
}

bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;
  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.grab_mode = CAMERA_GRAB_LATEST;  // always send the newest frame, never a stale one

  if (psramFound()) {
    c.frame_size = FRAMESIZE_VGA;    // 640x480: enough detail around the eyes
    c.jpeg_quality = 12;
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    c.frame_size = FRAMESIZE_QVGA;
    c.jpeg_quality = 14;
    c.fb_count = 1;
    c.fb_location = CAMERA_FB_IN_DRAM;
  }

  if (esp_camera_init(&c) != ESP_OK) return false;

  sensor_t *s = esp_camera_sensor_get();
  s->set_vflip(s, 0);    // flip these if the image is upside down / mirrored
  s->set_hmirror(s, 0);
  return true;
}

void drawScreen() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);

  // Top line: device + wifi
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print(DEVICE_ID);
  oled.setCursor(OLED_W - 6 * 4, 0);
  oled.print(WiFi.status() == WL_CONNECTED ? "WiFi" : "----");
  oled.drawFastHLine(0, 10, OLED_W, SSD1306_WHITE);

  // Middle: state, large
  const char *label;
  if (WiFi.status() != WL_CONNECTED) label = "NO WIFI";
  else if (level == LVL_OFFLINE)     label = "NO SERVER";
  else if (!faceSeen)                label = "NO FACE";
  else if (level == LVL_CRITICAL)    label = "WAKE UP";
  else if (level == LVL_WARNING)     label = "WARNING";
  else                               label = "ALERT";

  bool invert = (level == LVL_CRITICAL);
  if (invert) oled.fillRect(0, 13, OLED_W, 22, SSD1306_WHITE);
  oled.setTextColor(invert ? SSD1306_BLACK : SSD1306_WHITE);
  oled.setTextSize(2);
  int16_t x1, y1; uint16_t w, h;
  oled.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_W - w) / 2, 17);
  oled.print(label);
  oled.setTextColor(SSD1306_WHITE);

  // Bottom: numbers
  oled.setTextSize(1);
  oled.setCursor(0, 40);
  if (level == LVL_OFFLINE) {
    oled.print("HTTP ");
    oled.print(lastHttpCode);
  } else {
    oled.print("EAR ");
    oled.print(lastEar, 3);
    oled.print(" / ");
    oled.print(lastThreshold, 2);
  }

  // Bar: how close we are to the critical alert
  float frac = drowsyTime > 0 ? closedFor / drowsyTime : 0;
  if (frac > 1) frac = 1;
  oled.drawRect(0, 53, OLED_W, 10, SSD1306_WHITE);
  oled.fillRect(2, 55, (int)((OLED_W - 4) * frac), 6, SSD1306_WHITE);

  oled.display();
}

Level parseLevel(const char *s) {
  if (!s) return LVL_NORMAL;
  if (!strcmp(s, "critical")) return LVL_CRITICAL;
  if (!strcmp(s, "warning")) return LVL_WARNING;
  return LVL_NORMAL;
}

void captureAndSend() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[cam] capture failed");
    return;
  }

  HTTPClient http;
  http.setReuse(true);  // keep the TLS session open between frames
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(tls, API_URL);
  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("X-Device-Id", DEVICE_ID);

  int code = http.POST(fb->buf, fb->len);
  esp_camera_fb_return(fb);
  lastHttpCode = code;

  if (code == 200) {
    JsonDocument doc;
    if (deserializeJson(doc, http.getStream()) == DeserializationError::Ok) {
      faceSeen = doc["face"] | false;
      lastEar = doc["ear"] | 0.0f;
      lastThreshold = doc["threshold"] | lastThreshold;
      closedFor = doc["closed_for"] | 0.0f;
      drowsyTime = doc["drowsy_time"] | drowsyTime;
      level = parseLevel(doc["level"].as<const char *>());
      lastOkMs = millis();
    }
  } else {
    Serial.printf("[http] %d %s\n", code, http.errorToString(code).c_str());
  }
  http.end();
}

// ---------------------------------------------------------------------------
// Bluetooth setup mode
//
// Uses Espressif's standard BLE provisioning, so the free "ESP BLE Provisioning"
// app (Android / iOS) works with no custom app. The link is encrypted
// (Security 1) and the app needs the PIN shown on the OLED, so a passer-by
// can't push their own network onto the device.
//
// Setup mode runs in its own boot: the camera is not started, and after a
// network is saved the board restarts. Bluetooth is never on while monitoring.
// ---------------------------------------------------------------------------

String provName, provPin;
String pendingSsid, pendingPass;
volatile bool provSaved = false, provFailed = false, provEnded = false;

void drawSetupScreen(unsigned long msLeft) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print("BLUETOOTH SETUP");
  oled.drawFastHLine(0, 10, OLED_W, SSD1306_WHITE);
  oled.setCursor(0, 14);
  oled.print(provName);
  oled.setCursor(0, 26);
  oled.print("PIN");
  oled.setTextSize(2);
  oled.setCursor(24, 23);
  oled.print(provPin);
  oled.setTextSize(1);
  oled.setCursor(0, 44);
  if (provFailed) oled.print("Wrong password? Retry");
  else if (provSaved) oled.print("Saved. Restarting...");
  else oled.print("App: ESP BLE Prov");
  oled.setCursor(0, 55);
  oled.printf("Exits in %lus", msLeft / 1000);
  oled.display();
}

void onProvEvent(arduino_event_t *e) {
  switch (e->event_id) {
    case ARDUINO_EVENT_PROV_CRED_RECV: {
      // Hold on to these until the board has actually joined the network.
      // ssid/password are fixed-size arrays and not null-terminated when full.
      char ssid[33] = {0}, pass[65] = {0};
      memcpy(ssid, e->event_info.prov_cred_recv.ssid, 32);
      memcpy(pass, e->event_info.prov_cred_recv.password, 64);
      pendingSsid = ssid;
      pendingPass = pass;
      provFailed = false;
      Serial.printf("[setup] got credentials for \"%s\"\n", pendingSsid.c_str());
      break;
    }
    case ARDUINO_EVENT_PROV_CRED_FAIL:
      // The app is told too, and the user can resend. Nothing is saved.
      provFailed = true;
      Serial.println("[setup] could not join, wrong password or out of range");
      break;
    case ARDUINO_EVENT_PROV_CRED_SUCCESS:
      wifistore::add(pendingSsid, pendingPass);
      provSaved = true;
      Serial.println("[setup] joined, network saved");
      break;
    case ARDUINO_EVENT_PROV_END:
      provEnded = true;
      break;
    default:
      break;
  }
}

void runSetupMode() {
  wifistore::disarmDoubleReset();  // so a reset from here is a normal boot
  uint64_t mac = ESP.getEfuseMac();
  char name[16];
  snprintf(name, sizeof(name), "PROV_%02X%02X%02X",  // the app lists devices named PROV_*
           (uint8_t)(mac >> 24), (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  provName = name;
  provPin = String(10000000 + esp_random() % 90000000);  // fresh 8-digit PIN every time

  Serial.printf("[setup] Bluetooth setup: name %s, PIN %s\n", provName.c_str(), provPin.c_str());
  WiFi.onEvent(onProvEvent);
  // reset_provisioned=true: we keep our own list, so start the driver from clean.
  WiFiProv.beginProvision(PROV_SCHEME_BLE, PROV_FREE_BTDM, PROV_SECURITY_1,
                          provPin.c_str(), provName.c_str(), nullptr, nullptr, true);

  // Slow double chirp every few seconds so it's obvious the unit isn't monitoring.
  unsigned long t0 = millis(), lastChirp = 0, savedAt = 0;
  while (true) {
    unsigned long el = millis() - t0;
    drawSetupScreen(el < SETUP_MODE_TIMEOUT_MS ? SETUP_MODE_TIMEOUT_MS - el : 0);
    if (millis() - lastChirp > 5000) { chirpRequest = true; lastChirp = millis(); }
    if (provSaved && !savedAt) savedAt = millis();
    // Give the app a moment to receive "success" before rebooting.
    if ((savedAt && millis() - savedAt > 3000) || (provSaved && provEnded)) break;
    if (el > SETUP_MODE_TIMEOUT_MS) {
      Serial.println("[setup] timed out");
      break;
    }
    delay(200);
  }
  delay(500);
  ESP.restart();
}

// Try saved networks, most recently added first.
bool connectSavedWifi() {
  WifiCred list[WIFI_STORE_MAX];
  int n = wifistore::load(list);
  WiFi.persistent(false);  // our list in NVS is the source of truth
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);    // lower latency
  for (int i = 0; i < n; i++) {
    Serial.printf("[wifi] trying \"%s\"\n", list[i].ssid.c_str());
    WiFi.begin(list[i].ssid.c_str(), list[i].pass.c_str());
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT_MS) {
      drawScreen();
      delay(250);
    }
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("[wifi] connected to \"%s\", %s\n", list[i].ssid.c_str(),
                    WiFi.localIP().toString().c_str());
      WiFi.setAutoReconnect(true);
      return true;
    }
    WiFi.disconnect();
  }
  return false;
}

// Serial commands for the bench: "wifi list", "wifi clear", "setup".
void handleSerial() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd == "wifi list") {
    WifiCred list[WIFI_STORE_MAX];
    int n = wifistore::load(list);
    Serial.printf("%d saved network(s)\n", n);
    for (int i = 0; i < n; i++) Serial.printf("  %d: %s\n", i, list[i].ssid.c_str());
  } else if (cmd == "wifi clear") {
    wifistore::clear();
    Serial.println("Saved networks cleared. Restarting into setup.");
    delay(200);
    ESP.restart();
  } else if (cmd == "setup") {
    Preferences p; p.begin("boot", false); p.putBool("armed", true); p.end();
    ESP.restart();
  }
}

void initOled() {
  // Camera uses its own I2C port for SCCB, so Wire (port 0) is free for the OLED.
  Wire.begin(OLED_SDA, OLED_SCL);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) Serial.println("[oled] not found at 0x3C, continuing without display");
}

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  buzz(false);
  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);
  xTaskCreatePinnedToCore(buzzerTask, "buzzer", 2048, nullptr, 1, nullptr, 0);

  // Credentials from config.h are only a first-boot default; after that, use Bluetooth.
  WifiCred tmp[WIFI_STORE_MAX];
  int saved = wifistore::load(tmp);
  if (saved == 0 && strlen(WIFI_SSID) > 0) {
    wifistore::add(WIFI_SSID, WIFI_PASS);
    saved = 1;
  }

  bool doubleReset = wifistore::checkDoubleReset();
  if (!doubleReset) {
    // Close the double-reset window after a few seconds, whatever setup is doing.
    xTaskCreate([](void *) {
      vTaskDelay(pdMS_TO_TICKS(DOUBLE_RESET_WINDOW_MS));
      wifistore::disarmDoubleReset();
      vTaskDelete(nullptr);
    }, "drd", 3072, nullptr, 1, nullptr);
  }
  if (doubleReset || saved == 0) {
    initOled();
    Serial.println(doubleReset ? "[boot] double reset, entering setup" : "[boot] no saved Wi-Fi, entering setup");
    runSetupMode();
  }

  // Normal boot: Bluetooth won't be used, so hand its RAM (~60 KB) back to the
  // heap for the camera and TLS.
  esp_bt_controller_mem_release(ESP_BT_MODE_BTDM);

  if (!initCamera()) {
    Serial.println("[cam] init failed, restarting");
    delay(2000);
    ESP.restart();
  }
  initOled();
  digitalWrite(FLASH_LED_PIN, USE_FLASH_LED ? HIGH : LOW);

  // fly.dev uses a public CA. setInsecure() skips certificate checks to keep setup
  // simple; pin the root CA with tls.setCACert() if the link matters to you.
  tls.setInsecure();

  if (!connectSavedWifi()) {
    // None of the saved networks are around. Restart into Bluetooth setup (a
    // clean boot, since Bluetooth RAM was released above). If nobody uses it,
    // setup times out and the board tries the saved networks again, which
    // covers a phone hotspot switched on after the car starts.
    Serial.println("[wifi] no saved network reachable, restarting into setup");
    Preferences p; p.begin("boot", false); p.putBool("armed", true); p.end();
    delay(200);
    ESP.restart();
  }
  chirpRequest = true;  // audible "I'm alive"
}

void loop() {
  unsigned long now = millis();
  handleSerial();

  if (WiFi.status() == WL_CONNECTED && now - lastShotMs >= FRAME_INTERVAL_MS) {
    lastShotMs = now;
    captureAndSend();
  }

  // Lost the server: stop any alarm pattern and chirp once so the driver knows
  // the monitor is not watching.
  bool linkDown = WiFi.status() != WL_CONNECTED || millis() - lastOkMs > LINK_TIMEOUT_MS;
  if (linkDown && level != LVL_OFFLINE) {
    level = LVL_OFFLINE;
    chirpRequest = true;
  }

  drawScreen();
  delay(10);
}
