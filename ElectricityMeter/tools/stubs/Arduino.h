// Just enough of the Arduino core for src/mqtt_link.cpp to compile on a PC.
// Used by test_mqtt_link.cpp only; never by the firmware.
#pragma once

#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

typedef uint8_t byte;
#define HEX 16
#define F(s) (s)

class String {
 public:
  String() {}
  String(const char* s) : s_(s) {}
  String(const std::string& s) : s_(s) {}
  String(uint32_t v, int base) {
    char buf[16];
    snprintf(buf, sizeof buf, base == HEX ? "%x" : "%u", (unsigned)v);
    s_ = buf;
  }
  const char* c_str() const { return s_.c_str(); }
  String operator+(const String& o) const { return String(s_ + o.s_); }
  String operator+(const char* o) const { return String(s_ + o); }
  bool operator==(const char* o) const { return s_ == o; }

 private:
  std::string s_;
};
inline String operator+(const char* a, const String& b) { return String(a) + b; }

struct SerialStub {
  void printf(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::vprintf(fmt, ap);
    va_end(ap);
  }
  void println(const char* s) { std::printf("%s\n", s); }
};
extern SerialStub Serial;

uint32_t millis();
inline void delay(uint32_t) {}

struct EspStub {
  uint32_t getChipId() { return 0xabc123; }
  void restart() { restarted = true; }
  bool restarted = false;
};
extern EspStub ESP;
