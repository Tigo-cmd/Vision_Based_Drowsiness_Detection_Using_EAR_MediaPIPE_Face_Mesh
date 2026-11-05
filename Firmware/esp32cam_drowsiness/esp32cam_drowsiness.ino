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
#include <WebServer.h>
#include <DNSServer.h>

#include "config.h"
#include "wifi_store.h"

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

// 1 = camera test only: no Wi-Fi; type "snap" in the Serial Monitor.
#ifndef BENCH_TEST
#define BENCH_TEST 0
#endif

// 1 = this board drives its own OLED and buzzer (single-board build).
// 0 = a separate ESP32-C3 alert unit does that; this board only sends frames.
#ifndef USE_LOCAL_ALERTS
#define USE_LOCAL_ALERTS 1
#endif
// Password of the setup hotspot when there's no OLED to show a random one.
// Must be at least 8 characters.
#ifndef SETUP_PIN
#define SETUP_PIN "changeme"
#endif
// Small red LED on the back of the board, active low. Used for status when
// there's no OLED: fast blink = Wi-Fi setup, on = sending frames, off = no link.
#define STATUS_LED_PIN 33
void statusLed(bool on);

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
  if (!USE_LOCAL_ALERTS) return;
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

  // QVGA either way: a face close to the dash still fills most of the frame,
  // and the eyes only need to be a few pixels wide for the EAR math. A
  // quarter the pixels of VGA means a quarter the JPEG to encode and upload,
  // and MediaPipe runs noticeably faster on it server-side too.
  if (psramFound()) {
    c.frame_size = FRAMESIZE_QVGA;
    c.jpeg_quality = 16;
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    c.frame_size = FRAMESIZE_QVGA;
    c.jpeg_quality = 18;
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
// Wi-Fi setup mode (hotspot + web page)
//
// The board starts its own Wi-Fi network, DROWSY-CAM-xxxx. Join it from a
// phone or laptop and a setup page opens (or go to http://192.168.4.1). Pick
// your network, type the password, and the board checks it before saving.
//
// Bluetooth isn't used: Bluetooth, Wi-Fi and the camera driver together don't
// fit in the ESP32's IRAM with arduino-esp32 3.x.
//
// Setup runs in its own boot without the camera, and restarts when done.
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
  h += F("<title>Camera Wi-Fi setup</title><style>"
         "body{font-family:sans-serif;max-width:380px;margin:24px auto;padding:0 16px;color:#222}"
         "label{display:block;margin:14px 0 4px}input,select{width:100%;padding:10px;font-size:16px;box-sizing:border-box}"
         "button{margin-top:18px;width:100%;padding:12px;font-size:16px}"
         ".small{font-size:14px;color:#555}</style></head><body>");
  return h + body + "</body></html>";
}

void handleRoot() {
  String b = "<h2>Camera Wi-Fi setup</h2><form method=post action=/save>"
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
        "</b> without testing. The camera is restarting. Turn your hotspot on now.</p>"));
    return;
  }
  Serial.printf("[setup] trying \"%s\"\n", pendingSsid.c_str());
  WiFi.begin(pendingSsid.c_str(), pendingPass.c_str());
  setupState = SETUP_CONNECTING;
  connectStartMs = millis();
  web->send(200, "text/html", page("<h2>Checking&hellip;</h2><p>Trying to join <b>" +
      htmlEscape(pendingSsid) + "</b>. This takes up to 15 seconds.</p>"
      "<p class=small>If your phone drops off the camera's network, join it again and "
      "this page will show the result.</p>", 3));
}

void handleResult() {
  String ssid = htmlEscape(pendingSsid);
  if (setupState == SETUP_CONNECTING)
    web->send(200, "text/html", page("<h2>Checking&hellip;</h2><p>Still trying <b>" + ssid + "</b>.</p>", 3));
  else if (setupState == SETUP_SAVED)
    web->send(200, "text/html", page("<h2>Connected</h2><p>Joined <b>" + ssid +
        "</b> and saved it. The camera is restarting and will start sending frames.</p>"));
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
  snprintf(name, sizeof(name), "DROWSY-CAM-%02X%02X", (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  apName = name;
  // Random 8-digit password when the OLED can show it; otherwise SETUP_PIN from config.h.
  apPass = USE_LOCAL_ALERTS ? String(10000000 + esp_random() % 90000000) : String(SETUP_PIN);
  if (apPass.length() < 8) {
    Serial.println("[setup] SETUP_PIN is shorter than 8 characters; using \"drowsycam\"");
    apPass = "drowsycam";
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
    statusLed((millis() / 150) % 2);
    delay(5);
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
  } else if (cmd == "snap") {
    // Bench check that the camera works, no server needed.
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) {
      Serial.printf("Camera OK: %ux%u JPEG, %u bytes\n", fb->width, fb->height, (unsigned)fb->len);
      esp_camera_fb_return(fb);
    } else {
      Serial.println("Camera FAILED: check the ribbon cable and that PSRAM is enabled");
    }
  } else if (cmd == "setup") {
    Preferences p; p.begin("boot", false); p.putBool("armed", true); p.end();
    ESP.restart();
  }
}

void statusLed(bool on) {
  if (USE_LOCAL_ALERTS) return;
  digitalWrite(STATUS_LED_PIN, on ? LOW : HIGH);
}

void initOled() {
  if (!USE_LOCAL_ALERTS) return;
  // Camera uses its own I2C port for SCCB, so Wire (port 0) is free for the OLED.
  Wire.begin(OLED_SDA, OLED_SCL);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) Serial.println("[oled] not found at 0x3C, continuing without display");
}

void setup() {
  Serial.begin(115200);
  if (USE_LOCAL_ALERTS) pinMode(BUZZER_PIN, OUTPUT);
  else pinMode(STATUS_LED_PIN, OUTPUT);
  statusLed(false);
  buzz(false);
  pinMode(FLASH_LED_PIN, OUTPUT);
  digitalWrite(FLASH_LED_PIN, LOW);
  xTaskCreatePinnedToCore(buzzerTask, "buzzer", 2048, nullptr, 1, nullptr, 0);

  if (BENCH_TEST) {
    bool camOk = initCamera();
    initOled();
    Serial.println(camOk ? "[bench] camera started. Type \"snap\" to take a test frame."
                         : "[bench] camera FAILED to start: check the ribbon cable and PSRAM setting");
    chirpRequest = true;
    return;
  }

  // Credentials from config.h are only a first-boot default; after that, use the setup hotspot.
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
    // None of the saved networks are around. Restart into Wi-Fi setup (a
    // clean boot without the camera running). If nobody uses it,
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
  if (BENCH_TEST) {
    handleSerial();
    statusLed((millis() / 1000) % 2);  // slow blink = bench mode
    delay(10);
    return;
  }

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

  statusLed(!linkDown);
  drawScreen();
  delay(10);
}
