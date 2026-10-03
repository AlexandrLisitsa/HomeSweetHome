// Behaviour tests for firmware/electricity-meter/src/mqtt_link.cpp, compiled on
// a PC against the stubs in tools/stubs/. Built and run by test_firmware.py,
// which also parses every discovery payload this writes to
// build/published.tsv with a real JSON parser.
#include <cstdio>
#include <string>

#include "Arduino.h"
#include "PubSubClient.h"
#include "meter.h"
#include "mqtt_link.h"

// --- what the firmware's other files would provide --------------------------

SerialStub Serial;
EspStub ESP;
WiFiStub WiFi;
PubSubClient* g_mqtt = nullptr;

static uint32_t nowMs = 1000;
uint32_t millis() { return nowMs; }

Detector detector;
uint32_t meterPulses = 0;
uint32_t sampleCount = 0;
uint32_t missedSlots = 0;
uint32_t longestGapUs = 0;

static int saveNowCalls = 0, saveRequests = 0;
static uint32_t rtcPulses = 0;
void persistPulse(uint32_t pulses) { rtcPulses = pulses; }
void persistSaveNow(uint32_t, const Settings&) { saveNowCalls++; }
void persistRequestSave() { saveRequests++; }

// --- the checks --------------------------------------------------------------

static int failed = 0;

static void check(const char* label, bool ok, const std::string& got = "") {
  if (!ok) failed++;
  std::printf("  %-4s %-60s %s\n", ok ? "ok" : "FAIL", label, got.c_str());
}

static size_t countTopic(const std::string& prefix, size_t from = 0) {
  size_t n = 0;
  for (size_t i = from; i < g_mqtt->published.size(); i++) {
    if (g_mqtt->published[i].topic.rfind(prefix, 0) == 0) n++;
  }
  return n;
}

static std::string lastState() {
  for (size_t i = g_mqtt->published.size(); i-- > 0;) {
    if (g_mqtt->published[i].topic == "electricity-meter/state") {
      return g_mqtt->published[i].payload;
    }
  }
  return "";
}

static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }

static size_t stateCount() { return countTopic("electricity-meter/state"); }

static int finish() {
  std::printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
  return failed ? 1 : 0;
}

// Booted from a flash copy 5 minutes old, counted 30 pulses while the broker
// was being reached, then the broker's fresher copy arrives.
static int restoreAddsCounted() {
  Settings settings = {950, 820, true};
  detector.pulses = 30;
  meterPulses = 1000 + 30;
  std::printf("restore keeps what was counted since boot\n");
  mqttBegin(&settings);
  mqttLoop();
  g_mqtt->deliver("electricity-meter/state", "{\"pulses\":1500,\"set\":true}");
  check("retained 1500 + 30 counted since boot", meterPulses == 1530,
        std::to_string(meterPulses));
  check("and goes to RTC", rtcPulses == 1530, std::to_string(rtcPulses));
  return finish();
}

// The reading is typed in while the board is still waiting for the broker's
// retained state; the old state arrives a moment later.
static int readingBeatsRestore() {
  Settings settings = {950, 820, false};
  meterPulses = 0;
  std::printf("a reading set during the restore wait wins\n");
  mqttBegin(&settings);
  mqttLoop();
  g_mqtt->deliver("electricity-meter/set/reading", "100");
  check("100 kWh -> 640000 pulses", meterPulses == 640000, std::to_string(meterPulses));
  check("published at once", has(lastState(), "\"energy\":100.0000"), lastState());
  g_mqtt->deliver("electricity-meter/state", "{\"pulses\":9999999,\"set\":true}");
  check("a late retained state does not overwrite it", meterPulses == 640000,
        std::to_string(meterPulses));
  return finish();
}

// The draw stops: power must read 0 within a minute, not decay for 19.
static int powerFloor() {
  Settings settings = {990, 940, true};
  meterPulses = 1000;
  std::printf("power reads 0 once the draw has stopped\n");
  mqttBegin(&settings);
  mqttLoop();
  nowMs += 3000;
  mqttLoop();  // restore wait over
  // 562.5 W: a pulse every 100 slots.
  for (uint32_t s = 0; s <= 1000; s += 100) {
    detector.feed(s, 1018, 0);
    detector.feed(s + 1, 760, 0);
  }
  sampleCount = 1000;
  mqttPublishState();
  check("562.5 W while the pulses come", has(lastState(), "\"power\":563"), lastState());
  sampleCount = 1000 + 5000;  // 50 s without a pulse: at most 11.25 W
  mqttPublishState();
  check("11 W after 50 s without one (still possible)", has(lastState(), "\"power\":11,"),
        lastState());
  sampleCount = 1000 + 5700;  // 57 s: at most 9.9 W
  mqttPublishState();
  check("0 W once the bound is under 10 W", has(lastState(), "\"power\":0,"), lastState());
  size_t states = stateCount();
  for (int i = 0; i < 120; i++) {  // the next 20 minutes, a check every 10 s
    sampleCount += 1000;
    nowMs += 10000;
    mqttLoop();
  }
  check("and nothing more is sent while it stays quiet", stateCount() == states,
        std::to_string(stateCount() - states));
  return finish();
}

int main(int argc, char** argv) {
  std::string scenario = argc > 1 ? argv[1] : "";
  if (scenario == "power-floor") return powerFloor();
  if (scenario == "restore-adds-counted") return restoreAddsCounted();
  if (scenario == "reading-beats-restore") return readingBeatsRestore();

  Settings settings = {950, 820, false};
  meterPulses = 1000;  // what flash had at boot

  std::printf("connect\n");
  mqttBegin(&settings);
  mqttLoop();
  check("last will is offline on the status topic",
        g_mqtt->will == "electricity-meter/status=offline", g_mqtt->will);
  check("online published, retained", !g_mqtt->published.empty() &&
        g_mqtt->published[0].topic == "electricity-meter/status" &&
        g_mqtt->published[0].payload == "online" && g_mqtt->published[0].retained);
  check("six discovery payloads", countTopic("homeassistant/") == 6,
        std::to_string(countTopic("homeassistant/")));
  bool allRetained = true;
  for (auto& p : g_mqtt->published) allRetained &= p.retained;
  check("all of them retained", allRetained);
  check("no state before the broker's retained one is checked", lastState().empty());
  bool subscribedState = false;
  for (auto& t : g_mqtt->subscribed) subscribedState |= t == "electricity-meter/state";
  check("subscribed to its own state, to restore from it", subscribedState);

  std::printf("restore from the broker\n");
  g_mqtt->deliver("electricity-meter/state", "{\"energy\":0.0781,\"pulses\":500,\"set\":true}");
  check("a lower retained register does not lower it", meterPulses == 1000,
        std::to_string(meterPulses));
  check("but the register-set flag is taken", settings.registerSet);
  g_mqtt->deliver("electricity-meter/state", "{\"energy\":0.2343,\"pulses\":1500,\"set\":true}");
  check("a higher one raises it", meterPulses == 1500, std::to_string(meterPulses));
  check("and goes to RTC at once", rtcPulses == 1500, std::to_string(rtcPulses));
  mqttLoop();
  std::string st = lastState();
  check("then the state is published", !st.empty(), st);
  check("energy to 4 decimals from integers", has(st, "\"energy\":0.2343"), st);
  check("set:true in the state", has(st, "\"set\":true"), st);
  bool unsubscribed = !g_mqtt->unsubscribed.empty() &&
                      g_mqtt->unsubscribed[0] == "electricity-meter/state";
  check("and its own state topic is let go", unsubscribed);
  g_mqtt->deliver("electricity-meter/state", "{\"pulses\":999999,\"set\":true}");
  check("a retained message after the restore is ignored", meterPulses == 1500,
        std::to_string(meterPulses));
  check("no uptime or rssi in the state", !has(st, "uptime") && !has(st, "rssi"), st);

  std::printf("state only when it changed\n");
  size_t states = stateCount();
  nowMs += 10000;
  mqttLoop();
  check("an unchanged state is not sent again", stateCount() == states,
        std::to_string(stateCount() - states));
  meterPulses++;
  nowMs += 5000;
  mqttLoop();
  check("not before 10 s", stateCount() == states, std::to_string(stateCount() - states));
  nowMs += 5000;
  mqttLoop();
  check("a pulse is sent at the next check", stateCount() == states + 1,
        std::to_string(stateCount() - states));
  check("with the new register", has(lastState(), "\"pulses\":1501"), lastState());
  nowMs += 10000;
  mqttLoop();
  check("and not again", stateCount() == states + 1, std::to_string(stateCount() - states));
  meterPulses--;  // keep the figures below as they were

  std::printf("meter reading\n");
  int saves = saveNowCalls;
  g_mqtt->deliver("electricity-meter/set/reading", "12345.6789");
  check("12345.6789 kWh -> 79012345 pulses", meterPulses == 79012345,
        std::to_string(meterPulses));
  check("saved to flash at once", saveNowCalls == saves + 1);
  check("state shows it", has(lastState(), "\"energy\":12345.6789"), lastState());
  std::string huge = "1" + std::string(400, '0');
  for (const char* bad : {"abc", "", "-5", "600000", "12 kWh", "nan", "inf", "-inf",
                          " ", "1,5", huge.c_str()}) {
    states = stateCount();
    g_mqtt->deliver("electricity-meter/set/reading", bad);
    std::string label = std::string("rejected: '") + std::string(bad).substr(0, 12) + "'";
    check(label.c_str(), meterPulses == 79012345, std::to_string(meterPulses));
    check("  and answered with the unchanged state", stateCount() == states + 1);
  }
  struct { const char* text; uint32_t pulses; } good[] = {
      {"0", 0},                {"-0", 0},          {" 5", 32000},     {"5\n", 32000},
      {"1e3", 6400000},        {"0.0001", 1},      {"0.00007", 0},    {"599999.9999", 3839999999u},
  };
  for (auto& g : good) {
    g_mqtt->deliver("electricity-meter/set/reading", g.text);
    std::string label = std::string("accepted: '") + g.text + "'";
    check(label.c_str(), meterPulses == g.pulses, std::to_string(meterPulses));
  }
  g_mqtt->deliver("electricity-meter/set/reading", "12345.6789");

  std::printf("detection levels\n");
  g_mqtt->deliver("electricity-meter/set/on", "900");
  check("on 900 accepted", settings.onLevel == 900 && detector.onLevel == 900,
        std::to_string(settings.onLevel));
  g_mqtt->deliver("electricity-meter/set/off", "800.0");
  check("off '800.0' accepted", settings.offLevel == 800 && detector.offLevel == 800,
        std::to_string(settings.offLevel));
  for (const char* bad : {"900", "950", "0", "abc", "1024", "850.5"}) {
    g_mqtt->deliver("electricity-meter/set/off", bad);
    check((std::string("off rejected: '") + bad + "'").c_str(),
          settings.offLevel == 800 && detector.offLevel == 800,
          std::to_string(settings.offLevel));
  }
  g_mqtt->deliver("electricity-meter/set/on", "800");
  check("on not at or below off", settings.onLevel == 900, std::to_string(settings.onLevel));
  check("state carries the levels", has(lastState(), "\"on\":900,\"off\":800"), lastState());
  states = stateCount();
  g_mqtt->deliver("electricity-meter/set/on", "abc");
  check("a refused level is answered anyway, so HA snaps back", stateCount() == states + 1);
  g_mqtt->deliver("electricity-meter/set/on", "1023");
  check("on 1023, the top, accepted", settings.onLevel == 1023, std::to_string(settings.onLevel));
  g_mqtt->deliver("electricity-meter/set/off", "1");
  check("off 1, the bottom, accepted", settings.offLevel == 1, std::to_string(settings.offLevel));
  g_mqtt->deliver("electricity-meter/set/on", "1");
  check("on equal to off refused", settings.onLevel == 1023, std::to_string(settings.onLevel));
  g_mqtt->deliver("electricity-meter/set/on", "990");
  g_mqtt->deliver("electricity-meter/set/off", "940");
  check("990 / 940, as set at the meter", settings.onLevel == 990 && settings.offLevel == 940 &&
        detector.onLevel == 990 && detector.offLevel == 940);
  int requests = saveRequests;
  g_mqtt->deliver("electricity-meter/set/off", "941");
  check("a level change asks for a save", saveRequests == requests + 1);

  std::printf("Home Assistant restarts\n");
  size_t before = g_mqtt->published.size();
  g_mqtt->deliver("homeassistant/status", "online");
  check("discovery sent again", countTopic("homeassistant/", before) == 6,
        std::to_string(countTopic("homeassistant/", before)));

  std::printf("restart button\n");
  saves = saveNowCalls;
  g_mqtt->deliver("electricity-meter/restart", "PRESS");
  check("saves first", saveNowCalls == saves + 1);
  check("says offline", g_mqtt->published.back().topic == "electricity-meter/status" &&
        g_mqtt->published.back().payload == "offline");
  check("restarts", ESP.restarted);

  // For test_firmware.py to parse.
  FILE* out = std::fopen("build/published.tsv", "w");
  for (auto& p : g_mqtt->published) {
    std::fprintf(out, "%s\t%s\n", p.topic.c_str(), p.payload.c_str());
  }
  std::fclose(out);

  return finish();
}
