#include "persist.h"

#include <Arduino.h>
#include <LittleFS.h>

#include "meter.h"

namespace {

const uint32_t MAGIC = 0x454d5452;  // "EMTR"
const uint32_t VERSION = 2;
const char* const PATH = "/state";
const char* const TMP_PATH = "/state.tmp";

// The first 128 bytes (32 blocks) of user RTC memory belong to eboot, which
// uses them to hand an OTA image over. Stay well clear.
const uint32_t RTC_BLOCK = 64;

const uint32_t SAVE_EVERY_MS = 5UL * 60 * 1000;

struct RtcCopy {
  uint32_t magic;
  uint32_t pulses;
  uint32_t check;
};

struct FlashCopy {
  uint32_t magic;
  uint32_t version;
  uint32_t pulses;
  uint16_t onLevel;
  uint16_t offLevel;
  uint32_t registerSet;
  uint32_t check;
};

uint32_t checksum(const void* data, size_t len) {
  // FNV-1a: enough to tell a real copy from RTC garbage after a power-on.
  const uint8_t* p = static_cast<const uint8_t*>(data);
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < len; i++) {
    h = (h ^ p[i]) * 16777619u;
  }
  return h;
}

uint32_t savedPulses = 0;
uint32_t lastSaveMs = 0;
bool saveRequested = false;

}  // namespace

void persistBegin(uint32_t& pulses, Settings& settings) {
  pulses = 0;
  settings.onLevel = Detector::kDefaultOn;
  settings.offLevel = Detector::kDefaultOff;
  settings.registerSet = false;

  if (!LittleFS.begin()) {
    // begin() formats an unformatted filesystem by itself; reaching here means
    // the flash is in trouble. Count on, from RTC and the broker.
    Serial.println(F("# LittleFS failed to mount"));
  } else {
    File f = LittleFS.open(PATH, "r");
    FlashCopy c;
    if (f && f.read(reinterpret_cast<uint8_t*>(&c), sizeof c) == sizeof c &&
        c.magic == MAGIC && c.version == VERSION &&
        c.check == checksum(&c, offsetof(FlashCopy, check))) {
      pulses = c.pulses;
      settings.onLevel = c.onLevel;
      settings.offLevel = c.offLevel;
      settings.registerSet = c.registerSet != 0;
      Serial.printf("# flash: %u pulses, on %u, off %u, register %s\n",
                    (unsigned)c.pulses, c.onLevel, c.offLevel,
                    c.registerSet ? "set" : "not set");
    }
    if (f) f.close();
  }

  RtcCopy r;
  if (ESP.rtcUserMemoryRead(RTC_BLOCK, reinterpret_cast<uint32_t*>(&r), sizeof r) &&
      r.magic == MAGIC && r.check == checksum(&r, offsetof(RtcCopy, check))) {
    Serial.printf("# RTC: %u pulses\n", (unsigned)r.pulses);
    if (r.pulses > pulses) pulses = r.pulses;
  }

  savedPulses = pulses;
  lastSaveMs = millis();
}

void persistPulse(uint32_t pulses) {
  RtcCopy r = {MAGIC, pulses, 0};
  r.check = checksum(&r, offsetof(RtcCopy, check));
  ESP.rtcUserMemoryWrite(RTC_BLOCK, reinterpret_cast<uint32_t*>(&r), sizeof r);
}

void persistSaveNow(uint32_t pulses, const Settings& settings) {
  persistPulse(pulses);
  FlashCopy c = {MAGIC, VERSION, pulses, settings.onLevel, settings.offLevel,
                 settings.registerSet ? 1u : 0u, 0};
  c.check = checksum(&c, offsetof(FlashCopy, check));
  // Write aside, then rename over: a power cut mid-write leaves the old copy.
  File f = LittleFS.open(TMP_PATH, "w");
  if (!f) {
    Serial.println(F("# could not write /state"));
    return;
  }
  bool ok = f.write(reinterpret_cast<const uint8_t*>(&c), sizeof c) == sizeof c;
  f.close();
  if (ok) ok = LittleFS.rename(TMP_PATH, PATH);
  if (ok) {
    savedPulses = pulses;
    lastSaveMs = millis();
    saveRequested = false;
  }
}

void persistRequestSave() { saveRequested = true; }

void persistLoop(uint32_t pulses, const Settings& settings) {
  bool due = saveRequested ||
             (pulses != savedPulses && millis() - lastSaveMs >= SAVE_EVERY_MS);
  if (!due) return;

  // A safe moment: just after a flash has ended (the next one is at least
  // ~60 ms away even at the 6 kW limit), or when the meter has been quiet for
  // a minute. A flash write that misses a few slots then misses no blink.
  if (detector.inFlash()) return;
  uint32_t since = detector.pulses ? currentSlot() - detector.lastPulseSlot() : UINT32_MAX;
  bool justAfterFlash = since >= 4 && since <= 8;
  bool quiet = since > 60000 / SAMPLE_INTERVAL_MS;
  if (justAfterFlash || quiet) {
    persistSaveNow(pulses, settings);
  }
}
