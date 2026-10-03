// What the board knows, shared between the sampler (main.cpp), persistence
// (persist.cpp) and MQTT (mqtt_link.cpp).
//
// No locking, and none is needed: the sampler is an os_timer, and on the
// ESP8266 its callback only runs when loop() yields. It never interrupts a
// statement in loop(), so loop() can read and write these freely.
#pragma once

#include <stdint.h>

#include "detector.h"

// The NIK 2102's LED constant.
static const uint32_t IMP_PER_KWH = 6400;
static const float JOULES_PER_PULSE = 3600.0f * 1000.0f / IMP_PER_KWH;  // 562.5

static const uint32_t SAMPLE_INTERVAL_MS = 10;

// Power is averaged over the pulses of the last 10 s.
static const uint32_t POWER_WINDOW_SLOTS = 10000 / SAMPLE_INTERVAL_MS;

static const char FW_VERSION[] = "2.2.0";

extern Detector detector;

// THE REGISTER, in pulses: what the meter's display reads, times 6400. It is
// set from Home Assistant once (the "Meter reading" number) and then only
// counts up. Never let it go down by itself: Home Assistant reads a drop in a
// total_increasing sensor as the meter being replaced.
extern uint32_t meterPulses;

extern uint32_t sampleCount;
extern uint32_t missedSlots;
extern uint32_t longestGapUs;

// The slot the sampler is at now: samples taken plus slots missed.
inline uint32_t currentSlot() { return sampleCount + missedSlots; }

// Below this, power reads 0. Between blinks the detector can only give an
// upper bound (one blink's 562.5 J over the time since the last), which
// takes 19 minutes to round down to 0 after the draw stops. The flat never
// draws under 10 W while it is on the grid, so a bound under 10 W -- one
// minute without a blink -- means the draw has stopped. The register still
// counts every blink; only the power figure is floored.
static const float POWER_FLOOR_W = 10.0f;

inline float meterWatts() {
  float w = detector.watts(currentSlot(), SAMPLE_INTERVAL_MS, JOULES_PER_PULSE,
                           POWER_WINDOW_SLOTS);
  return w < POWER_FLOOR_W ? 0.0f : w;
}
