FROM python:3.12.13 AS builder

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Create virtualenv and install Python deps
RUN python -m venv .venv
COPY requirements.txt ./
RUN .venv/bin/pip install --no-cache-dir -r requirements.txt

# -------------------

FROM python:3.12.13-slim

WORKDIR /app

# System libs for OpenCV; libegl1/libgles2 are needed by newer MediaPipe wheels
RUN apt-get update && apt-get install -y \
    libgl1 \
    libegl1 \
    libgles2 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# Copy the venv and app code
COPY --from=builder /app/.venv .venv/
COPY . .

# Expose Flask port
EXPOSE 8080

# One worker on purpose: the alert state lives in memory, so every request
# (camera, alert unit, dashboard) must reach the same process. Threads let
# them run at the same time.
CMD ["/app/.venv/bin/gunicorn", "--workers", "1", "--threads", "8", "--timeout", "60", \
     "--bind", "0.0.0.0:8080", "--access-logfile", "-", "app:app"]
