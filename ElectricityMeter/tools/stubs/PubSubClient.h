// A recording stand-in for PubSubClient: publishes are kept for the test to
// inspect, and deliver() plays a message from the broker into the callback.
#pragma once

#include <string>
#include <vector>

#include "Arduino.h"
#include "ESP8266WiFi.h"

struct Published {
  std::string topic;
  std::string payload;
  bool retained;
};

class PubSubClient;
// The test reaches the one instance mqtt_link.cpp creates through this.
extern PubSubClient* g_mqtt;

class PubSubClient {
 public:
  typedef void (*Callback)(char*, uint8_t*, unsigned int);

  explicit PubSubClient(WiFiClient&) { g_mqtt = this; }
  void setServer(const char*, uint16_t) {}
  void setBufferSize(uint16_t n) { bufferSize = n; }
  void setKeepAlive(uint16_t) {}
  void setSocketTimeout(uint16_t) {}
  void setCallback(Callback cb) { callback_ = cb; }

  bool connect(const char*, const char*, const char*, const char* willTopic, uint8_t,
               bool, const char* willMessage) {
    will = std::string(willTopic) + "=" + willMessage;
    connected_ = true;
    return true;
  }
  bool connected() { return connected_; }
  void disconnect() { connected_ = false; }
  int state() { return 0; }
  bool loop() { return true; }

  bool publish(const char* topic, const char* payload, bool retained) {
    // PubSubClient refuses a packet bigger than its buffer: header + topic +
    // payload. Mirror that so an oversized discovery payload fails here too.
    if (5 + 2 + strlen(topic) + strlen(payload) > bufferSize) return false;
    published.push_back({topic, payload, retained});
    return true;
  }
  bool subscribe(const char* topic) {
    subscribed.push_back(topic);
    return true;
  }
  bool unsubscribe(const char* topic) {
    unsubscribed.push_back(topic);
    return true;
  }

  // Test side: a message arrives from the broker.
  void deliver(const char* topic, const std::string& payload) {
    std::string t = topic;
    std::vector<uint8_t> p(payload.begin(), payload.end());
    callback_(&t[0], p.data(), (unsigned)p.size());
  }

  std::vector<Published> published;
  std::vector<std::string> subscribed, unsubscribed;
  std::string will;
  uint16_t bufferSize = 256;

 private:
  Callback callback_ = nullptr;
  bool connected_ = false;
};
