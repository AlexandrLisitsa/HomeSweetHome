// Host-side stand-ins for the ESPHome objects the power-station.yaml lambdas use.
// Only what the lambdas touch is modelled, and only as ESPHome behaves:
//  - Switch::publish_state drops repeated values (publish_dedup_), assigns state
//    before calling on_turn_on/on_turn_off, and the first publish always passes.
//  - A template select publishes on every accepted call and fires on_value every
//    time; SelectCall rejects an option that is not in the list. A template
//    number runs set_action, publishes only when optimistic, and saves every
//    value control() gets to flash; NumberCall rejects a value outside min..max.
//  - script.execute of a lambda-only script runs synchronously.
//  - The JK BMS charging switch is not optimistic: it only changes state when the
//    BMS confirms the write (follow_writes; false simulates a lost BLE write).
#pragma once

#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <functional>
#include <initializer_list>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace esphome {
template <typename T> using optional = std::optional<T>;
}

// --- event log: every side effect the tests may want to assert ----------------
inline std::vector<std::string> fw_events;
inline std::vector<std::string> fw_log_lines;

inline void fw_log(const char *msg) { fw_log_lines.push_back(msg); }
inline void fw_logf(const char *tag, const char *fmt, ...) {
  char buf[256];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  fw_log_lines.push_back(std::string(tag) + ": " + buf);
}
#define ESP_LOGE(tag, ...) fw_logf(tag, __VA_ARGS__)
#define ESP_LOGW(tag, ...) fw_logf(tag, __VA_ARGS__)
#define ESP_LOGI(tag, ...) fw_logf(tag, __VA_ARGS__)
#define ESP_LOGD(tag, ...) fw_logf(tag, __VA_ARGS__)

inline uint32_t fake_millis_value = 0;
inline uint32_t millis() { return fake_millis_value; }

// --- time ---------------------------------------------------------------------
// Timestamps are "local seconds": civil time converted as if it were UTC. Both
// the clock and the datetime entity use the same conversion, which is all the
// lambdas need (they only compare the two).
inline int64_t civil_to_seconds(int y, int mo, int d, int h, int mi, int s) {
  y -= mo <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  const int64_t days = era * 146097 + doe - 719468;
  return days * 86400 + h * 3600 + mi * 60 + s;
}

struct ESPTime {
  int year = 1970, month = 1, day_of_month = 1, hour = 0, minute = 0, second = 0;
  time_t timestamp = 0;
  // ESPHome: year >= 2019 && fields_in_range().
  bool is_valid() const { return year >= 2019; }
  static ESPTime make(int y, int mo, int d, int h, int mi, int s) {
    ESPTime t;
    t.year = y; t.month = mo; t.day_of_month = d; t.hour = h; t.minute = mi; t.second = s;
    t.timestamp = (time_t) civil_to_seconds(y, mo, d, h, mi, s);
    return t;
  }
};

struct FakeClock {
  ESPTime t;
  ESPTime now() const { return t; }
  void set(int y, int mo, int d, int h, int mi, int s = 0) { t = ESPTime::make(y, mo, d, h, mi, s); }
  // What SNTP's now() returns before the first sync: an epoch-near time.
  void set_invalid() { t = ESPTime::make(1970, 1, 1, 0, 0, 42); }
  void reset() { set_invalid(); }
};

// --- entities -----------------------------------------------------------------
struct FakeSensor {
  float state = NAN;
  bool has_state_ = false;
  bool has_state() const { return has_state_; }
  void publish_state(float v) { state = v; has_state_ = true; }
  void reset() { state = NAN; has_state_ = false; }
};

struct FakeBinarySensor {
  bool state = false;
  bool has_state_ = false;
  void (*on_press)() = nullptr;
  void (*on_release)() = nullptr;
  bool has_state() const { return has_state_; }
  // Post-filter publish; trigger_on_initial_state is true for grid_safe.
  void publish_state(bool v) {
    bool changed = !has_state_ || v != state;
    state = v; has_state_ = true;
    if (!changed) return;
    if (v && on_press) on_press();
    if (!v && on_release) on_release();
  }
  void reset() { state = false; has_state_ = false; }
};

struct FakeSwitch {
  std::string name;
  bool optimistic;
  bool state = false;
  bool published = false;
  bool follow_writes = true;  // non-optimistic only: the device confirms the write
  void (*on_turn_on)() = nullptr;
  void (*on_turn_off)() = nullptr;
  FakeSwitch(const char *n, bool opt) : name(n), optimistic(opt) {}
  void publish_state(bool v) {
    if (published && v == state) return;  // publish_dedup_
    published = true;
    state = v;
    if (v && on_turn_on) on_turn_on();
    if (!v && on_turn_off) on_turn_off();
  }
  void turn_on() { fw_events.push_back(name + ".turn_on"); if (optimistic || follow_writes) publish_state(true); }
  void turn_off() { fw_events.push_back(name + ".turn_off"); if (optimistic || follow_writes) publish_state(false); }
  // Put the switch in a state without firing anything (test setup).
  void preset(bool v) { state = v; published = true; }
  void reset() { state = false; published = false; follow_writes = true; }
};

struct FakeSelect;
struct SelectCall {
  FakeSelect *sel;
  std::string opt;
  SelectCall &set_option(const std::string &o) { opt = o; return *this; }
  void perform();
};

struct FakeSelect {
  std::string name;
  std::vector<std::string> options;
  std::string initial;
  std::string state;
  void (*on_value)(std::string) = nullptr;
  FakeSelect(const char *n, std::initializer_list<const char *> opts, const char *init)
      : name(n), initial(init), state(init) {
    for (auto o : opts) options.emplace_back(o);
  }
  std::string current_option() const { return state; }
  SelectCall make_call() { return SelectCall{this, ""}; }
  bool has_option(const std::string &o) const {
    for (auto &x : options) if (x == o) return true;
    return false;
  }
  void publish_state(const std::string &o) { state = o; if (on_value) on_value(o); }
  void preset(const std::string &o) { state = o; }
  void reset() { state = initial; }
};

inline void SelectCall::perform() {
  if (!sel->has_option(opt)) {
    fw_events.push_back(sel->name + ".rejected(" + opt + ")");
    return;
  }
  fw_events.push_back(sel->name + ".set(" + opt + ")");
  sel->publish_state(opt);
}

// App.scheduler: set_timeout callbacks run when the test calls run(), which
// stands for the next main-loop pass. Same key (component + name, or the
// self pointer) replaces the pending callback.
struct FakeScheduler {
  struct Item { const void *comp; std::string name; std::function<void()> fn; };
  std::vector<Item> pending;
  void set_timeout(const void *comp, const char *name, uint32_t, std::function<void()> &&fn) {
    for (auto &i : pending)
      if (i.comp == comp && i.name == name) { i.fn = std::move(fn); return; }
    pending.push_back({comp, name, std::move(fn)});
  }
  // Self-keyed overload: the key is any address, one timer per key.
  void set_timeout(const void *self, uint32_t t, std::function<void()> &&fn) {
    set_timeout(self, "", t, std::move(fn));
  }
  void run() {
    auto now = std::move(pending);
    pending.clear();
    for (auto &i : now) i.fn();
  }
  void reset() { pending.clear(); }
};
struct FakeApp { FakeScheduler scheduler; };
inline FakeApp App;

// TemplateNumber. set() is NumberCall::perform: out-of-range values are refused
// before control(); control() fires set_action, publishes when optimistic, and
// with restore_value saves the value to flash (`saved`) whatever set_action did.
// boot() is TemplateNumber::setup: publish the saved (or initial) value.
struct FakeNumber;
struct NumberCall {
  FakeNumber *num;
  float value;
  NumberCall &set_value(float v) { value = v; return *this; }
  void perform();
};

struct FakeNumber {
  std::string name;
  float min_value, max_value, initial;
  bool optimistic;
  float state;
  float saved = NAN;
  void (*on_value)(float) = nullptr;
  void (*set_action)(float) = nullptr;
  FakeNumber(const char *n, float mn, float mx, float init, bool opt)
      : name(n), min_value(mn), max_value(mx), initial(init), optimistic(opt), state(init) {}
  void publish_state(float v) {
    state = v;
    if (on_value) on_value(v);
  }
  void control(float v) {
    if (set_action) set_action(v);
    if (optimistic) publish_state(v);
    saved = v;
  }
  bool set(float v) {
    if (v < min_value || v > max_value) return false;
    control(v);
    return true;
  }
  NumberCall make_call() { return NumberCall{this, NAN}; }
  void boot() { publish_state(std::isnan(saved) ? initial : saved); }
  void preset(float v) { state = v; }
  void reset() { state = initial; saved = NAN; }
};

inline void NumberCall::perform() { num->set(value); }

struct FakeDateTime {
  int year = 2000, month = 1, day = 1, hour = 0, minute = 0, second = 0;
  std::string initial;
  void (*on_value)() = nullptr;
  explicit FakeDateTime(const char *init) : initial(init) { reset(); }
  ESPTime state_as_esptime() const { return ESPTime::make(year, month, day, hour, minute, second); }
  void preset(int y, int mo, int d, int h, int mi, int s = 0) {
    year = y; month = mo; day = d; hour = h; minute = mi; second = s;
  }
  void set(int y, int mo, int d, int h, int mi, int s = 0) {
    preset(y, mo, d, h, mi, s);
    if (on_value) on_value();
  }
  void reset() {
    if (sscanf(initial.c_str(), "%d-%d-%d %d:%d:%d", &year, &month, &day, &hour, &minute, &second) != 6)
      throw std::runtime_error("bad datetime initial_value");
  }
};

struct FakeScript {
  std::string name;
  void (*body)() = nullptr;
  int depth = 0;
  explicit FakeScript(const char *n) : name(n) {}
  void execute() {
    fw_events.push_back("script:" + name);
    if (++depth > 8) throw std::runtime_error("script recursion: " + name);
    if (body) body();
    --depth;
  }
  void reset() { depth = 0; }
};

struct FakeUart {
  std::vector<std::vector<uint8_t>> tx;
  std::deque<uint8_t> rx;
  void write_array(const uint8_t *data, size_t len) { tx.emplace_back(data, data + len); }
  int available() const { return (int) rx.size(); }
  bool read_byte(uint8_t *b) {
    if (rx.empty()) return false;
    *b = rx.front(); rx.pop_front();
    return true;
  }
  void feed(const std::string &s) { for (char c : s) rx.push_back((uint8_t) c); }
  void reset() { tx.clear(); rx.clear(); }
};
