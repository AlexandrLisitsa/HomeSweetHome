// Unit tests for firmware/electricity-meter/include/detector.h.
// Built and run by test_detector.py; see there.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

#include "detector.h"

static const uint32_t INTERVAL_MS = 10;
static const float JOULES_PER_PULSE = 3600.0f * 1000.0f / 6400.0f;  // 562.5
static const uint32_t WINDOW_SLOTS = 1000;                           // 10 s

static int failed = 0;

static void check(const char* label, bool ok, const std::string& got) {
  if (!ok) failed++;
  std::printf("  %-4s %-58s %s\n", ok ? "ok" : "FAIL", label, got.c_str());
}

// seq,value rows of a golden capture between two seqs, '#' lines skipped.
static std::vector<std::pair<uint32_t, uint16_t>> load(const char* path, uint32_t from,
                                                        uint32_t to) {
  std::vector<std::pair<uint32_t, uint16_t>> rows;
  std::ifstream in(path);
  if (!in) {
    std::printf("cannot open %s\n", path);
    std::exit(2);
  }
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty() || line[0] < '0' || line[0] > '9') continue;
    size_t comma = line.find(',');
    uint32_t seq = std::strtoul(line.c_str(), nullptr, 10);
    uint16_t value = (uint16_t)std::strtoul(line.c_str() + comma + 1, nullptr, 10);
    if (seq >= from && seq <= to) rows.push_back({seq, value});
  }
  return rows;
}

// A synthetic flash in the shape the golden capture shows.
static void flash(Detector& d, uint32_t& slot) {
  for (uint16_t v : {761, 937, 1018, 1018, 833, 761}) d.feed(slot++, v, 0);
}

static void idle(Detector& d, uint32_t& slot, uint32_t n) {
  for (uint32_t i = 0; i < n; i++) d.feed(slot++, 760, 0);
}

int main() {
  std::printf("golden: 2026-10-01-1441-boiler.csv, clean stretch\n");
  {
    // The clean stretch documented in data/golden/README.md.
    auto rows = load("../data/golden/2026-10-01-1441-boiler.csv", 18613, 23307);
    Detector d;
    uint32_t prev = rows.front().first - 1;
    uint32_t holes = 0;
    for (auto& r : rows) {
      holes += r.first - prev - 1;
      d.feed(r.first, r.second, r.first - prev - 1);
      prev = r.first;
    }
    check("no holes in the stretch", holes == 0, std::to_string(holes));
    check("163 blinks at 950/820", d.pulses == 163, std::to_string(d.pulses));
    check("nothing uncertain", d.uncertain == 0, std::to_string(d.uncertain));
  }
  {
    // Power read mid-load. From about seq 23180 the sensor is already being
    // lifted (the baseline wanders between 760 and 960), so asking at the
    // stretch's documented end sees "no pulse for a while" and rightly decays.
    auto rows = load("../data/golden/2026-10-01-1441-boiler.csv", 18613, 23150);
    Detector d;
    uint32_t prev = rows.front().first - 1;
    for (auto& r : rows) {
      d.feed(r.first, r.second, r.first - prev - 1);
      prev = r.first;
    }
    // 3.543 blinks/s at 6400 imp/kWh is 1.99 kW; the meter's display read 1.91.
    float w = d.watts(prev, INTERVAL_MS, JOULES_PER_PULSE, WINDOW_SLOTS);
    check("power about 1990 W", std::fabs(w - 1993) < 40, std::to_string(w));
  }

  std::printf("golden: the same capture, end to end, sensor handling included\n");
  {
    // 0-12.6 s and 59.6 s-end are the sensor being put on and taken off.
    // Not an assertion about the right answer -- there is none for handling --
    // just a record of how much a careless install miscounts.
    auto rows = load("../data/golden/2026-10-01-1441-boiler.csv", 0, 0xffffffff);
    Detector d;
    uint32_t prev = rows.front().first - 1;
    for (auto& r : rows) {
      d.feed(r.first, r.second, r.first - prev - 1);
      prev = r.first;
    }
    check("whole file counts at least the clean 163", d.pulses >= 163,
          std::to_string(d.pulses));
  }

  std::printf("hysteresis\n");
  {
    Detector d;
    uint32_t slot = 0;
    d.feed(slot++, 949, 0);
    check("949 is not a flash", d.pulses == 0, std::to_string(d.pulses));
    d.feed(slot++, 951, 0);
    check("951 is", d.pulses == 1, std::to_string(d.pulses));
    // Ringing between the levels after a flash must not count again.
    for (uint16_t v : {900, 960, 830, 990, 821}) d.feed(slot++, v, 0);
    check("no second count above 'off'", d.pulses == 1, std::to_string(d.pulses));
    d.feed(slot++, 819, 0);
    d.feed(slot++, 1000, 0);
    check("counts again after falling below 'off'", d.pulses == 2, std::to_string(d.pulses));
  }

  std::printf("thresholds are live\n");
  {
    Detector d;
    d.onLevel = 900;
    d.offLevel = 800;
    uint32_t slot = 0;
    d.feed(slot++, 920, 0);
    check("on=900 counts 920", d.pulses == 1, std::to_string(d.pulses));
  }

  std::printf("missed slots\n");
  {
    Detector d;
    uint32_t slot = 0;
    d.feed(slot, 760, 0);
    slot += 3;
    d.feed(slot++, 760, 2);
    check("2 missed slots are not uncertain", d.uncertain == 0, std::to_string(d.uncertain));
    slot += 4;
    d.feed(slot++, 760, 4);
    check("4 missed slots (40 ms) are", d.uncertain == 1, std::to_string(d.uncertain));
    check("and are not a pulse", d.pulses == 0, std::to_string(d.pulses));
  }

  std::printf("power\n");
  {
    Detector d;
    uint32_t slot = 0;
    flash(d, slot);
    check("0 W after one pulse", d.watts(slot, INTERVAL_MS, JOULES_PER_PULSE,
                                         WINDOW_SLOTS) == 0, "");
    // 100 slots apart is 1 s per pulse: 562.5 W.
    for (int i = 0; i < 20; i++) {
      idle(d, slot, 94);
      flash(d, slot);
    }
    float w = d.watts(slot, INTERVAL_MS, JOULES_PER_PULSE, WINDOW_SLOTS);
    check("1 pulse/s is 562.5 W", std::fabs(w - 562.5f) < 0.5f, std::to_string(w));
    w = d.watts(slot - 10, INTERVAL_MS, JOULES_PER_PULSE, WINDOW_SLOTS);
    check("asking before the newest pulse does not wrap", std::fabs(w - 562.5f) < 0.5f,
          std::to_string(w));

    // The load stops: 10 s without a pulse can be at most 56.25 W.
    idle(d, slot, 1000);
    w = d.watts(slot, INTERVAL_MS, JOULES_PER_PULSE, WINDOW_SLOTS);
    check("decays to <= 56.25 W after 10 s of nothing", w <= 56.3f, std::to_string(w));
    idle(d, slot, 360000 - 1000);
    w = d.watts(slot, INTERVAL_MS, JOULES_PER_PULSE, WINDOW_SLOTS);
    check("and under 1 W after an hour", w < 1.0f, std::to_string(w));

    // The supply limit: 6 kW is a pulse every 93.75 ms. At 10 ms slots that
    // is 9 or 10 slots apart; the average over the window must still land.
    Detector fast;
    uint32_t s = 0;
    for (int i = 0; i < 64; i++) {
      uint32_t at = (uint32_t)std::lround(i * 9.375);
      while (s < at) fast.feed(s++, 760, 0);
      fast.feed(s++, 1018, 0);
    }
    check("6 kW: every pulse counted", fast.pulses == 64, std::to_string(fast.pulses));
    w = fast.watts(s - 1, INTERVAL_MS, JOULES_PER_PULSE, WINDOW_SLOTS);
    check("6 kW within 2%", std::fabs(w - 6000) < 120, std::to_string(w));
  }

  std::printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
  return failed ? 1 : 0;
}
