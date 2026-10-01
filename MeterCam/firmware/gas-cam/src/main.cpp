/*
 * MeterCam's gas meter camera.
 *
 * One wake is the whole program, and it runs in setup(): bring up the radio
 * and the sensor, light the meter, keep a couple of frames, push them to
 * MeterCam, update itself if MeterCam's answer offers a newer build, sleep for
 * SLEEP_SECONDS. loop() is never reached.
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
 * be there in half an hour, and a board that retries in the dark is a board
 * whose thermal budget goes somewhere nobody watched.
 */

#include <Arduino.h>
#include <HTTPUpdate.h>
#include <WiFi.h>
#include <driver/gpio.h>
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

// Bind the lights again after the camera has touched the LEDC peripheral.
// On the 3.x core attaching a pin that is already attached fails ("already
// attached", "no free timers") and leaves whatever the camera init did to it,
// so the pins are released first and attached fresh.
static void lightsRebind() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcDetach(LED_LEFT_PIN);
  ledcDetach(LED_RIGHT_PIN);
#endif
  lightsBegin();
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

// A frame copied out of the driver, so the sensor can be off while it is sent.
struct Shot {
  uint8_t *buf;
  size_t len;
};

static bool cameraOn = false;

// Sensor off: driver down, then the power-down pin. Before the upload, not
// after it. With the sensor up the driver keeps streaming into PSRAM for the
// whole send, and on this board that starved the radio -- uploads stalled
// part-way through the first frame, while copying the JPEG out and powering
// down first delivered the same frame from the same spot in a few seconds.
// It is also most of the heat.
static void cameraOff() {
  if (cameraOn) {
    esp_camera_deinit();
    cameraOn = false;
  }
  digitalWrite(PWDN_GPIO_NUM, HIGH);
}

// Driven LOW and latched. pinMode(INPUT) -- what this used to do -- lets the
// pin FLOAT, and GPIO4 is the high-power flash transistor: a floating gate is
// the known ESP32-CAM glow in deep sleep. An output level is also not kept
// through deep sleep unless it is held, so hold it; the same goes for the
// sensor's power-down line. Released again at the top of setup().
static void holdLow(int pin) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);
  gpio_hold_en((gpio_num_t)pin);
}

static void releaseHolds() {
  gpio_hold_dis((gpio_num_t)FLASH_LED_GPIO_NUM);
  gpio_hold_dis((gpio_num_t)LED_LEFT_PIN);
  gpio_hold_dis((gpio_num_t)LED_RIGHT_PIN);
  gpio_hold_dis((gpio_num_t)PWDN_GPIO_NUM);
}

static void sleepNow() {
  lights(0);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcDetach(LED_LEFT_PIN);
  ledcDetach(LED_RIGHT_PIN);
#else
  ledcDetachPin(LED_LEFT_PIN);
  ledcDetachPin(LED_RIGHT_PIN);
#endif
  holdLow(LED_LEFT_PIN);
  holdLow(LED_RIGHT_PIN);
  holdLow(FLASH_LED_GPIO_NUM);

  // Power the sensor down explicitly rather than trusting sleep to do it: the
  // OV2640 is most of the idle draw and most of the heat. Held HIGH, or it can
  // wake on its own halfway through the sleep.
  cameraOff();
  gpio_hold_en((gpio_num_t)PWDN_GPIO_NUM);
  gpio_deep_sleep_hold_en();

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

  // UXGA is the point of the exercise: the drums, two of them white on red,
  // have to survive being cropped to little rectangles. Anything smaller is
  // fewer pixels across the digits, and nothing on the server puts them back.
  cfg.frame_size = FRAMESIZE_UXGA;
  // The alignment reference is one of these frames, and every later frame is
  // judged against it: change this and take a new reference.
  cfg.jpeg_quality = JPEG_QUALITY;     // 0-63, lower is better
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

// "firmware":"gas-cam-7" out of a JSON answer, without a JSON library: the
// key is unique ("firmware_running" does not match, its quote comes later),
// and a version is never anything that needs unescaping. Empty when absent
// or null.
static String firmwareOffered(const String &response) {
  int at = response.indexOf("\"firmware\"");
  if (at < 0) return String("");
  at = response.indexOf(':', at);
  if (at < 0) return String("");
  at++;
  while (at < (int)response.length() && response[at] == ' ') at++;
  if (at >= (int)response.length() || response[at] != '"') return String("");
  int end = response.indexOf('"', at + 1);
  if (end < 0 || end - at - 1 > 31) return String("");
  return response.substring(at + 1, end);
}

// ---------------------------------------------------------------------------
// The push
// ---------------------------------------------------------------------------
//
// Multipart, streamed. A UXGA frame is a few hundred KB and two of them will
// not fit in a String -- the body is written straight from the frame buffers
// with the length worked out first, so nothing is ever held twice.

// Returns true on a 200. `offered` gets the newest firmware version MeterCam
// named in its answer -- present on refusals and errors too -- or stays empty.
static bool pushFrames(Shot *frames, int count, String &offered) {
  String head[8], tail = String("\r\n--") + BOUNDARY + "--\r\n";
  size_t total = tail.length();
  for (int i = 0; i < count; i++) {
    head[i] = String("--") + BOUNDARY +
              "\r\nContent-Disposition: form-data; name=\"frame" + i +
              "\"; filename=\"f" + i +
              ".jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
    total += head[i].length() + frames[i].len + 2;  // + CRLF
  }

  // A few tries, not one. The first connect after joining can fail while the
  // link is still settling, and a whole wake -- lights, warm-up, two frames --
  // is too dear to throw away on one refused SYN. Not a retry queue: three
  // attempts inside this wake, then sleep.
  WiFiClient client;
  bool up = false;
  for (int attempt = 1; attempt <= 3 && !up; attempt++) {
    up = client.connect(METERCAM_HOST, METERCAM_PORT, 5000);
    if (!up) {
      Serial.printf("push: connect %d/3 failed, rssi %d dBm\n", attempt, WiFi.RSSI());
      delay(1000);
    }
  }
  if (!up) {
    Serial.println("push: cannot reach MeterCam");
    return false;
  }
  client.setTimeout(20000);

  // fw: so the build running here is visible on the server without a cable.
  String path = String("/read?meter=") + METERCAM_METER + "&fw=" + FIRMWARE_VERSION;
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
    //
    // A write of 0 is usually a full send buffer on a weak link, not a dead
    // socket: WiFiClient gives up after a short internal retry. So a stall is
    // waited out -- for as long as the socket stays connected and the stall
    // stays under 10 s -- and only then called a failure.
    const size_t CHUNK = 4096;
    size_t sent = 0;
    unsigned long stalledSince = 0;
    while (sent < frames[i].len) {
      size_t n = min(CHUNK, frames[i].len - sent);
      size_t wrote = client.write(frames[i].buf + sent, n);
      if (wrote == 0) {
        if (!stalledSince) stalledSince = millis();
        if (!client.connected() || millis() - stalledSince > 10000) {
          Serial.printf("push: connection died mid-frame (%u/%u bytes, rssi %d)\n",
                        (unsigned)sent, (unsigned)frames[i].len, WiFi.RSSI());
          client.stop();
          return false;
        }
        delay(50);
        continue;
      }
      stalledSince = 0;
      sent += wrote;
    }
    client.print("\r\n");
  }
  client.print(tail);

  // Read the answer. The verdict is for the log only: what the house does with
  // a reading is MeterCam's business and Home Assistant's, and a board that
  // started making that decision would be the second place it lived. The one
  // field acted on here is the firmware offer.
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
  offered = firmwareOffered(response);
  return response.startsWith("HTTP/1.1 200");
}

// ---------------------------------------------------------------------------
// OTA
// ---------------------------------------------------------------------------
//
// Nothing can reach this board while it sleeps, so the offer rides on the
// answer to the push: every /read reply carries "firmware":"<version>", the
// contents of the server's version.txt. Newer means a higher number after
// the last '-'; anything else is ignored. Only forward, because a board
// flashed over USB ahead of the server would otherwise "update" itself
// straight back to whatever version.txt still names -- which is how a
// USB-flashed gas-cam-4 once became gas-cam-3. Rolling back is publishing
// the old build under a higher number.

// One attempt per target version. If version.txt names a version the .bin
// does not report -- a typo, a stale build -- the board would otherwise flash,
// reboot, see the mismatch and flash again, every wake.
// RTC_NOINIT survives the reboot an update causes (RTC_DATA_ATTR does not);
// it is garbage after a power-on, hence the magic. Retried after
// OTA_RETRY_WAKES wakes in case the attempt failed for a reason that has gone.
#define OTA_MAGIC 0x4d434f54u  // "MCOT"
#define OTA_RETRY_WAKES 12
RTC_NOINIT_ATTR static struct {
  uint32_t magic;
  char tried[32];
  uint16_t wakesSince;
} ota;

static bool alreadyTried(const String &latest) {
  if (ota.magic != OTA_MAGIC) {
    ota.magic = OTA_MAGIC;
    ota.tried[0] = 0;
    ota.wakesSince = 0;
  }
  if (latest != String(ota.tried)) return false;
  if (++ota.wakesSince >= OTA_RETRY_WAKES) {
    ota.wakesSince = 0;
    return false;  // time to try again
  }
  return true;
}

// The number after the last '-' of a version: gas-cam-4 -> 4, else -1.
static long versionNumber(const String &v) {
  int dash = v.lastIndexOf('-');
  if (dash < 0 || dash + 1 >= (int)v.length()) return -1;
  for (int i = dash + 1; i < (int)v.length(); i++)
    if (!isDigit(v[i])) return -1;
  return v.substring(dash + 1).toInt();
}

static void updateIfOffered(const String &latest) {
  if (latest.length() == 0) {
    // No offer: nothing published, or no answer this wake.
    return;
  }
  if (versionNumber(latest) <= versionNumber(FIRMWARE_VERSION)) {
    Serial.printf("firmware %s is current (server offers %s)\n",
                  FIRMWARE_VERSION, latest.c_str());
    return;
  }
  if (latest.length() >= sizeof(ota.tried) || alreadyTried(latest)) {
    Serial.printf("firmware %s: %s already tried, not again yet\n",
                  FIRMWARE_VERSION, latest.c_str());
    return;
  }
  strncpy(ota.tried, latest.c_str(), sizeof(ota.tried) - 1);
  ota.tried[sizeof(ota.tried) - 1] = 0;
  ota.wakesSince = 0;

  Serial.printf("firmware %s -> %s, updating\n", FIRMWARE_VERSION,
                latest.c_str());
  // Lights off first: an update takes tens of seconds and there is no reason
  // to spend them heating the board and lighting a cupboard.
  lights(0);

  String url = String("http://") + METERCAM_HOST + ":" + METERCAM_PORT +
               "/firmware/" + FIRMWARE_BINARY;
  if (strlen(METERCAM_TOKEN) > 0) url += String("?token=") + METERCAM_TOKEN;

  WiFiClient client;
  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return result = httpUpdate.update(client, url);

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

  // The pins were latched for the sleep; nothing below can drive them until
  // the latch is let go.
  releaseHolds();
  gpio_deep_sleep_hold_dis();
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, LOW);   // sensor on
  pinMode(FLASH_LED_GPIO_NUM, OUTPUT);
  digitalWrite(FLASH_LED_GPIO_NUM, LOW);   // on-board flash stays dark
  lightsBegin();
  lights(0);

  WiFi.mode(WIFI_STA);
  // No modem sleep for the few seconds this is awake: it saves nothing worth
  // having here and makes the one TCP connection of the wake flakier.
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long until = millis() + 20000;
  while (WiFi.status() != WL_CONNECTED && millis() < until) delay(100);
  if (WiFi.status() != WL_CONNECTED) {
    // No network is not worth staying awake for. The meter will still read
    // the same number in half an hour.
    Serial.println("no wifi; back to sleep");
    sleepNow();
  }
  Serial.printf("wifi %s rssi %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  if (!cameraBegin()) sleepNow();
  cameraOn = true;

  // AFTER the camera, not before. esp_camera_init reaches into the LEDC
  // peripheral around the XCLK channel, and a lights() call against a channel
  // it has since reset writes a duty cycle into nothing: the frame still
  // arrives, exposed for whatever ambient light there was, and looks exactly
  // like an LED that is too dim.
  lightsRebind();
  lights(LED_BRIGHTNESS);
  delay(LED_SETTLE_MS);

  // Auto-exposure and white balance start from a cold AGC on every wake --
  // the sensor was powered down for the sleep -- and against a close diffused
  // light the first frames come back dark and green. Counted in FRAMES,
  // because a time budget hands the darkest scenes the fewest chances to
  // converge; ADAPT_MS survives only as a ceiling. An empty grab is
  // the sensor not having produced a frame yet, not a dead sensor.
  unsigned long hardStop = millis() + ADAPT_MS + 6000;
  int discarded = 0;
  while ((discarded < ADAPT_FRAMES || discarded < WARMUP_FRAMES)
         && millis() < hardStop) {
    camera_fb_t *warm = esp_camera_fb_get();
    if (warm) {
      esp_camera_fb_return(warm);
      discarded++;
    } else {
      delay(50);
    }
  }
  Serial.printf("adapted over %d frame(s)\n", discarded);

  Shot frames[8] = {};
  int kept = 0;
  for (int i = 0; i < FRAMES_PER_WAKE && kept < 8; i++) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("capture failed");
      continue;
    }
    // Copied out and handed straight back, so the driver can be shut down
    // before a byte goes over the air. PSRAM has room for many of these.
    uint8_t *copy = (uint8_t *)ps_malloc(fb->len);
    if (copy) {
      memcpy(copy, fb->buf, fb->len);
      frames[kept].buf = copy;
      frames[kept].len = fb->len;
      kept++;
    } else {
      Serial.println("no PSRAM for a frame copy");
    }
    esp_camera_fb_return(fb);
    // A breath between frames. Two frames taken in the same instant share
    // whatever was wrong with that instant, which is the one thing having two
    // of them is supposed to rule out.
    if (i + 1 < FRAMES_PER_WAKE) delay(200);
  }
  lights(0);
  cameraOff();

  String offered;
  if (kept > 0) {
    Serial.printf("pushing %d frame(s), sensor off\n", kept);
    pushFrames(frames, kept, offered);
    for (int i = 0; i < kept; i++) free(frames[i].buf);
  }

  updateIfOffered(offered);
  sleepNow();
}

void loop() {}
