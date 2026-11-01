# MeterBots: a small Flask service and a Telegram client. No camera, no
# OpenCV -- MeterCam (LXC 104) does the reading; this only files it.

FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Requirements first, so the layer cache survives every edit to the service.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY service/ ./service/
# The suite ships too, so it runs against exactly what is deployed:
#   docker exec meterbots python tests/test_gasbot.py
COPY tests/ ./tests/

ENV PYTHONUNBUFFERED=1

EXPOSE 8770

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD curl -fsS http://localhost:8770/health || exit 1

# Two threads: tgclient.LOCK runs one bot conversation at a time anyway, and
# the second thread keeps /health answering while a conversation (up to a
# minute) holds the first.
CMD ["python", "-m", "waitress", "--host=0.0.0.0", "--port=8770", \
     "--threads=2", "--call", "service.app:create_app"]
