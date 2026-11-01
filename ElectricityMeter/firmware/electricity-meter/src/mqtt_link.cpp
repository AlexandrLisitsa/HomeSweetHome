#include "mqtt_link.h"

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <PubSubClient.h>

#include <cmath>

#include "config.h"
#include "meter.h"

#if !defined(MQTT_HOST) || !defined(MQTT_PORT) || !defined(MQTT_USER) || !defined(MQTT_PASSWORD)
#error "include/config.h has no MQTT settings: copy the MQTT_* lines from config.h.example"
#endif

namespace {

const uint32_t STATE_EVERY_MS = 10000;
const uint32_t RECONNECT_EVERY_MS = 5000;

// How long the first connect waits for the broker's retained state before it
// publishes its own. Long enough for a retained message on a LAN; short
// enough that a broker with nothing retained does not hold anything up.
const uint32_t RESTORE_WAIT_MS = 3000;

// Discovery payloads run to about 700 bytes; PubSubClient's default is 256.
const uint16_t BUFFER_SIZE = 1280;

WiFiClient net;
PubSubClient mqtt(net);
Settings* settings = nullptr;

String topicStatus, topicState, topicSetReading, topicSetOn, topicSetOff, topicRestart;
String deviceId;

uint32_t lastAttemptMs = 0;
bool attempted = false;  // the first attempt goes as soon as WiFi is up
uint32_t lastStateMs = 0;

// Restoring the register from the broker happens once per boot.
bool restored = false;
uint32_t restoreUntilMs = 0;

// The last state sent, so an unchanged one is not sent again: a quiet meter
// costs the broker and Home Assistant's recorder nothing.
char lastState[256] = "";

// "12345.6789": the register to 4 decimals, from integers. A float has 7
// significant digits, which a five-digit register would use up before the
// decimals start.
void formatKwh(char* out, size_t len, uint32_t pulses) {
  uint32_t whole = pulses / IMP_PER_KWH;
  uint32_t frac = (pulses % IMP_PER_KWH) * 10000UL / IMP_PER_KWH;
  snprintf(out, len, "%lu.%04lu", (unsigned long)whole, (unsigned long)frac);
}

void publishDiscovery(const char* component, const char* id, const char* name,
                      const char* fields) {
  static char payload[BUFFER_SIZE - 128];
  // Every entity is unavailable while the board is offline. One that brings
  // its own `availability` list (the energy sensor) includes that itself.
  char availability[96] = "";
  if (!strstr(fields, "\"availability\":")) {
    snprintf(availability, sizeof availability, "\"availability_topic\":\"%s\",",
             topicStatus.c_str());
  }
  int n = snprintf(payload, sizeof payload,
           "{\"name\":\"%s\","
           "\"unique_id\":\"electricity_meter_%s\","
           "\"default_entity_id\":\"%s.electricity_meter_%s\","
           "%s"
           "\"device\":{\"identifiers\":[\"%s\"],\"name\":\"Electricity meter\","
           "\"manufacturer\":\"HomeSweetHome\",\"model\":\"NIK 2102 LED reader\","
           "\"sw_version\":\"%s\",\"configuration_url\":\"http://%s/\"},"
           "%s}",
           name, id, component, id, availability, deviceId.c_str(), FW_VERSION,
           WiFi.localIP().toString().c_str(), fields);
  if (n < 0 || (size_t)n >= sizeof payload) {
    Serial.printf("# discovery for %s is %d bytes, too long to send\n", id, n);
    return;
  }
  String topic = String("homeassistant/") + component + "/electricity_meter/" + id + "/config";
  if (!mqtt.publish(topic.c_str(), payload, true)) {
    Serial.printf("# discovery for %s did not fit or did not send\n", id);
  }
}

void publishAllDiscovery() {
  // The energy sensor's fields are the longest, at about 700 characters.
  char fields[900];
  const char* state = topicState.c_str();

  // Diagnostics ride along as attributes of the energy sensor rather than as
  // entities of their own: they explain a count, nobody graphs them. Only the
  // two that change rarely, so a new attribute value does not write a new
  // recorder row every 10 s.
  snprintf(fields, sizeof fields,
           "\"state_topic\":\"%s\",\"value_template\":\"{{ value_json.energy }}\","
           "\"unit_of_measurement\":\"kWh\",\"device_class\":\"energy\","
           "\"state_class\":\"total_increasing\",\"suggested_display_precision\":3,"
           "\"json_attributes_topic\":\"%s\","
           "\"json_attributes_template\":"
           "\"{{ {'uncertain': value_json.uncertain, 'missed_slots': value_json.missed} | tojson }}\","
           // Unavailable, not 0, until the register has been set: see
           // Settings::registerSet. Both conditions must hold.
           "\"availability\":[{\"topic\":\"%s\"},"
           "{\"topic\":\"%s\",\"value_template\":"
           "\"{{ 'online' if value_json.set else 'offline' }}\"}],"
           "\"availability_mode\":\"all\"",
           state, state, topicStatus.c_str(), state);
  publishDiscovery("sensor", "energy", "Energy", fields);

  snprintf(fields, sizeof fields,
           "\"state_topic\":\"%s\",\"value_template\":\"{{ value_json.power }}\","
           "\"unit_of_measurement\":\"W\",\"device_class\":\"power\","
           "\"state_class\":\"measurement\"",
           state);
  publishDiscovery("sensor", "power", "Power", fields);

  // No state topic: the control keeps the last value typed into it, and
  // Home Assistant restores that across restarts. Mirroring the register
  // here would write a second recorder row for every pulse, next to the
  // energy sensor's.
  snprintf(fields, sizeof fields,
           "\"command_topic\":\"%s\",\"optimistic\":true,"
           "\"min\":0,\"max\":600000,\"step\":0.001,"
           "\"mode\":\"box\",\"unit_of_measurement\":\"kWh\","
           "\"entity_category\":\"config\",\"icon\":\"mdi:counter\"",
           topicSetReading.c_str());
  publishDiscovery("number", "reading", "Meter reading", fields);

  snprintf(fields, sizeof fields,
           "\"state_topic\":\"%s\",\"value_template\":\"{{ value_json.on }}\","
           "\"command_topic\":\"%s\",\"min\":1,\"max\":1023,\"step\":1,\"mode\":\"box\","
           "\"entity_category\":\"config\",\"icon\":\"mdi:arrow-collapse-up\"",
           state, topicSetOn.c_str());
  publishDiscovery("number", "threshold_on", "Flash on level", fields);

  snprintf(fields, sizeof fields,
           "\"state_topic\":\"%s\",\"value_template\":\"{{ value_json.off }}\","
           "\"command_topic\":\"%s\",\"min\":1,\"max\":1022,\"step\":1,\"mode\":\"box\","
           "\"entity_category\":\"config\",\"icon\":\"mdi:arrow-collapse-down\"",
           state, topicSetOff.c_str());
  publishDiscovery("number", "threshold_off", "Flash off level", fields);

  snprintf(fields, sizeof fields,
           "\"command_topic\":\"%s\",\"payload_press\":\"PRESS\","
           "\"device_class\":\"restart\",\"entity_category\":\"config\"",
           topicRestart.c_str());
  publishDiscovery("button", "restart", "Restart", fields);
}

// Payloads arrive unterminated; copy one into a buffer as a C string.
void payloadString(char* out, size_t len, const byte* payload, unsigned int n) {
  if (n >= len) n = len - 1;
  memcpy(out, payload, n);
  out[n] = '\0';
}

// A number and nothing else. strtod alone reads "abc" as 0, and 0 is a valid
// register: a stray payload must not be able to zero the meter.
bool parseNumber(const char* text, double& out) {
  char* end = nullptr;
  out = strtod(text, &end);
  if (end == text) return false;
  while (*end == ' ' || *end == '\n' || *end == '\r') end++;
  return *end == '\0' && std::isfinite(out);
}

void finishRestore() {
  if (restored) return;
  restored = true;
  mqtt.unsubscribe(topicState.c_str());
  Serial.printf("# register restored: %lu pulses\n", (unsigned long)meterPulses);
}

// Only what Home Assistant uses. No uptime or RSSI: they change every time,
// and would turn every check into a publish and a recorder row.
void buildState(char* json, size_t len) {
  char kwh[24];
  formatKwh(kwh, sizeof kwh, meterPulses);
  snprintf(json, len,
           "{\"energy\":%s,\"power\":%ld,\"pulses\":%lu,\"uncertain\":%lu,"
           "\"missed\":%lu,\"on\":%u,\"off\":%u,\"set\":%s}",
           kwh, lroundf(meterWatts()), (unsigned long)meterPulses,
           (unsigned long)detector.uncertain, (unsigned long)missedSlots,
           settings->onLevel, settings->offLevel,
           settings->registerSet ? "true" : "false");
}

void sendState(bool force) {
  if (!mqtt.connected() || !restored) return;
  char json[sizeof lastState];
  buildState(json, sizeof json);
  if (!force && strcmp(json, lastState) == 0) return;
  if (mqtt.publish(topicState.c_str(), json, true)) {
    strcpy(lastState, json);
  }
}

void onMessage(char* topic, byte* payload, unsigned int length) {
  char text[384];
  payloadString(text, sizeof text, payload, length);

  if (topicState == topic) {
    // Our own retained state from before the restart. Only ever raises the
    // register: a lower figure here is older than what RTC or flash had.
    // The pulses counted since boot go on top of it, because the boot
    // figure they were added to is the one being replaced.
    const char* p = strstr(text, "\"pulses\":");
    if (!restored && p) {
      uint32_t retained = strtoul(p + 9, nullptr, 10);
      Serial.printf("# broker: %u pulses retained\n", (unsigned)retained);
      uint32_t restoredPulses = retained + detector.pulses;
      if (restoredPulses > meterPulses) {
        meterPulses = restoredPulses;
        persistPulse(meterPulses);
        persistRequestSave();
      }
      if (!settings->registerSet && strstr(text, "\"set\":true")) {
        settings->registerSet = true;
        persistRequestSave();
      }
      restoreUntilMs = millis();  // got it; no need to wait out the timeout
    }
    return;
  }

  if (topicSetReading == topic) {
    double kwh;
    if (parseNumber(text, kwh) && kwh >= 0 && kwh < 600000) {
      meterPulses = (uint32_t)llround(kwh * IMP_PER_KWH);
      settings->registerSet = true;
      Serial.printf("# register set to %s kWh\n", text);
      // A reading typed in is newer than anything retained: a state still on
      // its way from the broker must not overwrite it.
      finishRestore();
      // Straight to flash: this is the one deliberate jump, and it must not
      // come back as the old value after a power cut.
      persistSaveNow(meterPulses, *settings);
    }
    mqttPublishState();
    return;
  }

  if (topicSetOn == topic || topicSetOff == topic) {
    // Home Assistant may send "900" or "900.0".
    double v;
    bool ok = parseNumber(text, v) && v == std::floor(v) && v >= 1 && v <= 1023;
    uint16_t on = settings->onLevel;
    uint16_t off = settings->offLevel;
    if (ok) {
      if (topicSetOn == topic) on = (uint16_t)v; else off = (uint16_t)v;
    }
    // "off" at 0 would never be crossed, and the detector would wait forever
    // for a flash to end; hence 1 <= off < on. Rejected levels are answered
    // with the unchanged state, so the number in Home Assistant snaps back
    // instead of showing a value not in force.
    if (ok && off < on) {
      settings->onLevel = on;
      settings->offLevel = off;
      detector.onLevel = on;
      detector.offLevel = off;
      persistRequestSave();
      Serial.printf("# levels now on %u, off %u\n", on, off);
    }
    mqttPublishState();
    return;
  }

  if (topicRestart == topic) {
    Serial.println(F("# restart requested over MQTT"));
    persistSaveNow(meterPulses, *settings);
    mqtt.publish(topicStatus.c_str(), "offline", true);
    mqtt.disconnect();
    delay(100);
    ESP.restart();
    return;
  }

  if (strcmp(topic, "homeassistant/status") == 0 && strcmp(text, "online") == 0) {
    // Home Assistant restarted: tell it again what this board is.
    publishAllDiscovery();
    if (restored) mqttPublishState();
  }
}

void connect() {
  lastAttemptMs = millis();
  attempted = true;
  Serial.printf("# MQTT: connecting to %s:%u\n", MQTT_HOST, (unsigned)MQTT_PORT);
  if (!mqtt.connect(HOSTNAME, MQTT_USER, MQTT_PASSWORD, topicStatus.c_str(), 0, true,
                    "offline")) {
    Serial.printf("# MQTT: failed, state %d\n", mqtt.state());
    return;
  }
  Serial.println(F("# MQTT: connected"));
  mqtt.publish(topicStatus.c_str(), "online", true);
  if (!restored) {
    mqtt.subscribe(topicState.c_str());
    restoreUntilMs = millis() + RESTORE_WAIT_MS;
  }
  mqtt.subscribe(topicSetReading.c_str());
  mqtt.subscribe(topicSetOn.c_str());
  mqtt.subscribe(topicSetOff.c_str());
  mqtt.subscribe(topicRestart.c_str());
  mqtt.subscribe("homeassistant/status");
  publishAllDiscovery();
  if (restored) mqttPublishState();
}

}  // namespace

void mqttBegin(Settings* s) {
  settings = s;
  String base = HOSTNAME;
  topicStatus = base + "/status";
  topicState = base + "/state";
  topicSetReading = base + "/set/reading";
  topicSetOn = base + "/set/on";
  topicSetOff = base + "/set/off";
  topicRestart = base + "/restart";
  deviceId = String("electricity_meter_") + String(ESP.getChipId(), HEX);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(BUFFER_SIZE);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(2);
  mqtt.setCallback(onMessage);
}

// Always sends: after a command, so a refused value snaps back in Home
// Assistant, and after a (re)connect, when the broker may have lost it.
void mqttPublishState() { sendState(true); }

void mqttLoop() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!mqtt.connected()) {
    if (!attempted || millis() - lastAttemptMs >= RECONNECT_EVERY_MS) connect();
    return;
  }
  mqtt.loop();

  if (!restored && (int32_t)(millis() - restoreUntilMs) >= 0) {
    finishRestore();
    mqttPublishState();
  }
  // Checked every 10 s, sent only if it changed.
  if (restored && millis() - lastStateMs >= STATE_EVERY_MS) {
    lastStateMs = millis();
    sendState(false);
  }
}
