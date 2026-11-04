/*
  Alert unit (ESP32-C3, or an ESP32-CAM board with no camera fitted)

  The camera board only captures frames and sends them to the server. This board
  asks the server for the alert state a few times a second and drives the
  OLED, the buzzer and an optional vibration motor from it.

  Because it asks the server rather than the camera, it also notices when the
  camera stops sending and warns that monitoring is off.

  Board: pick "ESP32C3 Dev Module" for a C3, or "AI Thinker ESP32-CAM" for an
  ESP32-CAM board. The right pins are chosen from that in config.h.

  Bench test without the server: type "demo" in the Serial Monitor (115200).
  The unit runs ALERT -> WARNING -> WAKE UP -> ALERT so you can check the
  OLED, buzzer and motor wiring.
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
#include <WebServer.h>
#include <DNSServer.h>

#include "config.h"
#include "wifi_store.h"

#ifndef SETUP_PIN
#define SETUP_PIN "changeme"  // setup hotspot password if there's no OLED to show one
#endif

#define DOUBLE_RESET_WINDOW_MS 4000

// 1 = wiring test only: no Wi-Fi, the demo sequence repeats forever.
#ifndef BENCH_TEST
#define BENCH_TEST 0
#endif

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

// Bench test: while demoUntil is in the future, the unit plays a fixed
// sequence instead of using the server.
unsigned long demoStart = 0, demoUntil = 0;
bool inDemo() { return millis() < demoUntil; }

void runDemoStep() {
  unsigned long t = millis() - demoStart;
  drowsyTime = 3;
  lastThreshold = 0.20;
  if (t < 3000)       { level = LVL_NORMAL;   lastEar = 0.30; closedFor = 0; }
  else if (t < 4500)  { level = LVL_NORMAL;   lastEar = 0.12; closedFor = (t - 3000) / 1000.0; }
  else if (t < 6000)  { level = LVL_WARNING;  lastEar = 0.12; closedFor = (t - 3000) / 1000.0; }
  else if (t < 10000) { level = LVL_CRITICAL; lastEar = 0.12; closedFor = 3; }
  else                { level = LVL_NORMAL;   lastEar = 0.30; closedFor = 0; }
}

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
// Wi-Fi setup mode (hotspot + web page)
//
// The board starts its own Wi-Fi network, DROWSY-ALERT-xxxx. Join it from a
// phone or laptop and a setup page opens (or go to http://192.168.4.1). Pick
// your network, type the password, and the board checks it before saving.
// Same setup as the camera board, so both work the same way.
// ---------------------------------------------------------------------------

String apName, apPass, optionsHtml;
String pendingSsid, pendingPass;
enum SetupState { SETUP_IDLE, SETUP_CONNECTING, SETUP_SAVED, SETUP_FAILED };
volatile SetupState setupState = SETUP_IDLE;
unsigned long connectStartMs = 0, savedAtMs = 0;
WebServer *web = nullptr;

void drawSetupScreen(unsigned long msLeft) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print("WIFI SETUP");
  oled.drawFastHLine(0, 10, OLED_W, SSD1306_WHITE);
  oled.setCursor(0, 14);
  oled.print("Join ");
  oled.print(apName);
  oled.setCursor(0, 25);
  oled.print("Pass ");
  oled.print(apPass);
  oled.setCursor(0, 36);
  oled.print("Open 192.168.4.1");
  oled.setCursor(0, 47);
  if (setupState == SETUP_CONNECTING) oled.print("Checking...");
  else if (setupState == SETUP_FAILED) oled.print("Failed. Retry");
  else if (setupState == SETUP_SAVED) oled.print("Saved. Restarting");
  oled.setCursor(0, 56);
  oled.printf("Exits in %lus", msLeft / 1000);
  oled.display();
}

String htmlEscape(const String &in) {
  String out;
  for (unsigned int i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '&') out += "&amp;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

String page(const String &body, int refreshSec = 0) {
  String h = F("<!doctype html><html><head><meta charset=utf-8>"
               "<meta name=viewport content='width=device-width,initial-scale=1'>");
  if (refreshSec) h += "<meta http-equiv=refresh content='" + String(refreshSec) + ";url=/result'>";
  h += F("<title>Alert unit Wi-Fi setup</title><style>"
         "body{font-family:sans-serif;max-width:380px;margin:24px auto;padding:0 16px;color:#222}"
         "label{display:block;margin:14px 0 4px}input,select{width:100%;padding:10px;font-size:16px;box-sizing:border-box}"
         "button{margin-top:18px;width:100%;padding:12px;font-size:16px}"
         ".small{font-size:14px;color:#555}</style></head><body>");
  return h + body + "</body></html>";
}

void handleRoot() {
  String b = "<h2>Alert unit Wi-Fi setup</h2><form method=post action=/save>"
             "<label>Network</label><input name=ssid list=nets required autocomplete=off>"
             "<datalist id=nets>" + optionsHtml + "</datalist>"
             "<label>Password</label><input name=pass type=password>"
             "<label class=small><input type=checkbox name=skip style='width:auto'> "
             "Save without testing (tick this if the network is this phone's own hotspot)</label>"
             "<button>Save</button></form>";
  web->send(200, "text/html", page(b));
}

void handleSave() {
  pendingSsid = web->arg("ssid");
  pendingPass = web->arg("pass");
  pendingSsid.trim();
  if (pendingSsid.isEmpty()) {
    web->sendHeader("Location", "/");
    web->send(302);
    return;
  }
  if (web->hasArg("skip")) {
    wifistore::add(pendingSsid, pendingPass);
    setupState = SETUP_SAVED;
    savedAtMs = millis();
    web->send(200, "text/html", page("<h2>Saved</h2><p>Saved <b>" + htmlEscape(pendingSsid) +
        "</b> without testing. The alert unit is restarting. Turn your hotspot on now.</p>"));
    return;
  }
  Serial.printf("[setup] trying \"%s\"\n", pendingSsid.c_str());
  WiFi.begin(pendingSsid.c_str(), pendingPass.c_str());
  setupState = SETUP_CONNECTING;
  connectStartMs = millis();
  web->send(200, "text/html", page("<h2>Checking&hellip;</h2><p>Trying to join <b>" +
      htmlEscape(pendingSsid) + "</b>. This takes up to 15 seconds.</p>"
      "<p class=small>If your phone drops off the alert unit's network, join it again and "
      "this page will show the result.</p>", 3));
}

void handleResult() {
  String ssid = htmlEscape(pendingSsid);
  if (setupState == SETUP_CONNECTING)
    web->send(200, "text/html", page("<h2>Checking&hellip;</h2><p>Still trying <b>" + ssid + "</b>.</p>", 3));
  else if (setupState == SETUP_SAVED)
    web->send(200, "text/html", page("<h2>Connected</h2><p>Joined <b>" + ssid +
        "</b> and saved it. The alert unit is restarting.</p>"));
  else if (setupState == SETUP_FAILED)
    web->send(200, "text/html", page("<h2>Couldn't connect</h2><p>Could not join <b>" + ssid +
        "</b>. Check the password and that the network is on.</p><p><a href=/>Try again</a></p>"));
  else {
    web->sendHeader("Location", "/");
    web->send(302);
  }
}

void runSetupMode() {
  wifistore::disarmDoubleReset();  // so a reset from here is a normal boot
  uint64_t mac = ESP.getEfuseMac();
  char name[24];
  snprintf(name, sizeof(name), "DROWSY-ALERT-%02X%02X", (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  apName = name;
  // Random 8-digit password when the OLED can show it; otherwise SETUP_PIN from config.h.
  apPass = oledOk ? String(10000000 + esp_random() % 90000000) : String(SETUP_PIN);
  if (apPass.length() < 8) {
    Serial.println("[setup] SETUP_PIN is shorter than 8 characters; using \"drowsyalert\"");
    apPass = "drowsyalert";
  }

  // List nearby networks for the form before starting the hotspot.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n && i < 20; i++) {
    optionsHtml += "<option value=\"" + htmlEscape(WiFi.SSID(i)) + "\">";
  }
  WiFi.scanDelete();

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), apPass.c_str());
  delay(100);
  IPAddress ip = WiFi.softAPIP();
  Serial.printf("[setup] hotspot %s, password %s, open http://%s\n",
                apName.c_str(), apPass.c_str(), ip.toString().c_str());

  DNSServer dns;
  dns.start(53, "*", ip);  // every name points here, so phones show the page
  WebServer server(80);
  web = &server;
  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/result", HTTP_GET, handleResult);
  server.onNotFound([]() {
    web->sendHeader("Location", "http://192.168.4.1/");
    web->send(302);
  });
  server.begin();

  unsigned long t0 = millis(), lastChirp = 0;
  while (true) {
    dns.processNextRequest();
    server.handleClient();

    if (setupState == SETUP_CONNECTING) {
      if (WiFi.status() == WL_CONNECTED) {
        wifistore::add(pendingSsid, pendingPass);
        Serial.println("[setup] joined, network saved");
        setupState = SETUP_SAVED;
        savedAtMs = millis();
      } else if (millis() - connectStartMs > 15000) {
        Serial.println("[setup] could not join, wrong password or out of range");
        WiFi.disconnect();  // station only; the hotspot stays up
        setupState = SETUP_FAILED;
      }
    }
    // Give the page time to show the result before restarting.
    if (setupState == SETUP_SAVED && millis() - savedAtMs > 8000) break;

    unsigned long el = millis() - t0;
    if (el > SETUP_MODE_TIMEOUT_MS && setupState != SETUP_CONNECTING) {
      Serial.println("[setup] timed out");
      break;
    }
    static unsigned long lastDraw = 0;
    if (millis() - lastDraw > 250) {
      lastDraw = millis();
      drawSetupScreen(el < SETUP_MODE_TIMEOUT_MS ? SETUP_MODE_TIMEOUT_MS - el : 0);
    }
    if (millis() - lastChirp > 5000) { chirpRequest = true; lastChirp = millis(); }
    delay(5);
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
  } else if (cmd == "demo") {
    Serial.println("Demo: ALERT 3 s, eyes closing, WARNING, WAKE UP 4 s, ALERT");
    muted = false;
    demoStart = millis();
    demoUntil = demoStart + 12000;
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
#if !CONFIG_IDF_TARGET_ESP32C3
  // ESP32-CAM board: keep the bright flash LED (GPIO 4) off.
  pinMode(4, OUTPUT);
  digitalWrite(4, LOW);
#endif

  Wire.begin(OLED_SDA, OLED_SCL);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) Serial.println("[oled] not found at 0x3C, continuing without display");

  if (BENCH_TEST) {
    Serial.println("[bench] BENCH_TEST is on: no Wi-Fi, repeating the demo");
    return;
  }

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

  if (BENCH_TEST && !inDemo()) {
    delay(2000);  // short gap of silence between runs
    muted = false;
    demoStart = millis();
    demoUntil = demoStart + 12000;
  }
  if (inDemo()) {
    runDemoStep();
    drawScreen();
    delay(10);
    return;
  }

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
