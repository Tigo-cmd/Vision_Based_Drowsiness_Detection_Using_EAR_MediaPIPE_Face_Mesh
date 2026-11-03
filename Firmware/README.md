# ESP32-CAM node

A standalone in-car unit. The ESP32-CAM sends frames to the same backend the
dashboard uses, then shows the result on a small OLED and sounds a buzzer.
Telegram alerts still come from the backend, so the photo in Telegram is the
ESP32's view and the caption names the device.

```
ESP32-CAM ──JPEG──▶ /detect (fly.dev) ──▶ Telegram
    ▲                     │
    └── level, EAR ◀──────┘
    │
    ├── OLED: state, EAR, eyes-closed bar
    └── Buzzer: slow beeps = warning, fast beeps = critical
```

The thresholds (EAR threshold, alert duration, cooldown) come from the
dashboard's Settings panel. Change them there and the ESP32 picks them up on
its next frame.

## Parts

| Part | Notes |
|---|---|
| AI-Thinker ESP32-CAM (OV2640) | with PSRAM (most are) |
| ESP32-CAM-MB USB board or FTDI adapter (3.3 V) | for flashing |
| 0.96" SSD1306 OLED, I2C, 128×64 | address 0x3C |
| 5 V active buzzer | an active buzzer beeps on its own when powered; a passive one won't |
| NPN transistor (S8050 / 2N2222) + 1 kΩ resistor | the GPIO can't drive a buzzer directly |
| 5 V 2 A supply | a weak supply causes brownout resets when Wi-Fi starts |

## Wiring

| ESP32-CAM pin | Goes to |
|---|---|
| 3V3 | OLED VCC |
| 5V | buzzer + |
| GND | OLED GND, transistor emitter |
| GPIO 15 | OLED SDA |
| GPIO 14 | OLED SCL |
| GPIO 13 | 1 kΩ → transistor base |
| — | transistor collector → buzzer − |

Power the OLED from 3V3, not 5V: most OLED modules pull SDA and SCL up to
their own supply, and 5 V on those lines is too much for the ESP32's pins.

If you use a 3-pin buzzer module (VCC, GND, I/O) instead of a bare buzzer and
transistor, wire I/O straight to GPIO 13. If it beeps when it should be quiet,
set `BUZZER_ACTIVE_HIGH` to 0 in `config.h`.

GPIO 13/14/15 are the SD card pins, so don't put a card in. Leave GPIO 12
alone: it's a boot pin and the board may not boot if something pulls it high.

## Flashing

1. Arduino IDE → Boards Manager → install **esp32 by Espressif** (2.0.x or 3.x).
2. Library Manager → install **Adafruit SSD1306**, **Adafruit GFX Library**, **ArduinoJson** (v7).
3. Copy `esp32cam_drowsiness/config.example.h` to `config.h` and set `DEVICE_ID`. Wi-Fi can stay empty; you'll set it over Bluetooth.
4. Tools → Board: **AI Thinker ESP32-CAM**, Partition scheme: **Huge APP (3MB No OTA)**, PSRAM: **Enabled**. Bluetooth makes the firmware too big for the default partition.
5. Upload. With an FTDI adapter, hold GPIO 0 to GND while resetting to enter flash mode, then remove it and reset again to run.
6. Open Serial Monitor at 115200 to see Wi-Fi and HTTP status.

## Setting or changing Wi-Fi over Bluetooth

No laptop or reflashing needed. Install **ESP BLE Provisioning** (Espressif,
free, Android and iOS).

1. Put the unit in setup mode: **press RST twice within 4 seconds**. It also
   goes into setup on its own the first time, or when none of its saved
   networks can be reached.
2. The OLED shows `BLUETOOTH SETUP`, a name like `PROV_A1B2C3` and an 8-digit
   PIN. The buzzer double-chirps every few seconds while it's in setup.
3. In the app: Provision New Device → *I don't have a QR code* → pick the
   `PROV_…` name → enter the PIN → choose your network and type the password.
4. The unit tries the network before saving it. A wrong password shows in the
   app and on the OLED and isn't saved, so you can try again.
5. On success it restarts and starts monitoring.

It remembers **3 networks** (say, phone hotspot, home and work) and tries the
most recently added first. Re-adding a network with a new password replaces
the old one. Setup mode gives up after 5 minutes and goes back to trying the
saved networks, so a hotspot switched on after the car starts still gets
picked up.

Bluetooth is only on in setup mode. In normal mode it's switched off and its
memory goes to the camera and TLS, and nobody can change the Wi-Fi while
you're driving.

Over USB serial (115200) you can also type `wifi list`, `wifi clear` or `setup`.

## What the OLED shows

| Screen | Meaning |
|---|---|
| `ALERT` | face found, eyes open |
| `WARNING` | eyes closed for half the alert duration, slow beeps |
| `WAKE UP` (inverted) | eyes closed for the full alert duration, fast beeps, Telegram sent |
| `NO FACE` | camera can't see a face; check angle and lighting |
| `NO SERVER` | no answer from the backend for 6 s; two short chirps when it happens |
| `NO WIFI` | not connected |
| `BLUETOOTH SETUP` | waiting for the phone app; not monitoring |

The bar along the bottom fills as the eyes stay closed and is full at the
critical alert.

## Two-board build: ESP32-C3 alert unit

Instead of wiring the OLED and buzzer to the ESP32-CAM, you can put them on
an ESP32-C3. The camera then only sends frames, which makes it less prone to
brownouts and frees its pins. The C3 asks the server for the alert state
four times a second, so the two boards need no wires between them.

```
ESP32-CAM ──frames──▶ server ◀──"what's the state?" every 250 ms── ESP32-C3
                         │                                           ├── OLED
                         └──▶ Telegram                               ├── buzzer
                                                                     └── vibration motor (optional)
```

Because the C3 asks the server, it also notices when the camera stops
sending. It shows `NO CAMERA` and chirps every 30 s until frames come back.

**Wiring (ESP32-C3 SuperMini)**

| C3 pin | Goes to |
|---|---|
| 3V3 | OLED VCC |
| 5V | buzzer + (and motor +) |
| GND | OLED GND, transistor emitters, button |
| GPIO 8 | OLED SDA |
| GPIO 9 | OLED SCL |
| GPIO 4 | 1 kΩ → transistor base, collector → buzzer − |
| GPIO 5 | 1 kΩ → second transistor → vibration motor − (optional; add a diode across the motor) |
| GPIO 3 | push button to GND (optional) |

The SuperMini's on-board LED shares GPIO 8 and will flicker with the OLED.
That's harmless.

**Setting up**

1. Flash the ESP32-CAM with `USE_LOCAL_ALERTS 0` and your own `SETUP_PIN` in
   its `config.h`. With no screen, its red LED on the back shows status: fast
   blink = Bluetooth setup, on = sending frames, off = no link. Its
   Bluetooth PIN is the `SETUP_PIN` you chose.
2. Copy `c3_alert_unit/config.example.h` to `config.h`. Check the pins.
3. Arduino IDE: Board **ESP32C3 Dev Module**, USB CDC On Boot **Enabled**,
   Partition scheme **Huge APP (3MB No OTA)**. Upload `c3_alert_unit`.
4. Set the C3's Wi-Fi the same way as the camera: it appears in the app as
   `PROV_C3_…` with a PIN on its OLED. To re-enter setup, double-press RST or
   hold the button while plugging it in.

**The button.** A short press during `WARNING` or `WAKE UP` silences the
buzzer and motor. The mute ends by itself once the eyes are open again, so
the next drowsy episode alarms as normal.

**C3 screens**, in addition to the ones above:

| Screen | Meaning |
|---|---|
| `NO CAMERA` | server has had no frame for 5 s; monitoring is off |
| `MUTED` (top right) | alarm silenced with the button |

## Things to know

- **Latency.** Each frame goes over TLS to fly.dev and back, usually 300–800 ms.
  The alert duration is measured in seconds on the server, so a slower link
  delays the alarm a little but doesn't change the threshold.
- **Cold starts.** The fly.io machine stops when idle, and the first request
  can take several seconds. The unit shows `NO SERVER` until it wakes.
- **One camera at a time.** The backend keeps one alert state. Running the
  browser camera and the ESP32 together mixes their frames, so use one or the
  other.
- **Night.** The OV2640 has no IR filter removal. `USE_FLASH_LED` lights the
  on-board LED, but it is too bright to drive with. An IR LED ring with an
  IR-sensitive camera module is the proper fix.
- **TLS.** The sketch uses `setInsecure()`, which skips checking the server
  certificate. To check it, pass the root CA to `tls.setCACert()`.
