"""Record one row per analysed frame to a CSV while a test runs.

Usage:
    python ear_logger.py V01 normal open
    python ear_logger.py V01 lowlight closed --api http://localhost:8000

Phases: open, closed, blink, demo. Press Ctrl+C to stop.
Writes V01_normal_open.csv etc. in the current folder.
Columns: time since start, clock time, EAR, threshold, alert level,
seconds the eyes have been closed, face found, frame number, source device.
"""
import argparse
import csv
import json
import time
import urllib.request

DEFAULT_API = "https://vision-based-drowsiness-detection-using-ear-mediapipe-face-mesh.fly.dev"


def get(api, path):
    with urllib.request.urlopen(api.rstrip("/") + path, timeout=5) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("volunteer", help="e.g. V01")
    ap.add_argument("condition", choices=["normal", "lowlight", "glasses"])
    ap.add_argument("phase", choices=["open", "closed", "blink", "demo"])
    ap.add_argument("--api", default=DEFAULT_API)
    args = ap.parse_args()

    out = f"{args.volunteer}_{args.condition}_{args.phase}.csv"
    last = None
    t0 = time.time()
    n = 0
    first_t = last_t = None
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t_sec", "clock", "ear", "threshold", "level", "closed_for", "face", "frame", "source"])
        print(f"Logging to {out}. Press Ctrl+C to stop.")
        try:
            while True:
                a = get(args.api, "/alert")
                if a["frame"] != last:
                    if last is not None:  # skip the frame already there when we started
                        now = time.time()
                        clock = time.strftime("%H:%M:%S", time.localtime(now)) + f".{int(now % 1 * 1000):03d}"
                        w.writerow([round(now - t0, 3), clock, a["ear"], a["threshold"], a["level"],
                                    a["closed_for"], a["face"], a["frame"], a["source"]])
                        f.flush()
                        n += 1
                        first_t = first_t or now
                        last_t = now
                        print(f"\r{n} frames  EAR {a['ear']:.3f}  {a['level']:<8}", end="", flush=True)
                    last = a["frame"]
                time.sleep(0.05)
        except KeyboardInterrupt:
            pass
    if n > 1:
        fps = (n - 1) / (last_t - first_t)
        print(f"\nSaved {n} frames to {out}, frame rate {fps:.2f} frames/s")
    else:
        print(f"\nSaved {n} frames to {out}")


if __name__ == "__main__":
    main()
