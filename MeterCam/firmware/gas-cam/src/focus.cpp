/*
 * MeterCam's gas meter camera, bench firmware: one photograph, on demand.
 *
 * This is the half you hold at the meter. src/main.cpp is the half that lives
 * in the cupboard; flash that back when the screwdriver is down.
 *
 * WHY THERE IS NO STREAM HERE ANY MORE
 *
 * There was one, and this board cannot carry it. Measured on 2026-09-20 with
 * the /speed endpoint below, at 20 cm, associated at 150 Mbps and 100% signal:
 *
 *     sensor powered down      24 KB/s, steady
 *     sensor powered up         1-2 KB/s, stalling
 *
 * A working ESP32 does 1-3 MB/s, so 24 KB/s is already two orders of
 * magnitude down and the radio wants looking at -- but even taking it as
 * given, the shape of that pair decides the whole design. Video needs many
 * frames a second and this link will not carry one. A single photograph needs
 * one frame and about fifteen seconds, and for aiming a camera and turning a
 * lens that is enough.
 *
 * So: the sensor is OFF whenever a photograph is not being taken. /photo
 * powers it up, lights the meter, takes one full-resolution frame, copies the
 * JPEG out of the frame buffer, powers the sensor back down -- and only then
 * sends the bytes, over a radio that now has the rail to itself. That reorder
 * is worth roughly twenty times the transfer speed on this board, and it is
 * the only reason a UXGA photograph arrives in seconds rather than minutes.
 *
 * It also means this firmware is cool enough to leave running, which the
 * streaming one was not.
 *
 * WHAT MeterCam WANTS FROM IT
 *
 * The service's old pull path, unchanged, so nothing on the far end had to be
 * written for this: `snapshot_url` fetches a JPEG, `torch_on_url` and
 * `torch_off_url` work the lights, `prepare_urls` are re-asserted before every
 * shot. Point config.json's camera block at this board and
 * GET /capture?meter=gas on the container is the user's entry point, exactly
 * as it was for the phone.
 *
 *     snapshot_url    http://<board>/photo
 *     torch_on_url    http://<board>/ctrl?led=160
 *     torch_off_url   http://<board>/ctrl?led=0
 *
 * /photo lights the meter by itself for the duration of the shot, so the
 * torch URLs are optional -- they are there for holding the lights on while
 * somebody looks, and for finding the brightness in the first place.
 *
 * WHICH WAY TO TURN THE LENS
 *
 * Counter-clockwise, seen from the front, unscrews the barrel and moves it
 * away from the sensor, which brings the focal plane closer to the camera.
 * Clockwise goes back toward infinity. Eighth-turns, one photograph between
 * each -- the whole usable range is well under one turn, and past it the
 * barrel leaves the thread and the sensor eats the dust.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <esp_camera.h>
#include <esp_http_server.h>
#include <esp_sleep.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <lwip/sockets.h>

#include "board.h"
#include "config.h"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

static httpd_handle_t server = nullptr;

// One sensor, and a server that can be asked for two things at once.
static SemaphoreHandle_t camLock = nullptr;

static volatile uint32_t lastBytes = 0;    // the newest photograph
static volatile uint32_t peakBytes = 0;    // the best since the last reset
static volatile uint32_t photoCount = 0;
static volatile uint32_t lastShotMs = 0;   // how long the last capture took
static volatile uint32_t lastSendMs = 0;   // and how long it took to go out
static volatile uint32_t lastAdapt = 0;    // frames thrown away letting AE settle
static volatile bool cameraUpNow = false;
static char lastError[96] = "";

// The level a photograph is taken at, and what the page's slider sets. It
// starts at the compiled-in default so an unattended MeterCam poll gets a lit
// frame without anyone having touched anything.
//
// It is NOT what the LED sits at between photographs -- that is always off.
// Setting it via /ctrl also lights the LED there and then, so you can see what
// you are choosing; the next photograph turns it off again on the way out.
static uint8_t ledLevel = LED_BRIGHTNESS;

// 4 KB, the size src/main.cpp settled on for the same reason: handing the
// server a whole JPEG in one call makes it sit on a socket whose send buffer
// is a few KB, and a send that outlasts send_wait_timeout gets the socket
// closed mid-frame.
static const size_t WIRE_CHUNK = 4096;

// ---------------------------------------------------------------------------
// The lights
// ---------------------------------------------------------------------------
//
// The same two off-axis LEDs the production firmware uses, on the same
// channels, because the brightness settled on here is the LED_BRIGHTNESS that
// gets written into config.h -- and a number found under different light than
// the one it is used in is not worth finding.

static void lightsBegin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(LED_LEFT_PIN, 2000, 8);
  ledcAttach(LED_RIGHT_PIN, 2000, 8);
#else
  ledcSetup(0, 2000, 8);
  ledcSetup(1, 2000, 8);
  ledcAttachPin(LED_LEFT_PIN, 0);
  ledcAttachPin(LED_RIGHT_PIN, 1);
#endif
}

static void lights(uint8_t level) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(LED_LEFT_PIN, level);
  ledcWrite(LED_RIGHT_PIN, level);
#else
  ledcWrite(0, level);
  ledcWrite(1, level);
#endif
}

// ---------------------------------------------------------------------------
// The sensor, up only when it is wanted
// ---------------------------------------------------------------------------

static bool cameraUp(int quality) {
  if (cameraUpNow) return true;

  digitalWrite(PWDN_GPIO_NUM, LOW);
  // The sensor needs longer to come back than it looks. At 20 ms the SCCB
  // probe fails roughly one power-cycle in three -- which, because this
  // firmware powers it down after every photograph, is one photo in three.
  delay(120);

  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_2;  // 0 and 1 are the lights
  cfg.ledc_timer = LEDC_TIMER_1;
  cfg.pin_d0 = Y2_GPIO_NUM;
  cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM;
  cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM;
  cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM;
  cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk = XCLK_GPIO_NUM;
  cfg.pin_pclk = PCLK_GPIO_NUM;
  cfg.pin_vsync = VSYNC_GPIO_NUM;
  cfg.pin_href = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn = PWDN_GPIO_NUM;
  cfg.pin_reset = RESET_GPIO_NUM;
  // 20 MHz, matching production. The sensor is only clocked while a shot is
  // being taken now, so the draw it adds no longer sits on top of a transfer.
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;

  // UXGA is the point of the exercise: eight drums, three of them white on
  // red, have to survive being cropped to eight little rectangles.
  cfg.frame_size = FRAMESIZE_UXGA;
  cfg.jpeg_quality = quality;         // 0-63, LOWER IS BETTER
  // Two buffers, matching production, and not an optimisation. With one, a
  // get/return/get cycle has nowhere to put the next frame while the driver
  // hands back the current one, and the second get returns NULL -- which made
  // the exposure warm-up below stop after a single frame and report it. The
  // spare buffer is a couple of hundred KB of a spare four megabytes.
  cfg.fb_count = 2;
  cfg.fb_location = CAMERA_FB_IN_PSRAM;
  cfg.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    snprintf(lastError, sizeof(lastError),
             err == ESP_ERR_NOT_SUPPORTED
                 ? "sensor did not answer (0x%x) -- reseat the ribbon"
                 : "camera init failed (0x%x)",
             err);
    Serial.printf("cameraUp: %s\n", lastError);
    digitalWrite(PWDN_GPIO_NUM, HIGH);
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    // Production's settings exactly. Focusing under a different sensor
    // configuration than the one that will read the meter is how you get a
    // lens that was sharp on the bench and soft in the cupboard.
    s->set_whitebal(s, 1);
    s->set_gain_ctrl(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_hmirror(s, 0);
    s->set_vflip(s, 0);
  }
  cameraUpNow = true;
  return true;
}

static void cameraDown() {
  if (!cameraUpNow) return;
  esp_camera_deinit();
  digitalWrite(PWDN_GPIO_NUM, HIGH);   // off, not idle: this is the whole trick
  cameraUpNow = false;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

// Turn Nagle off for this response's socket. esp_http_server gives no way to
// set it on the listener, so it is set per request on the fd behind it.
static void noDelay(httpd_req_t *req) {
  int fd = httpd_req_to_sockfd(req);
  if (fd < 0) return;
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
}

static esp_err_t sendChunked(httpd_req_t *req, const uint8_t *buf, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    size_t n = len - sent < WIRE_CHUNK ? len - sent : WIRE_CHUNK;
    esp_err_t res = httpd_resp_send_chunk(req, (const char *)buf + sent, n);
    if (res != ESP_OK) return res;
    sent += n;
  }
  return ESP_OK;
}

static bool queryInt(httpd_req_t *req, const char *key, long *out) {
  char buf[96], val[16];
  if (httpd_req_get_url_query_str(req, buf, sizeof(buf)) != ESP_OK) return false;
  if (httpd_query_key_value(buf, key, val, sizeof(val)) != ESP_OK) return false;
  *out = strtol(val, nullptr, 10);
  return true;
}

// ---------------------------------------------------------------------------
// /photo -- the whole point
// ---------------------------------------------------------------------------

static esp_err_t photoHandler(httpd_req_t *req) {
  noDelay(req);

  long quality = PHOTO_QUALITY;
  queryInt(req, "q", &quality);
  if (quality < 4) quality = 4;        // below this the encoder runs out of RAM
  if (quality > 63) quality = 63;

  // Whatever the slider last chose, unless this request says otherwise.
  // config.json passes ?led= explicitly so a scheduled read is not at the
  // mercy of what somebody left the slider on.
  long led = ledLevel;
  queryInt(req, "led", &led);
  if (led < 0) led = 0;
  if (led > 255) led = 255;

  if (xSemaphoreTake(camLock, pdMS_TO_TICKS(30000)) != pdTRUE) {
    httpd_resp_set_status(req, "503 Service Unavailable");
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_send(req, "busy with another photo", HTTPD_RESP_USE_STRLEN);
  }

  unsigned long t0 = millis();
  uint8_t *copy = nullptr;
  size_t copyLen = 0;

  // Two goes at bringing the sensor up. Powering it down between photographs
  // is what keeps the board cool and the radio clear, and the price is a
  // power-on probe before every single shot -- so a probe that fails
  // occasionally has to be retried here rather than handed to the caller as a
  // 502. MeterCam polls this on a schedule; a one-in-three failure rate would
  // be a one-in-three gap in the gas reading.
  bool up = cameraUp((int)quality);
  if (!up) {
    Serial.println("photo: sensor did not come up; powering down and retrying");
    cameraDown();
    delay(300);
    up = cameraUp((int)quality);
  }

  if (up) {
    // Re-attach the LED PWM before touching it.
    //
    // The camera driver takes LEDC_CHANNEL_2 and LEDC_TIMER_1 for XCLK, and
    // esp_camera_init/deinit reach into the LEDC peripheral around those. This
    // firmware powers the sensor down after every photograph, so that happens
    // on every shot -- and a lights() call against a channel the camera has
    // since reset writes a duty cycle into nothing at all. It fails silently:
    // the photo still arrives, correctly exposed for whatever ambient light
    // there was, which looks exactly like an LED that is too dim rather than
    // one that never came on.
    lightsBegin();
    // Lights on first, and well before the frame that counts.
    lights((uint8_t)led);
    delay(LED_SETTLE_MS);          // the LED and its driver

    // Then the sensor. Auto-exposure and white balance converge per frame, so
    // this window is spent GRABBING AND DISCARDING rather than sleeping -- a
    // bare delay gives the AE loop nothing to converge on. It starts from a
    // cold AGC every time because the sensor is powered down between
    // photographs, and against a close-range diffused light the first frames
    // come back dark and green.
    //
    // WARMUP_FRAMES is the floor and ADAPT_MS is the real control; whichever
    // is satisfied last wins.
    unsigned long adaptMs = ADAPT_MS;
    long want;
    if (queryInt(req, "adapt", &want)) {
      adaptMs = (unsigned long)constrain(want, 0L, 10000L);
    }
    // An empty grab does NOT mean the sensor is gone. The first one after
    // init routinely blocks until the driver's own timeout and comes back
    // NULL, because the sensor has not produced a frame yet -- and treating
    // that as fatal ended the warm-up after zero frames while still spending
    // the two seconds, which is the worst of both. Keep asking; only a long
    // run of nothing is a real failure, and the capture below reports it.
    // Frames, not milliseconds. A dark scene exposes for longer, so a time
    // budget hands the darkest frames the fewest chances to converge -- the
    // exact backwards of what is wanted, and it made this bistable. ADAPT_MS
    // survives only as a ceiling so a dead sensor cannot wedge the request.
    long adaptFrames = ADAPT_FRAMES;
    queryInt(req, "frames", &adaptFrames);
    adaptFrames = constrain(adaptFrames, 0L, 100L);

    unsigned long hardStop = millis() + adaptMs + 6000;
    int discarded = 0, nulls = 0;
    while (discarded < adaptFrames && millis() < hardStop) {
      camera_fb_t *warm = esp_camera_fb_get();
      if (warm) {
        esp_camera_fb_return(warm);
        discarded++;
      } else {
        nulls++;
        delay(50);
      }
    }
    lastAdapt = discarded;
    if (nulls) Serial.printf("adapt: %d empty grabs along the way\n", nulls);

    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) {
      // Copy the JPEG out before the driver's buffers go away. A few hundred
      // KB of PSRAM held for a few seconds, in exchange for being able to
      // power the sensor down before any of it goes on the wire.
      copy = (uint8_t *)heap_caps_malloc(fb->len, MALLOC_CAP_SPIRAM);
      if (copy) {
        memcpy(copy, fb->buf, fb->len);
        copyLen = fb->len;
        lastError[0] = '\0';
      } else {
        snprintf(lastError, sizeof(lastError),
                 "no PSRAM for a %u byte copy", (unsigned)fb->len);
      }
      esp_camera_fb_return(fb);
    } else {
      snprintf(lastError, sizeof(lastError), "capture returned nothing");
    }
  }

  // Lights and sensor off BEFORE the transfer. On this board that reorder is
  // worth roughly twenty times the send speed -- see the note at the top.
  // Off, not back to the slider. A photograph is a flash, not a lamp -- the
  // level is remembered in ledLevel for the next shot, but nothing stays lit
  // in a cupboard because somebody moved a slider an hour ago.
  lights(0);
  cameraDown();
  unsigned long shotMs = millis() - t0;
  xSemaphoreGive(camLock);

  if (!copy) {
    Serial.printf("photo: FAILED -- %s\n", lastError);
    httpd_resp_set_status(req, "502 Bad Gateway");
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_send(req, lastError, HTTPD_RESP_USE_STRLEN);
  }

  lastBytes = copyLen;
  if (copyLen > peakBytes) peakBytes = copyLen;
  photoCount++;
  lastShotMs = shotMs;

  unsigned long t1 = millis();
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=photo.jpg");
  esp_err_t res = sendChunked(req, copy, copyLen);
  httpd_resp_send_chunk(req, NULL, 0);
  lastSendMs = millis() - t1;
  heap_caps_free(copy);

  Serial.printf("photo: %u bytes, q%ld, %u adapt frames, shot %lu ms, sent"
                " %lu ms (%.1f KB/s) %s\n",
                (unsigned)copyLen, quality, (unsigned)lastAdapt, shotMs, lastSendMs,
                lastSendMs ? copyLen * 1000.0 / lastSendMs / 1024 : 0.0,
                res == ESP_OK ? "ok" : "STALLED");
  return res;
}

// ---------------------------------------------------------------------------
// The rest
// ---------------------------------------------------------------------------

static esp_err_t statusHandler(httpd_req_t *req) {
  noDelay(req);
  uint32_t elapsed = millis() / 1000;
  uint32_t budget = (uint32_t)FOCUS_MINUTES * 60;
  char json[400];
  snprintf(json, sizeof(json),
           "{\"last\":%u,\"peak\":%u,\"photos\":%u,\"led\":%u,\"shot_ms\":%u,"
           "\"send_ms\":%u,\"adapt\":%u,\"cam_up\":%d,\"remain\":%d,\"heap\":%u,"
           "\"psram\":%u,\"ip\":\"%s\",\"rssi\":%d,\"error\":\"%s\"}",
           (unsigned)lastBytes, (unsigned)peakBytes, (unsigned)photoCount,
           (unsigned)ledLevel, (unsigned)lastShotMs, (unsigned)lastSendMs,
           (unsigned)lastAdapt, cameraUpNow ? 1 : 0,
           budget ? (int)(budget > elapsed ? budget - elapsed : 0) : -1,
           (unsigned)ESP.getFreeHeap(),
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
           WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(), lastError);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
}

// The lights, held on between photographs. MeterCam's torch_on_url and
// torch_off_url land here; so does the page's slider.
static esp_err_t ctrlHandler(httpd_req_t *req) {
  noDelay(req);
  long v;
  if (queryInt(req, "led", &v)) {
    ledLevel = (uint8_t)constrain(v, 0, 255);
    lightsBegin();     // the camera may have reset the channel; see photoHandler
    lights(ledLevel);
  }
  if (queryInt(req, "reset", &v)) peakBytes = 0;
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, "ok", HTTPD_RESP_USE_STRLEN);
}

// Bytes with no camera anywhere near them. This is the endpoint that found
// the radio problem, and it stays so the next person can tell a slow link
// from a slow sensor in one request instead of an evening.
static esp_err_t speedHandler(httpd_req_t *req) {
  noDelay(req);
  long kb = 128;
  queryInt(req, "kb", &kb);
  if (kb < 1) kb = 1;
  if (kb > 1024) kb = 1024;

  static char filler[WIRE_CHUNK];
  memset(filler, 'x', sizeof(filler));
  httpd_resp_set_type(req, "application/octet-stream");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  unsigned long t0 = millis();
  long sent = 0;
  for (long i = 0; i < kb * 1024 / (long)WIRE_CHUNK; i++) {
    if (httpd_resp_send_chunk(req, filler, WIRE_CHUNK) != ESP_OK) break;
    sent += WIRE_CHUNK;
    if (millis() - t0 > 20000) break;
  }
  httpd_resp_send_chunk(req, NULL, 0);
  unsigned long dt = millis() - t0;
  Serial.printf("speed: %ld KB in %lu ms = %.1f KB/s (sensor %s)\n", sent / 1024,
                dt, dt ? sent * 1000.0 / dt / 1024 : 0.0,
                cameraUpNow ? "UP" : "down");
  return ESP_OK;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

static const char INDEX_HTML[] PROGMEM = R"PAGE(<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gas-cam bench</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:12px;background:#111;color:#ddd;
     font:14px/1.4 ui-monospace,Consolas,monospace}
h1{font-size:15px;margin:0 0 10px;color:#888;font-weight:normal}
#wrap{overflow:hidden;background:#000;border:1px solid #333;line-height:0;
      min-height:120px}
#v{width:100%;transition:transform .1s;transform-origin:50% 50%}
.row{display:flex;gap:8px;align-items:center;margin:10px 0;flex-wrap:wrap}
button,select{background:#222;color:#ddd;border:1px solid #444;padding:5px 10px;
              font:inherit;border-radius:3px;cursor:pointer}
button:hover{background:#2c2c2c}
button.on{background:#2a4d2a;border-color:#4a7d4a}
button:disabled{opacity:.5;cursor:wait}
#shoot{background:#2a4d2a;border-color:#4a7d4a;font-weight:bold;padding:8px 18px}
input[type=range]{flex:1;min-width:140px}
#num{font-size:34px;font-weight:bold;color:#7ec87e;letter-spacing:-1px}
#peak{color:#888}
#bar{height:6px;background:#222;border-radius:3px;overflow:hidden;margin:6px 0}
#fill{height:100%;width:0;background:#7ec87e;transition:width .12s}
.hint{color:#777;font-size:12px;margin:6px 0}
#err{display:none;background:#4d2a2a;border:1px solid #7d4a4a;color:#f0c8c8;
     padding:10px;border-radius:3px;margin:0 0 10px}
#stat{color:#a88}
</style></head><body>
<h1>gas-cam &mdash; bench</h1>
<div id="err"></div>
<div class="row">
  <button id="shoot">Take photo</button>
  <span>quality</span>
  <select id="q">
    <option value="4">4 &mdash; best, biggest</option>
    <option value="6" selected>6 &mdash; very good</option>
    <option value="10">10 &mdash; production</option>
    <option value="18">18 &mdash; small and quick</option>
  </select>
  <span id="wait"></span>
</div>
<div id="wrap"><img id="v" alt=""></div>
<div class="hint">Click the image to centre the zoom.</div>
<div class="row">
  <span>zoom</span>
  <button data-z="1" class="on">1&times;</button>
  <button data-z="2">2&times;</button>
  <button data-z="4">4&times;</button>
  <button data-z="8">8&times;</button>
</div>
<div class="row"><span id="num">&mdash;</span><span id="peak"></span></div>
<div id="bar"><div id="fill"></div></div>
<div class="hint">Photo size, which stands in for sharpness: at one resolution
and one quality a crisp image does not compress as far as a blurred one. Turn
the lens <b>counter-clockwise</b> to focus closer, an eighth of a turn at a
time, one photo between each, and keep the highest number.</div>
<div class="row">
  <span>LEDs</span><input id="led" type="range" min="0" max="255" value="0">
  <span id="ledv">0</span><button id="rst">reset peak</button>
</div>
<div class="hint" id="stat"></div>
<script>
var zoom = 1, ox = 50, oy = 50, busy = false;
var v = document.getElementById('v');

function applyZoom(){
  v.style.transform = 'scale(' + zoom + ')';
  v.style.transformOrigin = ox + '% ' + oy + '%';
}
document.querySelectorAll('[data-z]').forEach(function(b){
  b.onclick = function(){
    document.querySelectorAll('[data-z]').forEach(function(x){x.classList.remove('on')});
    b.classList.add('on'); zoom = +b.dataset.z; applyZoom();
  };
});
v.onclick = function(e){
  var r = v.getBoundingClientRect();
  ox = (e.clientX - r.left) / r.width * 100;
  oy = (e.clientY - r.top) / r.height * 100;
  applyZoom();
};

function ctrl(q){ return fetch('/ctrl?' + q).catch(function(){}); }
var led = document.getElementById('led'), ledv = document.getElementById('ledv');
led.oninput = function(){ ledv.textContent = led.value; ctrl('led=' + led.value); };
document.getElementById('rst').onclick = function(){
  ctrl('reset=1'); refresh();
};

var shoot = document.getElementById('shoot');
shoot.onclick = function(){
  if (busy) return;
  busy = true;
  shoot.disabled = true;
  var t0 = Date.now(), q = document.getElementById('q').value;
  var tick = setInterval(function(){
    document.getElementById('wait').textContent =
      ((Date.now() - t0) / 1000).toFixed(1) + 's — shooting, then sending';
  }, 100);
  // Straight into the img: the browser streams it in and a slow link shows
  // as a slow paint rather than as nothing at all.
  var img = new Image();
  img.onload = function(){
    clearInterval(tick);
    document.getElementById('wait').textContent =
      'took ' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
    v.src = img.src;
    document.getElementById('err').style.display = 'none';
    busy = false; shoot.disabled = false;
    refresh();
  };
  img.onerror = function(){
    clearInterval(tick);
    document.getElementById('wait').textContent = '';
    busy = false; shoot.disabled = false;
    refresh();
  };
  img.src = '/photo?q=' + q + '&t=' + Date.now();
};

function refresh(){
  fetch('/status').then(function(r){ return r.json() }).then(function(s){
    document.getElementById('num').textContent = (s.last / 1024).toFixed(1) + ' KB';
    document.getElementById('peak').textContent =
      'peak ' + (s.peak / 1024).toFixed(1) + ' KB';
    document.getElementById('fill').style.width =
      (s.peak ? Math.max(0, Math.min(100, s.last / s.peak * 100)) : 0) + '%';
    var e = document.getElementById('err');
    if (s.error) { e.textContent = s.error; e.style.display = 'block'; }
    else e.style.display = 'none';
    var rate = s.send_ms ? (s.last / s.send_ms * 1000 / 1024).toFixed(1) : '?';
    document.getElementById('stat').textContent =
      s.photos + ' photos · last shot ' + s.shot_ms + ' ms, sent in '
      + s.send_ms + ' ms · ' + s.adapt + ' adapt frames (' + rate + ' KB/s) · sensor '
      + (s.cam_up ? 'UP' : 'powered down') + ' · ' + s.ip
      + ' · RSSI ' + s.rssi + ' dBm · PSRAM '
      + Math.round(s.psram / 1024) + ' KB free';
    if (+led.value !== s.led) { led.value = s.led; ledv.textContent = s.led; }
  }).catch(function(){});
}
refresh();
setInterval(refresh, 5000);
</script></body></html>
)PAGE";

static esp_err_t indexHandler(httpd_req_t *req) {
  noDelay(req);
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, INDEX_HTML, HTTPD_RESP_USE_STRLEN);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
//
// One server now, not two. The second existed because the stream handler ran
// for as long as a browser watched and blocked everything else on its port;
// nothing here runs longer than one photograph.

static void serverBegin() {
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  cfg.ctrl_port = 32768;
  cfg.max_uri_handlers = 8;
  // The defaults are five seconds, which is generous on a desk and not
  // generous at all on a link that is retrying. A send that takes longer than
  // this does not slow down -- the socket is closed under it, mid-photo.
  cfg.send_wait_timeout = 30;
  cfg.recv_wait_timeout = 30;
  cfg.lru_purge_enable = true;

  httpd_uri_t uris[] = {
      {"/", HTTP_GET, indexHandler, nullptr},
      {"/photo", HTTP_GET, photoHandler, nullptr},
      {"/status", HTTP_GET, statusHandler, nullptr},
      {"/ctrl", HTTP_GET, ctrlHandler, nullptr},
      {"/speed", HTTP_GET, speedHandler, nullptr},
  };

  if (httpd_start(&server, &cfg) != ESP_OK) {
    Serial.println("http server failed to start");
    return;
  }
  for (size_t i = 0; i < sizeof(uris) / sizeof(uris[0]); i++) {
    httpd_register_uri_handler(server, &uris[i]);
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
//
// The house network, because MeterCam has to be able to reach this board and
// MeterCam lives in a container on the hypervisor. The board's own access
// point is the fallback and nothing more: a board on its own AP is a board
// the service cannot see.
//
// A fixed address by preference. config.json holds this board's URL, and a
// lease that moves is a photo endpoint that stops answering on a Tuesday.

static bool netBegin() {
  bool configured = strlen(WIFI_SSID) > 0 &&
                    strcmp(WIFI_SSID, "your-wifi-ssid") != 0;

  if (configured) {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);

    if (strlen(BENCH_STATIC_IP) > 0) {
      IPAddress ip, gw, mask, dns;
      if (ip.fromString(BENCH_STATIC_IP) && gw.fromString(BENCH_GATEWAY) &&
          mask.fromString(BENCH_NETMASK)) {
        dns = gw;
        if (!WiFi.config(ip, gw, mask, dns)) {
          Serial.println("static IP rejected; falling back to DHCP");
        }
      } else {
        Serial.println("BENCH_STATIC_IP/GATEWAY/NETMASK unparseable; using DHCP");
      }
    }

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long until = millis() + 20000;
    while (WiFi.status() != WL_CONNECTED && millis() < until) delay(100);
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("\n  on \"%s\" as %s (RSSI %d dBm)\n", WIFI_SSID,
                    WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
      Serial.printf("  http://%s/            the page\n",
                    WiFi.localIP().toString().c_str());
      Serial.printf("  http://%s/photo       one JPEG, for config.json\n\n",
                    WiFi.localIP().toString().c_str());
      return true;
    }
    // The ESP32's radio is 2.4 GHz only. An SSID that exists on 5 GHz and not
    // on 2.4 is invisible to this board however right the password is.
    Serial.printf("could not join \"%s\" in 20 s -- wrong password, out of "
                  "range, or 5 GHz only (this radio is 2.4 GHz)\n",
                  WIFI_SSID);

    // What this radio can actually see, which is the only list that settles
    // the argument. A laptop's network list is 5 GHz too and a phone's is
    // both, so neither of them answers "is that SSID on 2.4 GHz at all" --
    // and that is the question when a password looks right and nothing joins.
    Serial.println("scanning 2.4 GHz for what is actually in range...");
    // Drop the failed association first. A scan started while the station is
    // still retrying a connect comes back empty on some core versions whatever
    // the radio can hear -- which makes a working board look like a dead one,
    // and is exactly the wrong answer to be confident about.
    WiFi.disconnect(true, true);
    delay(200);
    int found = WiFi.scanNetworks();
    if (found <= 0) {
      Serial.println("  nothing at all -- which points at the antenna, not"
                     " the password");
    } else {
      for (int i = 0; i < found; i++) {
        Serial.printf("  %-32s ch%-3d %4d dBm %s%s\n", WiFi.SSID(i).c_str(),
                      WiFi.channel(i), WiFi.RSSI(i),
                      WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "wpa",
                      WiFi.SSID(i) == String(WIFI_SSID) ? "   <-- config.h"
                                                        : "");
      }
      Serial.printf("  %d network(s). If the one you want is not listed, this"
                    " board cannot reach it.\n", found);
    }
    WiFi.scanDelete();
  } else {
    Serial.println("no WIFI_SSID in config.h");
  }

  WiFi.mode(WIFI_AP);
  if (WiFi.softAP(FOCUS_AP_SSID, FOCUS_AP_PASSWORD, 1, 0, 4)) {
    Serial.printf("\n  FALLBACK ONLY -- MeterCam cannot reach this.\n"
                  "  join \"%s\" (password %s), then http://%s/\n\n",
                  FOCUS_AP_SSID, FOCUS_AP_PASSWORD,
                  WiFi.softAPIP().toString().c_str());
  } else {
    Serial.println("\n  *** softAP FAILED TO START ***\n");
  }
  return false;
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  Serial.println("\ngas-cam BENCH build -- photo on demand, no stream");

  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);   // sensor starts OFF and stays off
  lightsBegin();
  lights(0);

  camLock = xSemaphoreCreateMutex();

  netBegin();
  serverBegin();

  if (FOCUS_MINUTES > 0) {
    Serial.printf("session budget %d minutes\n", FOCUS_MINUTES);
  } else {
    Serial.println("no session budget: the sensor is powered down between"
                   " photos, so this is cool enough to leave running");
  }
  Serial.println("turn the lens COUNTER-CLOCKWISE to focus closer");
}

void loop() {
  // A sensor left up by a request that died half way through is a sensor
  // heating the board for nothing, and a radio running at a twentieth of its
  // speed for the next person who asks.
  if (cameraUpNow && xSemaphoreTake(camLock, 0) == pdTRUE) {
    Serial.println("sensor was left up; powering it down");
    cameraDown();
    xSemaphoreGive(camLock);
  }

  // FOCUS_MINUTES of 0 means no budget, which is the sane setting now that
  // the sensor is off between photographs. A nonzero one still ends in deep
  // sleep with no wake timer -- sleep until reset, not sleep until 3 a.m.
  if (FOCUS_MINUTES > 0 && millis() > (unsigned long)FOCUS_MINUTES * 60000UL) {
    Serial.println("session over; sleeping until reset");
    lights(0);
    pinMode(LED_LEFT_PIN, INPUT);
    pinMode(LED_RIGHT_PIN, INPUT);
    cameraDown();
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
    Serial.flush();
    esp_deep_sleep_start();
  }

  delay(1000);
}
