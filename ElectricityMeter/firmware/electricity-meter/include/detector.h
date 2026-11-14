// The blink detector: raw A0 samples in, meter pulses and watts out.
//
// Plain C++ with no Arduino in it, so tools/test_detector.py can compile it on
// a PC and replay the golden captures through exactly the code the board runs.
//
// HYSTERESIS, NOT A THRESHOLD. A flash on this sensor is a rising edge, two
// samples at the peak and a falling edge (761, 937, 1018, 1018, 833, 761), and
// the edge samples land anywhere between the baseline and the peak. A single
// level near the middle sits right on them and counts some flashes twice. So
// a flash starts above `onLevel` and has to fall below `offLevel` before the
// next one can start. 950/820 counts the boiler capture exactly; lower "on"
// levels (900, 880) also count the sensor being taken off the meter.
//
// TIME IS SLOTS, NOT MILLIS. The caller numbers each sample by the slot it
// belongs to -- samples taken plus slots missed -- so a pulse's time is its
// slot times the sampling interval, exactly, with no clock jitter in it.
//
// A MISS IS NOT IGNORED. When the caller reports a gap of `kUncertainSlots` or
// more, a whole flash (3 samples) could have fallen into it. It is counted in
// `uncertain` rather than guessed at either way.
//
// A FLASH THAT DOES NOT END IS THE GRID GOING. With mains gone the meter goes
// dark and the sensor sits at its ceiling (1024 for as long as the outage
// lasts, read on 2026-11-14), so it looks like a flash that never ends. A
// real flash is 3 samples. So `pulses` counts every flash that starts (power
// is timed from those), but a pulse is only `confirmed` -- and only then goes
// on the register -- when its flash ends inside `kMaxFlashSlots`; a longer
// one is `dropped`. A flash held for `kDarkSlots` means no mains: gridDark().
#pragma once

#include <stdint.h>

// How many slots a gap of `gapUs` between two samples skipped. One slot is the
// norm; anything past one and a half rounds to the nearest whole number of
// slots, less the one the sample itself fills.
inline uint32_t slotsMissedIn(uint32_t gapUs, uint32_t slotUs) {
  if (gapUs <= slotUs + slotUs / 2) return 0;
  return (gapUs + slotUs / 2) / slotUs - 1;
}

class Detector {
 public:
  static const uint16_t kDefaultOn = 950;
  static const uint16_t kDefaultOff = 820;
  static const uint32_t kUncertainSlots = 3;
  // At 10 ms slots: a flash longer than 1 s is not a pulse, one held for
  // 10 s is the meter gone dark.
  static const uint32_t kMaxFlashSlots = 100;
  static const uint32_t kDarkSlots = 1000;

  uint16_t onLevel = kDefaultOn;
  uint16_t offLevel = kDefaultOff;

  // Flashes started since boot, and gaps that might have hidden one.
  uint32_t pulses = 0;
  uint32_t uncertain = 0;
  // Of those, the ones that ended like a flash (the register's pulses), and
  // the ones held too long to be one.
  uint32_t confirmed = 0;
  uint32_t dropped = 0;

  // Feed one sample. `slot` is its slot number since boot; `skipped` is how
  // many slots were missed just before it. Returns true when this sample
  // confirms a pulse: the flash it ends started under kMaxFlashSlots ago.
  bool feed(uint32_t slot, uint16_t value, uint32_t skipped) {
    if (skipped >= kUncertainSlots) {
      uncertain++;
    }
    if (!inFlash_) {
      if (value > onLevel) {
        inFlash_ = true;
        pending_ = true;
        flashStart_ = slot;
        pulses++;
        history_[head_] = slot;
        head_ = (head_ + 1) % kHistory;
        if (count_ < kHistory) count_++;
      }
      return false;
    }
    if (value < offLevel) {
      inFlash_ = false;
      if (pending_) {
        pending_ = false;
        confirmed++;
        return true;
      }
    } else if (pending_ && slot - flashStart_ + 1 >= kMaxFlashSlots) {
      pending_ = false;
      dropped++;
    }
    return false;
  }

  bool inFlash() const { return inFlash_; }

  // True once a flash has been held for kDarkSlots samples: the meter is
  // dark, so there is no mains. `lastSlot` is the latest sample's slot.
  bool gridDark(uint32_t lastSlot) const {
    return inFlash_ && lastSlot - flashStart_ + 1 >= kDarkSlots;
  }

  // The slot of the newest pulse; meaningless until `pulses` > 0.
  uint32_t lastPulseSlot() const { return at(0); }

  // Average power, in watts, at slot `nowSlot`.
  //
  // Averaged over the pulses of the last `windowSlots` (at least the last two),
  // because one interval is only good to a slot: 280 ms +/- 10 ms is +/- 3.6%.
  // Never more than one pulse's energy spread over the time since the last
  // pulse, so when the load stops the figure falls towards zero instead of
  // freezing at the last rate. 0 until two pulses have been seen.
  float watts(uint32_t nowSlot, uint32_t intervalMs, float joulesPerPulse,
              uint32_t windowSlots) const {
    if (count_ < 2) {
      return 0;
    }
    uint32_t newest = at(0);
    uint8_t used = 2;
    while (used < count_ && newest - at(used) <= windowSlots) {
      used++;
    }
    uint32_t oldest = at(used - 1);
    float averaged = (used - 1) * joulesPerPulse * 1000.0f /
                     ((float)(newest - oldest) * (float)intervalMs);
    // Signed, so a caller asking about a moment before the newest pulse gets
    // the average rather than a wrapped-around gap. Multiplied as floats:
    // slots x ms overflows 32 bits after 50 days without a pulse.
    int32_t sinceLast = (int32_t)(nowSlot - newest);
    if (sinceLast > 0) {
      float bound = joulesPerPulse * 1000.0f / ((float)sinceLast * (float)intervalMs);
      if (bound < averaged) {
        return bound;
      }
    }
    return averaged;
  }

 private:
  static const uint8_t kHistory = 32;

  // The i-th most recent pulse's slot, 0 being the newest.
  uint32_t at(uint8_t i) const {
    return history_[(head_ + kHistory - 1 - i) % kHistory];
  }

  bool inFlash_ = false;
  bool pending_ = false;     // the current flash is not confirmed or dropped yet
  uint32_t flashStart_ = 0;  // the slot the current flash started in
  uint32_t history_[kHistory] = {};
  uint8_t head_ = 0;
  uint8_t count_ = 0;
};
