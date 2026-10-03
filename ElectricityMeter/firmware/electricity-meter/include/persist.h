// Keeping the register through restarts.
//
// THREE COPIES, BECAUSE EACH ONE FAILS DIFFERENTLY. The register must never
// go backwards (see meterPulses in meter.h), so at boot the board takes the
// highest of them:
//
//   RTC memory   written on every pulse. Survives a soft restart, a watchdog
//                reset and an OTA update; lost when the power goes.
//   LittleFS     written every few minutes and on every deliberate change.
//                Survives a power cut, minus the pulses since the last write.
//   the broker   the retained state topic, at most 10 s old. mqtt_link.cpp
//                checks it after the first connect and takes it if higher.
//
// The board is fed from the inverter-backed socket, so the power going is the
// rare case; the RTC copy carries every ordinary restart exactly.
#pragma once

#include <stdint.h>

struct Settings {
  uint16_t onLevel;
  uint16_t offLevel;
  // True once the register has been set from the meter's display. Until then
  // the energy sensor reports itself unavailable: a total_increasing sensor
  // takes its first value as the statistics zero point, and a first value of
  // 0 followed by the real 12 000 kWh would be booked as one hour's use.
  bool registerSet;
};

// Mounts LittleFS (formatting it on first boot) and returns the highest
// register found and the saved thresholds. With nothing saved anywhere it
// returns 0 and the detector's defaults.
void persistBegin(uint32_t& pulses, Settings& settings);

// Cheap: a few words of RTC memory. Safe to call from the sampler.
void persistPulse(uint32_t pulses);

// Writes /state now. A flash write stalls the CPU for tens of milliseconds,
// long enough to miss a few slots, so the routine save goes through
// persistLoop(), which picks a moment between two flashes.
void persistSaveNow(uint32_t pulses, const Settings& settings);

// From loop(): saves when the register moved and 5 minutes have passed, or
// when a save was requested, at the first moment no flash can be missed.
void persistLoop(uint32_t pulses, const Settings& settings);

// Ask for a save at the next safe moment (a setting changed).
void persistRequestSave();
