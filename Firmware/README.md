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
| 5V | OLED VCC (or 3V3), buzzer + |
| GND | OLED GND, transistor emitter |
| GPIO 15 | OLED SDA |
| GPIO 14 | OLED SCL |
| GPIO 13 | 1 kΩ → transistor base |
| — | transistor collector → buzzer − |

GPIO 13/14/15 are the SD card pins, so don't put a card in. Leave GPIO 12
alone: it's a boot pin and the board may not boot if something pulls it high.

## Flashing

1. Arduino IDE → Boards Manager → install **esp32 by Espressif** (2.0.x or 3.x).
2. Library Manager → install **Adafruit SSD1306**, **Adafruit GFX Library**, **ArduinoJson** (v7).
3. Copy `esp32cam_drowsiness/config.example.h` to `config.h` and fill in Wi-Fi and `DEVICE_ID`.
4. Tools → Board: **AI Thinker ESP32-CAM**, Partition scheme: **Huge APP**, PSRAM: **Enabled**.
5. Upload. With an FTDI adapter, hold GPIO 0 to GND while resetting to enter flash mode, then remove it and reset again to run.
6. Open Serial Monitor at 115200 to see Wi-Fi and HTTP status.

## What the OLED shows

| Screen | Meaning |
|---|---|
| `ALERT` | face found, eyes open |
| `WARNING` | eyes closed for half the alert duration, slow beeps |
| `WAKE UP` (inverted) | eyes closed for the full alert duration, fast beeps, Telegram sent |
| `NO FACE` | camera can't see a face; check angle and lighting |
| `NO SERVER` | no answer from the backend for 6 s; two short chirps when it happens |
| `NO WIFI` | not connected |

The bar along the bottom fills as the eyes stay closed and is full at the
critical alert.

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
