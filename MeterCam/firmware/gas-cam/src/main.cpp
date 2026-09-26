/*
 * MeterCam's gas meter camera.
 *
 * One wake is the whole program, and it runs in setup(): bring up the radio
 * and the sensor, light the meter, keep a couple of frames, push them to
 * MeterCam, ask whether there is a newer build, sleep. loop() is never
 * reached.
 *
 * WHY IT PUSHES
 *
 * The board runs hot enough that staying awake to be polled was the problem
 * rather than the solution, and a sleeping ESP32 answers nothing. So the
 * clock moved here and the decision stayed there: this node never judges a
 * reading, never remembers one, and never writes to Home Assistant. It hands
 * MeterCam some pixels, and MeterCam's gate -- which has tests -- decides
 * whether the house hears about them.
 *
 * WHY TWO FRAMES
 *
 * MeterCam requires the frames of a burst to agree before it will accept a
 * reading, which is what removes a flicker, sensor noise, or a drum caught
 * mid-tick. One frame cannot be checked against anything and comes back
 * `unconfirmed`. The lights are already on and the radio is already up, so
 * the second frame costs a fraction of a wake and buys back the guarantee.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * No SD card, no web server, no stream, no clock, no retry queue. A frame
 * that does not arrive is not worth a wake spent on it: the meter will still
 * be there in five minutes, and a board that retries in the dark is a board
 * whose battery -- or whose thermal budget -- goes somewhere nobody watched.
 */

#include <Arduino.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WiFi.h>
#include <esp_camera.h>
#include <esp_sleep.h>

#include "board.h"
#include "config.h"

static const char *BOUNDARY = "----metercamframeboundary";

// ---------------------------------------------------------------------------
// The lights
// ---------------------------------------------------------------------------
//
// PWM, because the right brightness is a number found by looking at frames and
// full power is usually wrong against glass. The ledc API was renamed between
// Arduino-ESP32 2.x and 3.x, and this board is old enough to meet both.

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
// Sleep
// ---------------------------------------------------------------------------

static void sleepNow() {
  lights(0);
  // Hold the lights off through sleep. Without this the pins float and a
  // half-lit LED in a cupboard is the kind of thing nobody explains for weeks.
  pinMode(LED_LEFT_PIN, INPUT);
  pinMode(LED_RIGHT_PIN, INPUT);

  // Power the sensor down explicitly rather than trusting sleep to do it: the
  // OV2640 is most of the idle draw and most of the heat.
  esp_camera_deinit();
  digitalWrite(PWDN_GPIO_NUM, HIGH);

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  Serial.printf("sleeping %d s\n", SLEEP_SECONDS);
  Serial.flush();
  esp_sleep_enable_timer_wakeup((uint64_t)SLEEP_SECONDS * 1000000ULL);
  esp_deep_sleep_start();
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

static bool cameraBegin() {
  camera_config_t cfg = {};
  cfg.ledc_channel = LEDC_CHANNEL_2;   // 0 and 1 are the lights
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
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;

  // UXGA is the point of the exercise: eight drums, three of them white on
  // red, have to survive being cropped to eight little rectangles. Anything
  // smaller is a smaller number of pixels across the digits and no amount of
  // preprocessing puts them back.
  cfg.frame_size = FRAMESIZE_UXGA;
  cfg.jpeg_quality = 10;               // 0-63, lower is better
  cfg.fb_count = 2;                    // one being sent while the next is grabbed
  cfg.fb_location = CAMERA_FB_IN_PSRAM;
  cfg.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    Serial.printf("camera init failed: 0x%x\n", err);
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    // Fixed and boring on purpose. MeterCam aligns every frame against a
    // stored reference, so a sensor that changes its mind about exposure
    // between wakes is a source of refusals rather than of better pictures.
    s->set_whitebal(s, 1);
    s->set_gain_ctrl(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_hmirror(s, 0);
    s->set_vflip(s, 0);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The push
// ---------------------------------------------------------------------------
//
// Multipart, streamed. A UXGA frame is a few hundred KB and two of them will
// not fit in a String -- the body is written straight from the frame buffers
// with the length worked out first, so nothing is ever held twice.

static bool pushFrames(camera_fb_t **frames, int count) {
  String head[8], tail = String("\r\n--") + BOUNDARY + "--\r\n";
  size_t total = tail.length();
  for (int i = 0; i < count; i++) {
    head[i] = String("--") + BOUNDARY +
              "\r\nContent-Disposition: form-data; name=\"frame" + i +
              "\"; filename=\"f" + i +
              ".jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
    total += head[i].length() + frames[i]->len + 2;  // + CRLF
  }

  WiFiClient client;
  if (!client.connect(METERCAM_HOST, METERCAM_PORT)) {
    Serial.println("push: cannot reach MeterCam");
    return false;
  }
  client.setTimeout(20000);

  String path = String("/read?meter=") + METERCAM_METER;
  client.printf("POST %s HTTP/1.1\r\n", path.c_str());
  client.printf("Host: %s:%d\r\n", METERCAM_HOST, METERCAM_PORT);
  if (strlen(METERCAM_TOKEN) > 0) {
    client.printf("X-Auth-Token: %s\r\n", METERCAM_TOKEN);
  }
  client.printf("Content-Type: multipart/form-data; boundary=%s\r\n", BOUNDARY);
  client.printf("Content-Length: %u\r\n", (unsigned)total);
  client.print("Connection: close\r\n\r\n");

  for (int i = 0; i < count; i++) {
    client.print(head[i]);
    // In chunks: write() on a few hundred KB at once fights the TCP window and
    // the watchdog, and a stalled write here is a wake spent on nothing.
    const size_t CHUNK = 4096;
    size_t sent = 0;
    while (sent < frames[i]->len) {
      size_t n = min(CHUNK, frames[i]->len - sent);
      size_t wrote = client.write(frames[i]->buf + sent, n);
      if (wrote == 0) {
        Serial.println("push: connection died mid-frame");
        client.stop();
        return false;
      }
      sent += wrote;
    }
    client.print("\r\n");
  }
  client.print(tail);

  // Read the verdict, for the log only. Nothing here acts on it: what the
  // house does with a reading is MeterCam's business and Home Assistant's,
  // and a board that started making that decision would be the second place
  // it lived.
  unsigned long deadline = millis() + 20000;
  String response;
  while (client.connected() && millis() < deadline) {
    while (client.available()) {
      response += (char)client.read();
      deadline = millis() + 20000;
    }
    delay(10);
  }
  client.stop();

  int body = response.indexOf("\r\n\r\n");
  Serial.println(body >= 0 ? response.substring(body + 4) : response);
  return response.startsWith("HTTP/1.1 200");
}

// ---------------------------------------------------------------------------
// Pull OTA
// ---------------------------------------------------------------------------
//
// The one question this board asks. Nothing can reach it while it sleeps, so
// it does the reaching, in the window where the radio is already up.
//
// It compares for DIFFERENCE, not for "newer". Version strings are whatever
// somebody typed into version.txt, and a board that only ever moves forward
// cannot be walked back when a build turns out to be wrong -- which is the
// exact moment you need it to be.

static void checkForUpdate() {
  String base = String("http://") + METERCAM_HOST + ":" + METERCAM_PORT;
  String auth = strlen(METERCAM_TOKEN) > 0
                    ? String("?token=") + METERCAM_TOKEN
                    : String("");

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, base + "/firmware/version.txt" + auth)) return;
  int code = http.GET();
  String latest = code == 200 ? http.getString() : String("");
  http.end();
  latest.trim();

  if (latest.length() == 0) {
    // 404 is the normal state: no build published. Nothing to say about it.
    return;
  }
  if (latest == FIRMWARE_VERSION) {
    Serial.printf("firmware %s is current\n", FIRMWARE_VERSION);
    return;
  }

  Serial.printf("firmware %s -> %s, updating\n", FIRMWARE_VERSION,
                latest.c_str());
  // Lights off first: an update takes tens of seconds and there is no reason
  // to spend them heating the board and lighting a cupboard.
  lights(0);

  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return result = httpUpdate.update(
      client, base + "/firmware/" + FIRMWARE_BINARY + auth);

  // Only reached when it did NOT reboot.
  if (result == HTTP_UPDATE_FAILED) {
    Serial.printf("update failed (%d): %s\n", httpUpdate.getLastError(),
                  httpUpdate.getLastErrorString().c_str());
  }
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  Serial.printf("\n%s waking\n", FIRMWARE_VERSION);

  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, LOW);   // sensor on
  lightsBegin();
  lights(0);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long until = millis() + 20000;
  while (WiFi.status() != WL_CONNECTED && millis() < until) delay(100);
  if (WiFi.status() != WL_CONNECTED) {
    // No network is not worth staying awake for. The meter will still read
    // the same number in five minutes.
    Serial.println("no wifi; back to sleep");
    sleepNow();
  }
  Serial.printf("wifi %s\n", WiFi.localIP().toString().c_str());

  if (!cameraBegin()) sleepNow();

  lights(LED_BRIGHTNESS);
  delay(LED_SETTLE_MS);

  // Auto-exposure and white balance are still chasing the light that just
  // came on. These frames are darker and greener than the scene and they are
  // thrown away rather than sent.
  for (int i = 0; i < WARMUP_FRAMES; i++) {
    camera_fb_t *warm = esp_camera_fb_get();
    if (warm) esp_camera_fb_return(warm);
  }

  camera_fb_t *frames[8] = {nullptr};
  int kept = 0;
  for (int i = 0; i < FRAMES_PER_WAKE && kept < 8; i++) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("capture failed");
      continue;
    }
    frames[kept++] = fb;
    // A breath between frames. Two frames taken in the same instant share
    // whatever was wrong with that instant, which is the one thing having two
    // of them is supposed to rule out.
    if (i + 1 < FRAMES_PER_WAKE) delay(200);
  }
  lights(0);

  if (kept > 0) {
    Serial.printf("pushing %d frame(s)\n", kept);
    pushFrames(frames, kept);
    for (int i = 0; i < kept; i++) esp_camera_fb_return(frames[i]);
  }

  checkForUpdate();
  sleepNow();
}

void loop() {}
