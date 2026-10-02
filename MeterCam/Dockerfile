# One image, two places: built and iterated on the Windows workstation, then the
# identical compose file runs it in the LXC at <metercam-ip>. That is the same
# arrangement PowerStation/ uses for ESPHome, and for the same reason -- what
# gets debugged is what gets deployed.

FROM python:3.12-slim

# opencv-python-headless drops the GUI bindings but still links libglib. Without
# it the import fails at runtime with a bare "libgthread-2.0.so.0: cannot open
# shared object file", which looks like a Python problem and is not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Requirements first: the layer cache then survives every edit to the service,
# and re-installing opencv and the tflite runtime is most of the build time.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY service/ ./service/

# The suite's vision sections need OpenCV, which exists only in here, so a
# suite that cannot run in the image is one that never runs against what is
# actually deployed:  docker compose exec metercam python tests/test_reader.py
COPY tests/ ./tests/

ENV METERCAM_CONFIG=/config/config.json \
    METERCAM_IMAGES=/data/images \
    METERCAM_PORT=8770 \
    PYTHONUNBUFFERED=1

EXPOSE 8770

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD curl -fsS http://localhost:8770/health || exit 1

# waitress rather than flask's dev server: it is a real WSGI server, it is pure
# Python, and it does not print a warning on every start telling you not to use
# it. Two threads because app.py holds one lock around the reader -- more would
# only queue deeper.
CMD ["python", "-m", "waitress", "--host=0.0.0.0", "--port=8770", \
     "--threads=2", "--call", "service.app:create_app"]
