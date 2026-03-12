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

# Install system dependencies for OpenCV
RUN apt-get update && apt-get install -y \
    libgl1 \
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

# Run Flask
CMD ["/app/.venv/bin/flask", "run", "--host=0.0.0.0", "--port=8080"]
