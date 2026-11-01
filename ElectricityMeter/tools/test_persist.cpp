// Behaviour tests for firmware/electricity-meter/src/persist.cpp, compiled on
// a PC against the stubs in tools/stubs/ (LittleFS in memory, RTC memory as
// an array). Built and run by test_firmware.py.
#include <cstdio>
#include <string>

#include "Arduino.h"
#include "LittleFS.h"
#include "meter.h"
#include "persist.h"

// --- what the firmware's other files would provide --------------------------

SerialStub Serial;
EspStub ESP;
FsStub LittleFS;

static uint32_t nowMs = 1000;
uint32_t millis() { return nowMs; }

Detector detector;
uint32_t meterPulses = 0;
uint32_t sampleCount = 0;
uint32_t missedSlots = 0;
uint32_t longestGapUs = 0;

// --- the checks --------------------------------------------------------------

static int failed = 0;

static void check(const char* label, bool ok, const std::string& got = "") {
  if (!ok) failed++;
  std::printf("  %-4s %-60s %s\n", ok ? "ok" : "FAIL", label, got.c_str());
}

static std::string show(uint32_t pulses, const Settings& s) {
  return std::to_string(pulses) + " " + std::to_string(s.onLevel) + "/" +
         std::to_string(s.offLevel) + (s.registerSet ? " set" : " not set");
}

// A power-on: RTC memory comes up as garbage, flash keeps what it had.
static void powerOn() {
  for (size_t i = 0; i < sizeof ESP.rtc; i++) ESP.rtc[i] = (uint8_t)(i * 37 + 11);
}

static uint32_t boot(Settings& s) {
  uint32_t pulses = 12345;  // must be overwritten
  persistBegin(pulses, s);
  return pulses;
}

// The /state layout, to write copies persist.cpp did not make itself.
static void writeFlash(uint32_t version, uint32_t pulses) {
  uint32_t c[6] = {0x454d5452, version, pulses, 990u | (940u << 16), 1, 0};
  uint32_t h = 2166136261u;
  const uint8_t* p = reinterpret_cast<const uint8_t*>(c);
  for (size_t i = 0; i < 20; i++) h = (h ^ p[i]) * 16777619u;
  c[5] = h;
  auto& f = LittleFS.files["/state"];
  f.assign(p, p + sizeof c);
}

// Puts the newest pulse `ago` slots before the current slot, the flash over.
static void pulseAgo(uint32_t ago) {
  detector = Detector();
  detector.feed(1000, 1018, 0);
  detector.feed(1001, 760, 0);
  sampleCount = 1000 + ago;
}

int main() {
  Settings s;

  std::printf("first boot\n");
  powerOn();
  uint32_t p = boot(s);
  check("nothing anywhere: 0 and the defaults, not set",
        p == 0 && s.onLevel == 950 && s.offLevel == 820 && !s.registerSet, show(p, s));

  std::printf("a save, then a restart\n");
  Settings tuned = {990, 940, true};
  persistSaveNow(1234, tuned);
  check("written to /state", LittleFS.files.count("/state") == 1);
  check("by way of /state.tmp, which is gone", LittleFS.files.count("/state.tmp") == 0);
  p = boot(s);
  check("soft restart: all of it back", p == 1234 && s.onLevel == 990 && s.offLevel == 940 &&
        s.registerSet, show(p, s));
  powerOn();
  p = boot(s);
  check("power cut: flash alone has it", p == 1234 && s.registerSet, show(p, s));

  std::printf("the highest copy wins\n");
  persistPulse(1300);
  p = boot(s);
  check("RTC ahead of flash (pulses since the last save)", p == 1300, show(p, s));
  check("levels still from flash", s.onLevel == 990 && s.offLevel == 940, show(p, s));
  persistPulse(1200);
  p = boot(s);
  check("RTC behind flash: flash", p == 1234, show(p, s));

  std::printf("a reading set lower on purpose\n");
  persistSaveNow(500, tuned);
  p = boot(s);
  check("stays lower after a restart (both copies rewritten)", p == 500, show(p, s));
  powerOn();
  p = boot(s);
  check("and after a power cut", p == 500, show(p, s));

  std::printf("damaged copies are ignored\n");
  persistSaveNow(2000, tuned);
  powerOn();
  LittleFS.files["/state"][8] ^= 0x01;
  p = boot(s);
  check("a flipped bit: defaults, not a wrong register",
        p == 0 && s.onLevel == 950 && !s.registerSet, show(p, s));
  LittleFS.files["/state"].resize(10);
  p = boot(s);
  check("a short file: the same", p == 0 && !s.registerSet, show(p, s));
  writeFlash(1, 2000);
  p = boot(s);
  check("another layout version: the same", p == 0 && !s.registerSet, show(p, s));
  writeFlash(2, 2000);
  p = boot(s);
  check("(and the same bytes as version 2 are read)", p == 2000 && s.registerSet, show(p, s));
  persistPulse(2100);
  ESP.rtc[64 * 4 + 4] ^= 0x01;
  p = boot(s);
  check("a damaged RTC copy: flash", p == 2000, show(p, s));

  std::printf("flash in trouble\n");
  persistPulse(2100);
  LittleFS.mounts = false;
  p = boot(s);
  check("no filesystem: RTC still counts", p == 2100, show(p, s));
  check("with the defaults", s.onLevel == 950 && !s.registerSet, show(p, s));
  LittleFS.mounts = true;

  LittleFS.failWrite = true;
  persistSaveNow(3000, tuned);
  LittleFS.failWrite = false;
  powerOn();
  p = boot(s);
  check("a failed write leaves the old /state", p == 2000, show(p, s));
  LittleFS.failRename = true;
  persistSaveNow(3000, tuned);
  LittleFS.failRename = false;
  powerOn();
  p = boot(s);
  check("so does a failed rename", p == 2000, show(p, s));

  std::printf("when the routine save happens\n");
  boot(s);  // savedPulses 2000, lastSaveMs now
  int renames = LittleFS.renames;
  pulseAgo(5);
  nowMs += 10 * 60 * 1000;
  persistLoop(2000, tuned);
  check("register unchanged: never, however long", LittleFS.renames == renames);
  nowMs -= 10 * 60 * 1000;
  boot(s);
  nowMs += 4 * 60 * 1000;
  persistLoop(2001, tuned);
  check("changed, but under 5 minutes: not yet", LittleFS.renames == renames);
  nowMs += 60 * 1000;
  pulseAgo(2);
  detector.feed(1002, 1018, 0);  // a flash is on
  sampleCount = 1003;
  persistLoop(2001, tuned);
  check("5 minutes, but mid-flash: not yet", LittleFS.renames == renames);
  pulseAgo(2);
  persistLoop(2001, tuned);
  check("2 slots after a pulse: not yet", LittleFS.renames == renames);
  pulseAgo(9);
  persistLoop(2001, tuned);
  check("9 slots after: not yet (too near the next at 6 kW)", LittleFS.renames == renames);
  pulseAgo(4);
  persistLoop(2001, tuned);
  check("4 slots after a pulse: saved", LittleFS.renames == renames + 1);
  persistLoop(2001, tuned);
  check("and only once", LittleFS.renames == renames + 1);

  std::printf("a requested save (a level changed)\n");
  renames = LittleFS.renames;
  pulseAgo(30);
  persistRequestSave();
  persistLoop(2001, tuned);
  check("waits for a safe moment", LittleFS.renames == renames);
  pulseAgo(6);
  persistLoop(2001, tuned);
  check("and takes it, register unchanged or not", LittleFS.renames == renames + 1);
  detector = Detector();
  sampleCount = 50;
  persistRequestSave();
  persistLoop(2001, tuned);
  check("no pulse since boot: saved at once", LittleFS.renames == renames + 2);

  std::printf("a meter quiet for a minute\n");
  renames = LittleFS.renames;
  persistRequestSave();
  pulseAgo(6001);
  persistLoop(2001, tuned);
  check("saves", LittleFS.renames == renames + 1);
  // The sensor parked above "off" (the bench defaults at the meter): the
  // detector never leaves its first flash. The level fix must still be kept.
  detector = Detector();
  detector.feed(1000, 1024, 0);
  detector.feed(1001, 910, 0);
  sampleCount = 1000 + 6001;
  persistRequestSave();
  persistLoop(2001, tuned);
  check("even stuck in a 'flash' that never ends", LittleFS.renames == renames + 2);

  std::printf("failed saves are retried\n");
  renames = LittleFS.renames;
  detector = Detector();
  LittleFS.failRename = true;
  persistRequestSave();
  persistLoop(2002, tuned);
  LittleFS.failRename = false;
  check("a failed save does not count", LittleFS.renames == renames);
  persistLoop(2002, tuned);
  check("and goes again on the next loop", LittleFS.renames == renames + 1);

  std::printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
  return failed ? 1 : 0;
}
