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

int main() {
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

  std::printf("meter reading\n");
  int saves = saveNowCalls;
  g_mqtt->deliver("electricity-meter/set/reading", "12345.6789");
  check("12345.6789 kWh -> 79012345 pulses", meterPulses == 79012345,
        std::to_string(meterPulses));
  check("saved to flash at once", saveNowCalls == saves + 1);
  check("state shows it", has(lastState(), "\"energy\":12345.6789"), lastState());
  for (const char* bad : {"abc", "", "-5", "600000", "12 kWh", "nan"}) {
    g_mqtt->deliver("electricity-meter/set/reading", bad);
    check((std::string("rejected: '") + bad + "'").c_str(), meterPulses == 79012345,
          std::to_string(meterPulses));
  }

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

  std::printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
  return failed ? 1 : 0;
}
