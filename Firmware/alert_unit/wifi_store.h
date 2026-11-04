// Saved Wi-Fi networks and the double-reset trigger, both kept in NVS flash.
#pragma once

#include <Arduino.h>
#include <Preferences.h>

#define WIFI_STORE_MAX 3  // e.g. phone hotspot, home, work

struct WifiCred {
  String ssid;
  String pass;
};

namespace wifistore {

inline int load(WifiCred out[WIFI_STORE_MAX]) {
  Preferences p;
  p.begin("wifi", true);
  int n = p.getUChar("n", 0);
  if (n > WIFI_STORE_MAX) n = WIFI_STORE_MAX;
  for (int i = 0; i < n; i++) {
    char k[12];
    snprintf(k, sizeof(k), "s%d", i); out[i].ssid = p.getString(k, "");
    snprintf(k, sizeof(k), "p%d", i); out[i].pass = p.getString(k, "");
  }
  p.end();
  return n;
}

inline void saveAll(const WifiCred list[], int n) {
  Preferences p;
  p.begin("wifi", false);
  p.clear();
  p.putUChar("n", n);
  for (int i = 0; i < n; i++) {
    char k[12];
    snprintf(k, sizeof(k), "s%d", i); p.putString(k, list[i].ssid);
    snprintf(k, sizeof(k), "p%d", i); p.putString(k, list[i].pass);
  }
  p.end();
}

// Puts the network first (most recently set = tried first). An existing entry with
// the same SSID is replaced, which is how a changed password gets updated.
inline void add(const String &ssid, const String &pass) {
  WifiCred list[WIFI_STORE_MAX];
  int n = load(list);
  WifiCred out[WIFI_STORE_MAX];
  int m = 0;
  out[m++] = {ssid, pass};
  for (int i = 0; i < n && m < WIFI_STORE_MAX; i++) {
    if (list[i].ssid != ssid) out[m++] = list[i];
  }
  saveAll(out, m);
}

inline void clear() {
  Preferences p;
  p.begin("wifi", false);
  p.clear();
  p.end();
}

// ---- Double reset: press RST twice within a few seconds to enter setup ----
// The ESP32-CAM has no spare button (GPIO 0 is the camera clock), and RTC memory
// doesn't survive the RST button, so a flag in NVS marks "booted recently".
inline bool checkDoubleReset() {
  Preferences p;
  p.begin("boot", false);
  bool armed = p.getBool("armed", false);
  p.putBool("armed", !armed);  // a third press after setup starts is a normal boot again
  p.end();
  return armed;
}

inline void disarmDoubleReset() {
  Preferences p;
  p.begin("boot", false);
  p.putBool("armed", false);
  p.end();
}

}  // namespace wifistore
