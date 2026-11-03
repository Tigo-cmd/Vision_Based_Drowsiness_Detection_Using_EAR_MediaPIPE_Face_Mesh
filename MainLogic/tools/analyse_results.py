"""Turn the logger CSVs and the trial sheet into the Chapter 4 tables.

Put in one folder:
    V01_normal_open.csv, V01_normal_closed.csv, V01_normal_blink.csv, ...  (from ear_logger.py)
    trials.csv           (filled in by hand, see the testing procedure)
    V01_normal_demo.csv  (optional, for Figure 4.4)

Run:
    python analyse_results.py path/to/folder

Prints Tables 4.1-4.3, the frame rate and blink length, and saves figure_4_4.png.
"""
import csv
import glob
import os
import statistics as st
import sys

CONDITIONS = [("normal", "Normal light"), ("lowlight", "Low light"), ("glasses", "With eyeglasses")]


def read_rows(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def face_ears(rows):
    return [float(r["ear"]) for r in rows if r["face"] == "True"]


def mean_or_none(xs):
    return st.mean(xs) if xs else None


def fmt(x, nd=3):
    return "-" if x is None else f"{x:.{nd}f}"


def per_volunteer_means(folder, condition, phase):
    means = []
    for p in sorted(glob.glob(os.path.join(folder, f"*_{condition}_{phase}.csv"))):
        m = mean_or_none(face_ears(read_rows(p)))
        if m is not None:
            means.append(m)
    return means


def table_4_1(folder):
    print("\nTable 4.1: Average EAR values under different test conditions")
    print("Condition | Mean EAR (eyes open) | Mean EAR (eyes closed) | Difference | Volunteers")
    for key, label in CONDITIONS:
        # Mean per volunteer first, then the mean of those, so each person counts once.
        o = mean_or_none(per_volunteer_means(folder, key, "open"))
        c = mean_or_none(per_volunteer_means(folder, key, "closed"))
        diff = o - c if o is not None and c is not None else None
        print(f"{label} | {fmt(o)} | {fmt(c)} | {fmt(diff)} | {len(per_volunteer_means(folder, key, 'open'))}")


def frame_rate_and_blinks(folder):
    rates, blink_lengths, open_vals = [], [], []
    for p in sorted(glob.glob(os.path.join(folder, "*.csv"))):
        if os.path.basename(p) == "trials.csv":
            continue
        rows = read_rows(p)
        if len(rows) > 1:
            t = [float(r["t_sec"]) for r in rows]
            if t[-1] > t[0]:
                rates.append((len(rows) - 1) / (t[-1] - t[0]))
        if p.endswith("_blink.csv"):
            run = 0
            for r in rows + [None]:
                below = r is not None and r["face"] == "True" and float(r["ear"]) < float(r["threshold"])
                if below:
                    run += 1
                elif run:
                    blink_lengths.append(run)
                    run = 0
        if p.endswith("_open.csv"):
            open_vals += face_ears(rows)

    print("\nFrame rate and blinks")
    if rates:
        fr = st.mean(rates)
        print(f"Average frame rate: {fr:.2f} frames/s (from {len(rates)} recordings)")
        print(f"3.0 s alarm limit = about {3.0 * fr:.1f} frames at this rate")
    if open_vals:
        print(f"EAR with eyes open ranged from {min(open_vals):.3f} to {max(open_vals):.3f}")
    if blink_lengths:
        print(f"Blinks caught below the threshold: {len(blink_lengths)}, lasting "
              f"{min(blink_lengths)} to {max(blink_lengths)} frames (average {st.mean(blink_lengths):.1f})")
    else:
        print("No blink dipped below the threshold in a captured frame (blinks can fall between frames).")


def pct(a, b):
    return None if b == 0 else 100.0 * a / b


def table_4_2_and_4_3(folder):
    path = os.path.join(folder, "trials.csv")
    if not os.path.exists(path):
        print("\n(no trials.csv, skipping Tables 4.2 and 4.3)")
        return
    rows = read_rows(path)

    print("\nTable 4.2: Detection results under different test conditions")
    print("Condition | Trials | TP | TN | FP | FN | Accuracy (%) | Precision (%) | Recall (%)")
    groups = [(label, [r for r in rows if r["condition"] == key]) for key, label in CONDITIONS]
    groups.append(("Overall", rows))
    for label, rs in groups:
        def count(kind, alarm):
            return sum(1 for r in rs if r["trial_type"] == kind and r["alarm"].strip().lower() == alarm)
        tp, fn = count("closure", "yes"), count("closure", "no")
        fp, tn = count("blink", "yes"), count("blink", "no")
        n = tp + tn + fp + fn
        print(f"{label} | {n} | {tp} | {tn} | {fp} | {fn} | {fmt(pct(tp + tn, n), 1)} | "
              f"{fmt(pct(tp, tp + fp), 1)} | {fmt(pct(tp, tp + fn), 1)}")

    print("\nTable 4.3: Response time and Telegram notification delay")
    print("Measure | Minimum (s) | Maximum (s) | Average (s) | Trials timed")
    for col, label in [("closure_to_buzzer_s", "Eye closure to buzzer alarm"),
                       ("buzzer_to_telegram_s", "Buzzer alarm to Telegram message"),
                       ("closure_to_dashboard_s", "Eye closure to dashboard alert")]:
        xs = [float(r[col]) for r in rows if (r.get(col) or "").strip()]
        if xs:
            print(f"{label} | {min(xs):.2f} | {max(xs):.2f} | {st.mean(xs):.2f} | {len(xs)}")
        else:
            print(f"{label} | - | - | - | 0")


def figure_4_4(folder):
    demos = sorted(glob.glob(os.path.join(folder, "*_demo.csv")))
    if not demos:
        print("\n(no *_demo.csv, skipping Figure 4.4)")
        return
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    rows = read_rows(demos[0])
    t0 = float(rows[0]["t_sec"])
    t = [float(r["t_sec"]) - t0 for r in rows]
    ear = [float(r["ear"]) if r["face"] == "True" else float("nan") for r in rows]
    thr = float(rows[0]["threshold"])

    fig, ax = plt.subplots(figsize=(8, 3.5), dpi=200)
    ax.plot(t, ear, color="black", linewidth=1.2, marker=".", markersize=3, label="Average EAR")
    ax.axhline(thr, color="red", linestyle="--", linewidth=1, label=f"Threshold ({thr:.2f})")
    crit = [ti for ti, r in zip(t, rows) if r["level"] == "critical"]
    if crit:
        ax.axvline(crit[0], color="gray", linestyle=":", linewidth=1, label="Alarm raised")
    valid = [e for e in ear if e == e]
    ax.set_ylim(0, max(0.45, (max(valid) if valid else 0) + 0.05))
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("EAR")
    ax.legend(loc="lower left", frameon=False, fontsize=8)
    fig.tight_layout()
    out = os.path.join(folder, "figure_4_4.png")
    fig.savefig(out)
    print(f"\nFigure 4.4 saved to {out} (from {os.path.basename(demos[0])})")


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "."
    table_4_1(folder)
    frame_rate_and_blinks(folder)
    table_4_2_and_4_3(folder)
    figure_4_4(folder)
