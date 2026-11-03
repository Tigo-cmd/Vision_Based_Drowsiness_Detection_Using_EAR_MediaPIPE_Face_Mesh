/*
  ESP32-C3 alert unit

  The ESP32-CAM only captures frames and sends them to the server. This board
  asks the server for the alert state a few times a second and drives the
  OLED, the buzzer and an optional vibration motor from it.

  Because it asks the server rather than the camera, it also notices when the
  camera stops sending and warns that monitoring is off.

  Board: ESP32-C3 SuperMini (any ESP32-C3 works; adjust pins in config.h).
  Libraries: Adafruit SSD1306, Adafruit GFX, ArduinoJson (v7).
  Setup and wiring: see Firmware/README.md.
*/

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

// The C3 has Bluetooth LE only. arduino-esp32 3.x renamed the constants.
#if ESP_ARDUINO_VERSION_MAJOR >= 3
#define PROV_SCHEME_BLE NETWORK_PROV_SCHEME_BLE
#define PROV_FREE_BLE NETWORK_PROV_SCHEME_HANDLER_FREE_BLE
#define PROV_SECURITY_1 NETWORK_PROV_SECURITY_1
#else
#define PROV_SCHEME_BLE WIFI_PROV_SCHEME_BLE
#define PROV_FREE_BLE WIFI_PROV_SCHEME_HANDLER_FREE_BLE
#define PROV_SECURITY_1 WIFI_PROV_SECURITY_1
#endif

#define DOUBLE_RESET_WINDOW_MS 4000

#define OLED_W 128
#define OLED_H 64
Adafruit_SSD1306 oled(OLED_W, OLED_H, &Wire, -1);
bool oledOk = false;

// What the unit is showing. The first four mean monitoring is off.
enum Level : uint8_t { LVL_NO_WIFI, LVL_NO_SERVER, LVL_NO_CAMERA, LVL_NO_FACE,
                       LVL_NORMAL, LVL_WARNING, LVL_CRITICAL };
volatile Level level = LVL_NO_SERVER;
volatile bool chirpRequest = false;
volatile bool muted = false;

float lastEar = 0, lastThreshold = 0.2, closedFor = 0, drowsyTime = 3, frameAge = -1;
unsigned long lastOkMs = 0, lastPollMs = 0, lastOffChirpMs = 0;
int lastHttpCode = 0;

WiFiClientSecure tls;
HTTPClient http;

bool monitoringOff(Level l) { return l <= LVL_NO_CAMERA; }

// ---------------------------------------------------------------------------
// Buzzer and vibration
// ---------------------------------------------------------------------------

void outputs(bool on) {
  digitalWrite(BUZZER_PIN, (on == (bool)BUZZER_ACTIVE_HIGH) ? HIGH : LOW);
  if (VIBRATION_PIN >= 0) digitalWrite(VIBRATION_PIN, on ? HIGH : LOW);
}

void buzzerTask(void *) {
  for (;;) {
    if (chirpRequest) {
      chirpRequest = false;
      digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? HIGH : LOW); vTaskDelay(pdMS_TO_TICKS(40));
      digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? LOW : HIGH); vTaskDelay(pdMS_TO_TICKS(60));
      digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? HIGH : LOW); vTaskDelay(pdMS_TO_TICKS(40));
      digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? LOW : HIGH);
    }
    Level l = level;
    if (l == LVL_CRITICAL && !muted) {        // fast continuous beeping
      outputs(true);  vTaskDelay(pdMS_TO_TICKS(120));
      outputs(false); vTaskDelay(pdMS_TO_TICKS(80));
    } else if (l == LVL_WARNING && !muted) {  // slow single beeps
      outputs(true);  vTaskDelay(pdMS_TO_TICKS(70));
      outputs(false); vTaskDelay(pdMS_TO_TICKS(530));
    } else {
      outputs(false); vTaskDelay(pdMS_TO_TICKS(50));
    }
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

void drawCentered(const char *text, int y, int size) {
  int16_t x1, y1; uint16_t w, h;
  oled.setTextSize(size);
  oled.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_W - w) / 2, y);
  oled.print(text);
}

void drawScreen() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print(UNIT_NAME);
  oled.setCursor(OLED_W - 6 * 5, 0);
  oled.print(muted ? "MUTED" : (WiFi.status() == WL_CONNECTED ? " WiFi" : " ----"));
  oled.drawFastHLine(0, 10, OLED_W, SSD1306_WHITE);

  const char *label;
  switch (level) {
    case LVL_NO_WIFI:   label = "NO WIFI"; break;
    case LVL_NO_SERVER: label = "NO SERVER"; break;
    case LVL_NO_CAMERA: label = "NO CAMERA"; break;
    case LVL_NO_FACE:   label = "NO FACE"; break;
    case LVL_CRITICAL:  label = "WAKE UP"; break;
    case LVL_WARNING:   label = "WARNING"; break;
    default:            label = "ALERT"; break;
  }
  bool invert = (level == LVL_CRITICAL);
  if (invert) oled.fillRect(0, 13, OLED_W, 22, SSD1306_WHITE);
  oled.setTextColor(invert ? SSD1306_BLACK : SSD1306_WHITE);
  drawCentered(label, 17, 2);
  oled.setTextColor(SSD1306_WHITE);

  oled.setTextSize(1);
  oled.setCursor(0, 40);
  if (level == LVL_NO_SERVER) {
    oled.print("HTTP ");
    oled.print(lastHttpCode);
  } else if (level == LVL_NO_CAMERA) {
    if (frameAge < 0) oled.print("camera never seen");
    else { oled.print("last frame "); oled.print((int)frameAge); oled.print("s ago"); }
  } else if (level != LVL_NO_WIFI) {
    oled.print("EAR ");
    oled.print(lastEar, 3);
    oled.print(" / ");
    oled.print(lastThreshold, 2);
  }

  float frac = drowsyTime > 0 ? closedFor / drowsyTime : 0;
  if (frac > 1) frac = 1;
  if (monitoringOff(level)) frac = 0;
  oled.drawRect(0, 53, OLED_W, 10, SSD1306_WHITE);
  oled.fillRect(2, 55, (int)((OLED_W - 4) * frac), 6, SSD1306_WHITE);
  oled.display();
}

// ---------------------------------------------------------------------------
// Polling the server
// ---------------------------------------------------------------------------

void poll() {
  http.setReuse(true);  // keep the TLS session open between polls
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(tls, String(API_BASE) + "/alert");
  int code = http.GET();
  lastHttpCode = code;
  if (code == 200) {
    JsonDocument doc;
    if (deserializeJson(doc, http.getStream()) == DeserializationError::Ok) {
      lastOkMs = millis();
      lastEar = doc["ear"] | 0.0f;
      lastThreshold = doc["threshold"] | lastThreshold;
      closedFor = doc["closed_for"] | 0.0f;
      drowsyTime = doc["drowsy_time"] | drowsyTime;
      frameAge = doc["last_frame_age"].isNull() ? -1.0f : doc["last_frame_age"].as<float>();
      bool face = doc["face"] | false;
      const char *lv = doc["level"] | "normal";

      Level next;
      if (frameAge < 0 || frameAge > CAMERA_STALE_SEC) next = LVL_NO_CAMERA;
      else if (!strcmp(lv, "critical")) next = LVL_CRITICAL;
      else if (!strcmp(lv, "warning")) next = LVL_WARNING;
      else if (!face) next = LVL_NO_FACE;
      else next = LVL_NORMAL;

      // Mute lasts until the eyes are open again, so the next episode alarms.
      if (next == LVL_NORMAL || monitoringOff(next)) muted = false;
      if (monitoringOff(next) && !monitoringOff(level)) chirpRequest = true;
      level = next;
    }
  } else {
    Serial.printf("[http] %d %s\n", code, http.errorToString(code).c_str());
  }
  http.end();
}

// ---------------------------------------------------------------------------
// Bluetooth Wi-Fi setup (same flow as the ESP32-CAM; see Firmware/README.md)
// ---------------------------------------------------------------------------

String provName, provPin, pendingSsid, pendingPass;
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
      // Held until the board has actually joined. The arrays aren't
      // null-terminated when full.
      char ssid[33] = {0}, pass[65] = {0};
      memcpy(ssid, e->event_info.prov_cred_recv.ssid, 32);
      memcpy(pass, e->event_info.prov_cred_recv.password, 64);
      pendingSsid = ssid;
      pendingPass = pass;
      provFailed = false;
      break;
    }
    case ARDUINO_EVENT_PROV_CRED_FAIL:
      provFailed = true;
      break;
    case ARDUINO_EVENT_PROV_CRED_SUCCESS:
      wifistore::add(pendingSsid, pendingPass);
      provSaved = true;
      break;
    case ARDUINO_EVENT_PROV_END:
      provEnded = true;
      break;
    default:
      break;
  }
}

void runSetupMode() {
  wifistore::disarmDoubleReset();
  uint64_t mac = ESP.getEfuseMac();
  char name[20];
  snprintf(name, sizeof(name), "PROV_C3_%02X%02X%02X",
           (uint8_t)(mac >> 24), (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  provName = name;
  provPin = String(10000000 + esp_random() % 90000000);
  Serial.printf("[setup] Bluetooth setup: name %s, PIN %s\n", provName.c_str(), provPin.c_str());

  WiFi.onEvent(onProvEvent);
  WiFiProv.beginProvision(PROV_SCHEME_BLE, PROV_FREE_BLE, PROV_SECURITY_1,
                          provPin.c_str(), provName.c_str(), nullptr, nullptr, true);

  unsigned long t0 = millis(), lastChirp = 0, savedAt = 0;
  while (true) {
    unsigned long el = millis() - t0;
    drawSetupScreen(el < SETUP_MODE_TIMEOUT_MS ? SETUP_MODE_TIMEOUT_MS - el : 0);
    if (millis() - lastChirp > 5000) { chirpRequest = true; lastChirp = millis(); }
    if (provSaved && !savedAt) savedAt = millis();
    if ((savedAt && millis() - savedAt > 3000) || (provSaved && provEnded)) break;
    if (el > SETUP_MODE_TIMEOUT_MS) break;
    delay(200);
  }
  delay(500);
  ESP.restart();
}

bool connectSavedWifi() {
  WifiCred list[WIFI_STORE_MAX];
  int n = wifistore::load(list);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  for (int i = 0; i < n; i++) {
    Serial.printf("[wifi] trying \"%s\"\n", list[i].ssid.c_str());
    WiFi.begin(list[i].ssid.c_str(), list[i].pass.c_str());
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT_MS) {
      level = LVL_NO_WIFI;
      drawScreen();
      delay(250);
    }
    if (WiFi.status() == WL_CONNECTED) {
      WiFi.setAutoReconnect(true);
      return true;
    }
    WiFi.disconnect();
  }
  return false;
}

void requestSetupOnNextBoot() {
  Preferences p;
  p.begin("boot", false);
  p.putBool("armed", true);
  p.end();
}

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
    ESP.restart();
  } else if (cmd == "setup") {
    requestSetupOnNextBoot();
    ESP.restart();
  }
}

// Button: a short press mutes the current alarm. It comes back by itself
// once the eyes are open again, so the next drowsy episode still alarms.
void handleButton() {
  if (BUTTON_PIN < 0) return;
  static bool wasDown = false;
  static unsigned long downAt = 0;
  bool down = digitalRead(BUTTON_PIN) == LOW;
  if (down && !wasDown) downAt = millis();
  if (!down && wasDown && millis() - downAt > 30) {
    if (level == LVL_WARNING || level == LVL_CRITICAL) muted = true;
  }
  wasDown = down;
}

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  if (VIBRATION_PIN >= 0) pinMode(VIBRATION_PIN, OUTPUT);
  outputs(false);
  if (BUTTON_PIN >= 0) pinMode(BUTTON_PIN, INPUT_PULLUP);
  xTaskCreate(buzzerTask, "buzzer", 2048, nullptr, 2, nullptr);

  Wire.begin(OLED_SDA, OLED_SCL);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) Serial.println("[oled] not found at 0x3C, continuing without display");

  WifiCred tmp[WIFI_STORE_MAX];
  int saved = wifistore::load(tmp);
  if (saved == 0 && strlen(WIFI_SSID) > 0) {
    wifistore::add(WIFI_SSID, WIFI_PASS);
    saved = 1;
  }

  // Setup mode: double-press RST, hold the button while powering on, or no
  // saved network yet.
  bool doubleReset = wifistore::checkDoubleReset();
  bool buttonHeld = BUTTON_PIN >= 0 && digitalRead(BUTTON_PIN) == LOW;
  if (!doubleReset) {
    xTaskCreate([](void *) {
      vTaskDelay(pdMS_TO_TICKS(DOUBLE_RESET_WINDOW_MS));
      wifistore::disarmDoubleReset();
      vTaskDelete(nullptr);
    }, "drd", 3072, nullptr, 1, nullptr);
  }
  if (doubleReset || buttonHeld || saved == 0) runSetupMode();

  esp_bt_controller_mem_release(ESP_BT_MODE_BLE);  // Bluetooth not used in this boot

  tls.setInsecure();  // see the TLS note in Firmware/README.md
  if (!connectSavedWifi()) {
    requestSetupOnNextBoot();
    delay(200);
    ESP.restart();
  }
  level = LVL_NO_SERVER;
  chirpRequest = true;
}

void loop() {
  handleSerial();
  handleButton();

  if (WiFi.status() == WL_CONNECTED && millis() - lastPollMs >= POLL_INTERVAL_MS) {
    lastPollMs = millis();
    poll();
  }

  Level l = level;
  if (WiFi.status() != WL_CONNECTED) {
    if (!monitoringOff(l)) chirpRequest = true;
    level = LVL_NO_WIFI;
  } else if (millis() - lastOkMs > LINK_TIMEOUT_MS && l != LVL_NO_SERVER) {
    if (!monitoringOff(l)) chirpRequest = true;
    level = LVL_NO_SERVER;
  }

  // Keep reminding while nothing is being monitored.
  if (monitoringOff(level) && millis() - lastOffChirpMs > MONITOR_OFF_CHIRP_MS) {
    lastOffChirpMs = millis();
    chirpRequest = true;
  } else if (!monitoringOff(level)) {
    lastOffChirpMs = millis();
  }

  drawScreen();
  delay(10);
}
