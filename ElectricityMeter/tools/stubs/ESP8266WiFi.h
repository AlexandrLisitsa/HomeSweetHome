// Stand-in for the ESP8266 WiFi library; see Arduino.h in this directory.
#pragma once

#include "Arduino.h"

#define WL_CONNECTED 3

class WiFiClient {};

struct IpStub {
  String toString() const { return String("192.168.0.50"); }
};

struct WiFiStub {
  int status() { return WL_CONNECTED; }
  int RSSI() { return -61; }
  IpStub localIP() { return IpStub(); }
};
extern WiFiStub WiFi;
