# ── Stage 1: Builder ──────────────────────────────────────────────
FROM python:3.14-slim AS builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies into a prefix we can copy cleanly
COPY requirements.txt .
RUN pip install --prefix=/install --no-cache-dir -r requirements.txt


# ── Stage 2: Runtime ──────────────────────────────────────────────
FROM python:3.14-slim

WORKDIR /app

# Runtime system deps:
#   libpq5   — asyncpg / psycopg2
#   espeak   — offline TTS engine (optional; gTTS is the default)
#   ffmpeg   — audio conversion (mp3→wav for gTTS, resampling for eSpeak)
#
# Note: pyVoIP is pure Python — no native SIP libraries needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    espeak \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application source
COPY app/     ./app/
COPY web/     ./web/

# Non-root user for security
RUN addgroup --system routario && adduser --system --ingroup routario routario
RUN chown -R routario:routario /app
USER routario

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

CMD ["python", "app/main.py"]