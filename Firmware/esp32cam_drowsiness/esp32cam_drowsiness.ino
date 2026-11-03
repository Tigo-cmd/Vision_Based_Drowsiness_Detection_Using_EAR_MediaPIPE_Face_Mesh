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

#include "config.h"

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

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  buzz(false);
  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, USE_FLASH_LED ? HIGH : LOW);

  if (!initCamera()) {
    Serial.println("[cam] init failed, restarting");
    delay(2000);
    ESP.restart();
  }

  // Camera uses its own I2C port for SCCB, so Wire (port 0) is free for the OLED.
  Wire.begin(OLED_SDA, OLED_SCL);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) Serial.println("[oled] not found at 0x3C, continuing without display");

  xTaskCreatePinnedToCore(buzzerTask, "buzzer", 2048, nullptr, 1, nullptr, 0);

  // fly.dev uses a public CA. setInsecure() skips certificate checks to keep setup
  // simple; pin the root CA with tls.setCACert() if the link matters to you.
  tls.setInsecure();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // lower latency
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setAutoReconnect(true);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    drawScreen();
    delay(250);
  }
  Serial.printf("[wifi] %s %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "not connected",
                WiFi.localIP().toString().c_str());
  chirpRequest = true;  // audible "I'm alive"
}

void loop() {
  unsigned long now = millis();

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
