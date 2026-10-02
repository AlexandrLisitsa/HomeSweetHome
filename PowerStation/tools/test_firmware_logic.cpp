// Unit tests for the decision logic of PowerStation/power-station.yaml.
//
// Every function under test is generated from the YAML by extract_lambdas.py
// (build/firmware_logic.gen.h): the lambda bodies are the flashed code, verbatim.
// Run through test_firmware_logic.py, which extracts, compiles and runs.
//
// Groups whose name starts with KNOWN_BUG assert the intended behaviour of a
// defect that is still in the firmware: their failures are printed but do not
// fail the run. When one starts passing, move it to a normal group.

#include <algorithm>
#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

#include "firmware_logic.gen.h"

// --- a very small test framework -------------------------------------------
struct TestCase {
  const char *group;
  const char *name;
  void (*fn)();
};
static std::vector<TestCase> &registry() {
  static std::vector<TestCase> r;
  return r;
}
struct Reg {
  Reg(const char *g, const char *n, void (*f)()) { registry().push_back({g, n, f}); }
};
static std::vector<std::string> g_fail;

#define TEST(group, name)                                     \
  static void group##__##name();                              \
  static Reg reg_##group##__##name(#group, #name, group##__##name); \
  static void group##__##name()

static std::string show(const std::string &s) { return "\"" + s + "\""; }
static std::string show(bool b) { return b ? "true" : "false"; }
static std::string show(double v) { std::ostringstream o; o << v; return o.str(); }
static std::string show(float v) { return show((double) v); }
static std::string show(int v) { return std::to_string(v); }
static std::string show(unsigned v) { return std::to_string(v); }
static std::string show(unsigned long v) { return std::to_string(v); }
static std::string show(const std::vector<std::string> &v) {
  std::string s = "[";
  for (size_t i = 0; i < v.size(); i++) s += (i ? ", " : "") + show(v[i]);
  return s + "]";
}

#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) g_fail.push_back(std::string("line ") + std::to_string(__LINE__) + ": CHECK(" #cond ")"); \
  } while (0)
#define CHECK_EQ(a, b)                                                           \
  do {                                                                           \
    auto _a = (a);                                                               \
    auto _b = (b);                                                               \
    if (!(_a == _b))                                                             \
      g_fail.push_back(std::string("line ") + std::to_string(__LINE__) + ": " #a " == " #b \
                       " -> got " + show(_a) + ", want " + show(_b));            \
  } while (0)

// --- fixture and helpers ----------------------------------------------------
using Q = std::vector<std::string>;

static void at(int h, int m, int s = 0, int day = 2) { id(sntp_time).set(2026, 10, day, h, m, s); }
static void until(int h, int m, int s = 0, int day = 2) { id(dt_precharge_until).preset(2026, 10, day, h, m, s); }
static void grid_bad(bool bad) { id(grid_safe).state = bad; id(grid_safe).has_state_ = true; }
static std::string prio() { return id(select_power_priority).state; }
static Q queue() { return id(command_queue); }
static int count(const std::string &ev) { return (int) std::count(fw_events.begin(), fw_events.end(), ev); }
static int index_of(const std::string &ev) {
  auto it = std::find(fw_events.begin(), fw_events.end(), ev);
  return it == fw_events.end() ? -1 : (int) (it - fw_events.begin());
}
static void power_mode() { id(evaluate_power_mode).execute(); }
static void charge_window() { id(evaluate_charge_window).execute(); }
static void clear_effects() { fw_events.clear(); id(command_queue).clear(); id(command_retries) = 0; }

static const char *BMS_ON = "switch_bms_charging.turn_on";
static const char *BMS_OFF = "switch_bms_charging.turn_off";
static const char *RUN_PM = "script:evaluate_power_mode";
static const char *RUN_CW = "script:evaluate_charge_window";

// A running device at noon on a healthy grid: the restored defaults
// (protection, tariff and pre-charge ON, night-only OFF, charger ON).
static void baseline() {
  fw_reset();
  App.scheduler.reset();
  fw_events.clear();
  fw_log_lines.clear();
  fake_millis_value = 0;
  id(restore_replay_done) = true;
  id(sns_grid_v).publish_state(230.0f);
  grid_bad(false);
  id(switch_auto_protection).preset(true);
  id(switch_auto_tariff).preset(true);
  id(switch_night_charging).preset(false);
  id(switch_precharge_enable).preset(true);
  id(switch_bms_charging).preset(true);
  at(12, 0);
}

// ============================================================================
// evaluate_power_mode
// ============================================================================
TEST(power_mode, no_grid_voltage_yet_does_nothing) {
  id(sns_grid_v).reset();
  grid_bad(true);
  power_mode();
  CHECK_EQ(prio(), std::string("Utility First"));
  CHECK(queue().empty());
}

TEST(power_mode, rule1_protection_and_bad_grid_forces_sbu) {
  at(2, 0);  // night: the tariff alone would say Utility First
  grid_bad(true);
  power_mode();
  CHECK_EQ(prio(), std::string("SBU Battery"));
  // Direct push plus the select's on_value: the documented belt-and-braces.
  CHECK_EQ(queue(), (Q{"POP02", "POP02"}));
  CHECK_EQ(id(command_retries), 20);
}

TEST(power_mode, rule1_already_sbu_reasserts_once) {
  id(select_power_priority).preset("SBU Battery");
  grid_bad(true);
  power_mode();
  CHECK_EQ(queue(), (Q{"POP02"}));
  CHECK_EQ(count("select_power_priority.set(SBU Battery)"), 0);
}

TEST(power_mode, rule1_ignores_invalid_clock) {
  id(sntp_time).set_invalid();
  grid_bad(true);
  power_mode();
  CHECK_EQ(prio(), std::string("SBU Battery"));
}

TEST(power_mode, rule1_does_not_refill_running_retry_counter) {
  id(command_queue).push_back("MUCHGC030");  // a command mid-retry at the front
  id(command_retries) = 5;
  grid_bad(true);
  power_mode();
  CHECK_EQ(id(command_retries), 5);
}

TEST(power_mode, protection_off_bad_grid_tariff_still_decides) {
  id(switch_auto_protection).preset(false);
  grid_bad(true);
  at(2, 0);
  id(select_power_priority).preset("SBU Battery");
  power_mode();
  CHECK_EQ(prio(), std::string("Utility First"));  // documented quirk, §3
  at(12, 0);
  power_mode();
  CHECK_EQ(prio(), std::string("SBU Battery"));
}

TEST(power_mode, tariff_hour_boundaries) {
  struct { int h, m; const char *want; } cases[] = {
      {22, 59, "SBU Battery"}, {23, 0, "Utility First"}, {23, 59, "Utility First"},
      {0, 0, "Utility First"}, {6, 59, "Utility First"}, {7, 0, "SBU Battery"},
      {12, 0, "SBU Battery"},
  };
  for (auto &c : cases) {
    // Start from the opposite answer so a "no change" cannot pass by accident.
    id(select_power_priority).preset(std::string(c.want) == "SBU Battery" ? "Utility First" : "SBU Battery");
    at(c.h, c.m, c.m == 59 ? 59 : 0);
    power_mode();
    if (prio() != c.want)
      g_fail.push_back("at " + std::to_string(c.h) + ":" + std::to_string(c.m) + " got " + prio() + ", want " + c.want);
  }
}

TEST(power_mode, tariff_invalid_clock_falls_back_to_utility) {
  id(select_power_priority).preset("SBU Battery");
  id(sntp_time).set_invalid();
  power_mode();
  CHECK_EQ(prio(), std::string("Utility First"));
  CHECK_EQ(queue(), (Q{"POP00"}));
}

TEST(power_mode, tariff_off_protection_on_is_utility) {
  id(switch_auto_tariff).preset(false);
  id(select_power_priority).preset("SBU Battery");
  power_mode();
  CHECK_EQ(prio(), std::string("Utility First"));
}

TEST(power_mode, both_off_leaves_manual_choice) {
  id(switch_auto_tariff).preset(false);
  id(switch_auto_protection).preset(false);
  for (const char *p : {"SBU Battery", "Solar First", "Utility First"}) {
    id(select_power_priority).preset(p);
    power_mode();
    CHECK_EQ(prio(), std::string(p));
  }
  CHECK(queue().empty());
}

TEST(power_mode, already_on_target_sends_nothing) {
  at(1, 0);
  power_mode();
  CHECK(queue().empty());
  CHECK(fw_events.size() == 1);  // just the script run itself
}

// --- rule 1b: outage pre-charge --------------------------------------------
TEST(power_mode, precharge_beats_day_tariff) {
  until(15, 0);
  id(select_power_priority).preset("SBU Battery");
  power_mode();
  CHECK_EQ(prio(), std::string("Utility First"));
}

TEST(power_mode, protection_beats_precharge) {
  until(15, 0);
  grid_bad(true);
  power_mode();
  CHECK_EQ(prio(), std::string("SBU Battery"));
}

TEST(power_mode, precharge_switch_off_ignores_deadline) {
  until(15, 0);
  id(switch_precharge_enable).preset(false);
  power_mode();
  CHECK_EQ(prio(), std::string("SBU Battery"));
}

TEST(power_mode, precharge_deadline_edges) {
  struct { int h, m, s, day, y; bool active; const char *what; } cases[] = {
      {12, 0, 0, 2, 2026, false, "exactly now"},
      {12, 0, 1, 2, 2026, true, "one second ahead"},
      {11, 59, 59, 2, 2026, false, "one second ago"},
      {0, 0, 0, 1, 2099, true, "far future"},
      {0, 0, 0, 1, 2000, false, "2000-01-01 release value"},
  };
  for (auto &c : cases) {
    id(dt_precharge_until).preset(c.y, 10, c.day, c.h, c.m, c.s);
    if (c.y == 2000) id(dt_precharge_until).reset();
    id(select_power_priority).preset("SBU Battery");
    power_mode();
    bool active = prio() == "Utility First";
    if (active != c.active) g_fail.push_back(std::string("deadline ") + c.what + ": active=" + show(active));
  }
}

TEST(power_mode, precharge_across_midnight) {
  at(23, 30);
  id(dt_precharge_until).preset(2026, 10, 3, 1, 0, 0);
  id(switch_auto_tariff).preset(false);
  id(switch_auto_protection).preset(false);
  id(select_power_priority).preset("SBU Battery");
  power_mode();
  CHECK_EQ(prio(), std::string("Utility First"));
}

TEST(power_mode, precharge_needs_valid_clock) {
  // Manual mode, so only rule 1b could change anything.
  id(switch_auto_tariff).preset(false);
  id(switch_auto_protection).preset(false);
  id(select_power_priority).preset("SBU Battery");
  until(15, 0);
  id(sntp_time).set_invalid();
  power_mode();
  CHECK_EQ(prio(), std::string("SBU Battery"));
  at(12, 0);
  power_mode();
  CHECK_EQ(prio(), std::string("Utility First"));
}

// ============================================================================
// evaluate_charge_window: the night-only gate
// ============================================================================
TEST(charge_window, night_only_off_never_touches_charger) {
  for (int h : {2, 12, 23}) {
    at(h, 0);
    id(switch_bms_charging).preset(h == 12);
    charge_window();
  }
  id(sntp_time).set_invalid();
  id(switch_bms_charging).preset(false);
  charge_window();
  CHECK_EQ(count(BMS_ON) + count(BMS_OFF), 0);
}

TEST(charge_window, night_only_hour_boundaries) {
  id(switch_night_charging).preset(true);
  struct { int h, m; bool open; } cases[] = {
      {22, 59, false}, {23, 0, true}, {0, 0, true}, {6, 59, true}, {7, 0, false}, {12, 0, false},
  };
  for (auto &c : cases) {
    id(switch_bms_charging).preset(!c.open);
    at(c.h, c.m);
    charge_window();
    if (id(switch_bms_charging).state != c.open)
      g_fail.push_back("at " + std::to_string(c.h) + ":" + std::to_string(c.m) + " charger " +
                       show(id(switch_bms_charging).state));
  }
}

TEST(charge_window, already_correct_writes_nothing) {
  id(switch_night_charging).preset(true);
  at(1, 0);
  charge_window();
  at(13, 0);
  id(switch_bms_charging).preset(false);
  charge_window();
  CHECK_EQ(count(BMS_ON) + count(BMS_OFF), 0);
}

TEST(charge_window, invalid_clock_fails_open) {
  id(switch_night_charging).preset(true);
  id(switch_bms_charging).preset(false);
  id(sntp_time).set_invalid();
  charge_window();
  CHECK(id(switch_bms_charging).state);
  CHECK_EQ(count(BMS_ON), 1);
}

TEST(charge_window, lost_ble_write_is_retried_next_tick) {
  id(switch_night_charging).preset(true);
  id(switch_bms_charging).follow_writes = false;
  at(12, 0);
  interval_5min();
  interval_5min();
  CHECK_EQ(count(BMS_OFF), 2);
  id(switch_bms_charging).follow_writes = true;
  interval_5min();
  interval_5min();
  CHECK_EQ(count(BMS_OFF), 3);
  CHECK(!id(switch_bms_charging).state);
}

// ============================================================================
// Outage pre-charge edges (evaluate_charge_window)
// ============================================================================
TEST(precharge, start_saves_current_and_runs_power_mode_once) {
  id(select_max_charge).preset("30");
  id(switch_bms_charging).preset(false);
  until(15, 0);
  charge_window();
  CHECK(id(precharge_was_active));
  CHECK_EQ(id(precharge_saved_current), 30);
  CHECK_EQ(count(RUN_PM), 1);
  CHECK_EQ(prio(), std::string("Utility First"));
  CHECK(id(switch_bms_charging).state);
  // Steady state: no second power evaluation, no new writes.
  fw_events.clear();
  charge_window();
  CHECK_EQ(count(RUN_PM), 0);
  CHECK_EQ(fw_events.size(), (size_t) 1);
}

TEST(precharge, end_restores_user_current) {
  id(select_max_charge).preset("30");
  until(15, 0);
  charge_window();
  id(select_max_charge).make_call().set_option("60").perform();  // HA steers
  clear_effects();
  at(15, 0);  // deadline reached; the 5 min interval notices
  interval_5min();
  CHECK(!id(precharge_was_active));
  CHECK_EQ(id(precharge_saved_current), -1);
  CHECK_EQ(id(select_max_charge).state, std::string("30"));
  CHECK_EQ(queue(), (Q{"MUCHGC030", "POP02"}));
  CHECK_EQ(prio(), std::string("SBU Battery"));  // day tariff takes it back
  CHECK(index_of("select_max_charge.set(30)") < index_of(RUN_PM));
}

TEST(precharge, end_restores_lowest_option_02) {
  id(select_max_charge).preset("02");
  until(15, 0);
  charge_window();
  id(select_max_charge).preset("60");
  until(11, 0);
  charge_window();
  CHECK_EQ(id(select_max_charge).state, std::string("02"));
  CHECK_EQ(count("select_max_charge.set(02)"), 1);
  CHECK_EQ(queue(), (Q{"MUCHGC002", "POP02"}));  // then the day tariff's priority
}

TEST(precharge, end_restores_highest_option_60) {
  id(select_max_charge).preset("60");
  until(15, 0);
  charge_window();
  id(select_max_charge).preset("10");
  until(11, 0);
  charge_window();
  CHECK_EQ(id(select_max_charge).state, std::string("60"));
}

TEST(precharge, switch_off_ends_it_at_once) {
  id(select_max_charge).preset("20");
  until(15, 0);
  charge_window();
  id(select_max_charge).preset("50");
  clear_effects();
  id(switch_precharge_enable).turn_off();
  CHECK(!id(precharge_was_active));
  CHECK_EQ(id(select_max_charge).state, std::string("20"));
  CHECK_EQ(count(RUN_CW), 1);
  CHECK_EQ(count(RUN_PM), 1);
}

TEST(precharge, release_value_from_ha_ends_it) {
  id(select_max_charge).preset("20");
  id(dt_precharge_until).set(2026, 10, 2, 15, 0, 0);  // on_value runs the script
  CHECK(id(precharge_was_active));
  id(dt_precharge_until).set(2000, 1, 1, 0, 0, 0);
  CHECK(!id(precharge_was_active));
  CHECK_EQ(count(RUN_CW), 2);
}

TEST(precharge, overrides_night_only_by_day_then_hands_back) {
  id(switch_night_charging).preset(true);
  id(switch_bms_charging).preset(false);
  until(15, 0);
  charge_window();
  CHECK(id(switch_bms_charging).state);
  interval_5min();  // still active: the gate must not close it
  CHECK_EQ(count(BMS_OFF), 0);
  at(15, 5);
  interval_5min();  // ended by day: the gate closes the charger in the same run
  CHECK(!id(switch_bms_charging).state);
  CHECK_EQ(count(BMS_OFF), 1);
}

TEST(precharge, night_only_switched_off_while_active_leaves_charger_on) {
  id(switch_night_charging).preset(true);
  until(15, 0);
  charge_window();
  id(switch_night_charging).turn_off();
  CHECK(id(switch_bms_charging).state);
  at(15, 5);
  interval_5min();
  CHECK(id(switch_bms_charging).state);
  CHECK_EQ(count(BMS_OFF), 0);
}

TEST(precharge, bad_grid_protection_wins_but_charger_opens) {
  grid_bad(true);
  id(switch_bms_charging).preset(false);
  until(15, 0);
  charge_window();
  CHECK_EQ(prio(), std::string("SBU Battery"));
  CHECK(id(switch_bms_charging).state);
}

TEST(precharge, invalid_clock_never_starts) {
  until(15, 0);
  id(sntp_time).set_invalid();
  charge_window();
  CHECK(!id(precharge_was_active));
  CHECK_EQ(count(RUN_PM), 0);
}

TEST(precharge, reboot_mid_charge_with_valid_clock_is_not_a_new_start) {
  // Restored globals: active, user had 30 A; HA has since set 60 A.
  id(precharge_was_active) = true;
  id(precharge_saved_current) = 30;
  id(select_max_charge).preset("60");
  until(15, 0);
  charge_window();
  CHECK_EQ(id(precharge_saved_current), 30);
  CHECK_EQ(count(RUN_PM), 0);
  CHECK(queue().empty());
}

TEST(precharge, reboot_mid_charge_with_invalid_clock_keeps_user_current) {
  // Replay-time evaluations run before NTP: the pre-charge reads as ended and
  // the user's current comes back; when the clock arrives it restarts and must
  // save the user's 30 A, never HA's 60 A.
  id(precharge_was_active) = true;
  id(precharge_saved_current) = 30;
  id(select_max_charge).preset("60");
  until(15, 0);
  id(sntp_time).set_invalid();
  charge_window();
  CHECK_EQ(id(select_max_charge).state, std::string("30"));
  at(12, 0);
  charge_window();
  CHECK(id(precharge_was_active));
  CHECK_EQ(id(precharge_saved_current), 30);
}

TEST(precharge, end_without_saved_current_still_hands_back_priority) {
  id(precharge_was_active) = true;
  id(precharge_saved_current) = -1;
  id(select_power_priority).preset("Utility First");
  charge_window();
  CHECK_EQ(count("select_max_charge.set(10)"), 0);
  CHECK_EQ(id(select_max_charge).state, std::string("10"));
  CHECK_EQ(count(RUN_PM), 1);
  CHECK_EQ(prio(), std::string("SBU Battery"));
}

// ============================================================================
// Switch handlers, interlocks and triggers
// ============================================================================
TEST(interlock, auto_tariff_on_turns_night_only_off_and_hands_back_charger) {
  id(switch_auto_tariff).preset(false);
  id(switch_night_charging).preset(true);
  id(switch_bms_charging).preset(false);
  id(switch_auto_tariff).turn_on();
  CHECK(!id(switch_night_charging).state);
  CHECK(id(switch_bms_charging).state);
  CHECK_EQ(count(RUN_PM), 1);
  CHECK_EQ(prio(), std::string("SBU Battery"));
}

TEST(interlock, night_only_on_turns_tariff_off) {
  id(select_power_priority).preset("SBU Battery");
  id(switch_night_charging).turn_on();
  CHECK(!id(switch_auto_tariff).state);
  CHECK_EQ(prio(), std::string("Utility First"));  // rule 5 via tariff's on_turn_off
  CHECK(!id(switch_bms_charging).state);           // day: gate closes
  CHECK(index_of(RUN_PM) >= 0 && index_of(RUN_PM) < index_of(RUN_CW));
}

TEST(interlock, night_only_on_without_tariff_leaves_priority) {
  id(switch_auto_tariff).preset(false);
  id(switch_auto_protection).preset(false);
  id(select_power_priority).preset("SBU Battery");
  id(switch_night_charging).turn_on();
  CHECK_EQ(count(RUN_PM), 0);
  CHECK_EQ(prio(), std::string("SBU Battery"));
  CHECK_EQ(count(RUN_CW), 1);
}

TEST(interlock, tariff_on_with_night_only_already_off_touches_nothing_else) {
  id(switch_auto_tariff).preset(false);
  id(switch_auto_tariff).turn_on();
  CHECK_EQ(count("switch_night_charging.turn_off"), 0);
  CHECK_EQ(count(BMS_ON), 0);
}

TEST(interlock, night_only_off_by_day_hands_charger_back) {
  id(switch_night_charging).preset(true);
  id(switch_bms_charging).preset(false);
  id(switch_night_charging).turn_off();
  CHECK(id(switch_bms_charging).state);
  CHECK_EQ(count(BMS_ON), 1);
}

TEST(interlock, restore_replay_before_boot_gate_does_not_force_charger) {
  fw_reset();  // fresh boot: nothing published yet
  fw_events.clear();
  id(switch_bms_charging).preset(false);  // user turned charging off on purpose
  CHECK(!id(restore_replay_done));
  id(switch_night_charging).publish_state(false);  // replay of restored OFF
  CHECK_EQ(count(BMS_ON), 0);
  CHECK(!id(switch_bms_charging).state);
  // The same OFF after on_boot set the flag is a real user action.
  id(restore_replay_done) = true;
  id(switch_night_charging).preset(true);
  id(switch_night_charging).turn_off();
  CHECK_EQ(count(BMS_ON), 1);
}

TEST(interlock, repeated_turn_off_fires_nothing) {
  id(switch_night_charging).turn_off();  // already off: publish_dedup_
  CHECK_EQ(count(BMS_ON), 0);
}

TEST(interlock, protection_toggle_reevaluates) {
  grid_bad(true);
  id(switch_auto_protection).preset(false);
  id(switch_auto_protection).turn_on();
  CHECK_EQ(prio(), std::string("SBU Battery"));
  at(2, 0);
  id(switch_auto_protection).turn_off();
  CHECK_EQ(prio(), std::string("Utility First"));
  CHECK_EQ(count(RUN_PM), 2);
}

TEST(interlock, precharge_switch_runs_charge_window_both_ways) {
  id(switch_precharge_enable).turn_off();
  id(switch_precharge_enable).turn_on();
  CHECK_EQ(count(RUN_CW), 2);
}

TEST(triggers, tariff_boundaries_run_both_scripts_in_order) {
  at(7, 0);
  id(select_power_priority).preset("Utility First");
  time_sntp_time_on_time_7();
  CHECK_EQ(prio(), std::string("SBU Battery"));
  CHECK(index_of(RUN_PM) == 0 && index_of(RUN_CW) > index_of(RUN_PM));
  fw_events.clear();
  at(23, 0);
  time_sntp_time_on_time_23();
  CHECK_EQ(prio(), std::string("Utility First"));
  CHECK(index_of(RUN_PM) == 0 && index_of(RUN_CW) > index_of(RUN_PM));
}

TEST(triggers, grid_fault_and_recovery_reevaluate) {
  id(grid_safe).reset();
  id(grid_safe).publish_state(true);  // first state, trigger_on_initial_state
  CHECK_EQ(prio(), std::string("SBU Battery"));
  at(2, 0);
  id(grid_safe).publish_state(false);
  CHECK_EQ(prio(), std::string("Utility First"));
  CHECK_EQ(count(RUN_PM), 2);
}

// ============================================================================
// Select / number on_value: PI30 command formatting
// ============================================================================
TEST(commands, max_charge_every_option) {
  const char *opts[] = {"02", "10", "20", "30", "40", "50", "60"};
  const char *cmds[] = {"MUCHGC002", "MUCHGC010", "MUCHGC020", "MUCHGC030", "MUCHGC040", "MUCHGC050", "MUCHGC060"};
  for (int i = 0; i < 7; i++) {
    clear_effects();
    id(select_max_charge).make_call().set_option(opts[i]).perform();
    CHECK_EQ(queue(), (Q{cmds[i]}));
    CHECK_EQ(id(command_retries), 20);
  }
}

TEST(commands, max_charge_unknown_option_rejected) {
  for (const char *o : {"05", "0", "100", "", "70"}) id(select_max_charge).make_call().set_option(o).perform();
  CHECK(queue().empty());
  CHECK_EQ(id(select_max_charge).state, std::string("10"));
}

TEST(commands, max_charge_padding_of_short_values) {
  // The lambda pads whatever it gets; feed it directly to cover 1-3 digits.
  select_max_charge_on_value("2");
  select_max_charge_on_value("100");
  CHECK_EQ(queue(), (Q{"MUCHGC002", "MUCHGC100"}));
}

TEST(commands, power_priority_mapping) {
  for (const char *o : {"Utility First", "Solar First", "SBU Battery"})
    id(select_power_priority).make_call().set_option(o).perform();
  CHECK_EQ(queue(), (Q{"POP00", "POP01", "POP02"}));
}

TEST(commands, ac_input_mode_mapping) {
  id(select_inverter_mode).make_call().set_option("UPS").perform();
  id(select_inverter_mode).make_call().set_option("APL").perform();
  CHECK_EQ(queue(), (Q{"PGR01", "PGR00"}));
}

TEST(commands, same_option_twice_is_queued_twice) {
  id(select_max_charge).make_call().set_option("30").perform();
  id(select_max_charge).make_call().set_option("30").perform();
  CHECK_EQ(queue(), (Q{"MUCHGC030", "MUCHGC030"}));
}

TEST(commands, retry_counter_primed_only_when_idle) {
  // The counter belongs to the command at the front; queuing behind it
  // leaves it alone, queuing into an empty queue primes the full 20.
  id(command_queue).push_back("POP02");
  id(command_retries) = 7;
  id(select_inverter_mode).make_call().set_option("UPS").perform();
  CHECK_EQ(id(command_retries), 7);
  clear_effects();
  id(select_inverter_mode).make_call().set_option("APL").perform();
  CHECK_EQ(id(command_retries), 20);
}

TEST(commands, exhausted_front_is_not_primed_by_a_push) {
  id(command_queue).push_back("PBFT28.4");
  id(command_retries) = 0;  // front used its last try
  id(select_max_charge).make_call().set_option("30").perform();
  CHECK_EQ(id(command_retries), 0);
  CHECK_EQ(queue(), (Q{"PBFT28.4", "MUCHGC030"}));
}

TEST(commands, bulk_and_float_bounds) {
  id(num_float_voltage).preset(24.0f);
  CHECK(id(num_bulk_voltage).set(24.0f));
  CHECK(id(num_bulk_voltage).set(29.0f));
  CHECK(id(num_float_voltage).set(24.0f));
  CHECK(id(num_float_voltage).set(28.5f));
  CHECK_EQ(queue(), (Q{"PCVV24.0", "PCVV29.0", "PBFT24.0", "PBFT28.5"}));
  clear_effects();
  CHECK(!id(num_bulk_voltage).set(29.1f));   // NumberCall range check
  CHECK(!id(num_float_voltage).set(23.9f));
  CHECK(queue().empty());
}

TEST(commands, every_step_formats_with_one_decimal) {
  id(num_float_voltage).preset(24.0f);
  for (int k = 240; k <= 290; k++) {
    clear_effects();
    float v = k / 10.0f;
    id(num_bulk_voltage).set(v);
    char want[16];
    snprintf(want, sizeof(want), "PCVV%d.%d", k / 10, k % 10);
    if (queue() != Q{want}) g_fail.push_back("bulk " + show(v) + " -> " + show(queue()));
  }
  id(num_bulk_voltage).preset(29.0f);
  for (int k = 240; k <= 285; k++) {
    clear_effects();
    float v = k / 10.0f;
    id(num_float_voltage).set(v);
    char want[16];
    snprintf(want, sizeof(want), "PBFT%d.%d", k / 10, k % 10);
    if (queue() != Q{want}) g_fail.push_back("float " + show(v) + " -> " + show(queue()));
  }
}

TEST(commands, off_step_values_round) {
  id(num_float_voltage).preset(24.0f);
  id(num_bulk_voltage).set(27.25f);   // exact binary tie: round-half-even
  id(num_bulk_voltage).set(27.26f);
  id(num_bulk_voltage).set(27.249f);
  id(num_bulk_voltage).set(28.96f);   // rounds up to the max
  CHECK_EQ(queue(), (Q{"PCVV27.2", "PCVV27.3", "PCVV27.2", "PCVV29.0"}));
}

TEST(commands, bulk_below_float_refused) {
  id(num_bulk_voltage).set(27.1f);  // float is 27.2
  CHECK(queue().empty());
  id(num_bulk_voltage).set(27.2f);  // equal is fine
  CHECK_EQ(queue(), (Q{"PCVV27.2"}));
}

TEST(commands, float_above_bulk_refused) {
  id(num_float_voltage).set(28.1f);  // bulk is 28.0
  CHECK(queue().empty());
  id(num_float_voltage).set(28.0f);
  CHECK_EQ(queue(), (Q{"PBFT28.0"}));
}

TEST(commands, unknown_other_side_does_not_block) {
  id(num_float_voltage).preset(NAN);
  id(num_bulk_voltage).set(24.0f);
  id(num_bulk_voltage).preset(NAN);
  id(num_float_voltage).set(28.5f);
  CHECK_EQ(queue(), (Q{"PCVV24.0", "PBFT28.5"}));
}

TEST(commands, refused_voltage_does_not_stick_as_entity_state) {
  // Fixed: the refusal used to return from on_value after the optimistic
  // number had already published the value, so the entity showed a voltage
  // the inverter never got and the other slider's check compared against it.
  id(num_bulk_voltage).set(27.0f);  // below float 27.2: refused
  CHECK(queue().empty());
  CHECK_EQ(id(num_bulk_voltage).state, 28.0f);
  id(num_float_voltage).set(27.1f);  // inverter bulk is really 28.0: valid
  CHECK_EQ(queue(), (Q{"PBFT27.1"}));
  CHECK_EQ(id(num_float_voltage).state, 27.1f);
}

TEST(commands, refused_float_keeps_accepted_value) {
  id(num_float_voltage).set(28.3f);  // above bulk 28.0
  CHECK(queue().empty());
  CHECK_EQ(id(num_float_voltage).state, 27.2f);
}

TEST(commands, accepted_voltage_is_saved_for_the_next_boot) {
  id(num_bulk_voltage).set(28.4f);
  App.scheduler.run();
  CHECK_EQ(id(num_bulk_voltage).saved, 28.4f);
  CHECK(App.scheduler.pending.empty());
}

TEST(commands, refused_voltage_is_written_back_to_flash_without_resending) {
  // control() saves the refused value after set_action; the deferred
  // write-back puts the accepted one back and must not queue anything.
  id(num_bulk_voltage).set(28.4f);
  id(num_float_voltage).set(27.0f);
  clear_effects();
  id(num_bulk_voltage).set(26.0f);   // refused
  id(num_float_voltage).set(28.9f);  // refused (above max of float: range check)
  id(num_float_voltage).set(28.5f);  // refused (above bulk 28.4)
  CHECK_EQ(id(num_bulk_voltage).saved, 26.0f);  // what control() left behind
  CHECK_EQ(id(num_float_voltage).saved, 28.5f);
  CHECK_EQ(App.scheduler.pending.size(), (size_t) 2);
  App.scheduler.run();
  CHECK_EQ(id(num_bulk_voltage).saved, 28.4f);
  CHECK_EQ(id(num_float_voltage).saved, 27.0f);
  CHECK_EQ(id(num_bulk_voltage).state, 28.4f);
  CHECK_EQ(id(num_float_voltage).state, 27.0f);
  CHECK(queue().empty());
  CHECK(App.scheduler.pending.empty());
  // The write-back does not block the next real change.
  id(num_bulk_voltage).set(28.6f);
  CHECK_EQ(queue(), (Q{"PCVV28.6"}));
}

TEST(commands, boot_replays_the_accepted_voltages) {
  id(num_bulk_voltage).set(28.4f);
  id(num_bulk_voltage).set(27.0f);  // refused
  App.scheduler.run();
  clear_effects();
  id(num_bulk_voltage).boot();      // TemplateNumber::setup, in YAML order
  id(num_float_voltage).boot();
  CHECK_EQ(queue(), (Q{"PCVV28.4", "PBFT27.2"}));
  CHECK_EQ(id(command_retries), 20);
}

// ============================================================================
// UART dispatcher (3 s interval) and reply loop (50 ms interval)
// ============================================================================
static std::string frame_cmd(const std::vector<uint8_t> &f) { return std::string(f.begin(), f.end() - 3); }
static bool is_qpigs(const std::vector<uint8_t> &f) {
  return f == std::vector<uint8_t>{0x51, 0x50, 0x49, 0x47, 0x53, 0xB7, 0xA9, 0x0D};
}
static int sends_of(const std::string &cmd) {
  int n = 0;
  for (auto &f : id(uart_0).tx) if (!is_qpigs(f) && f.size() == cmd.size() + 3 && frame_cmd(f) == cmd) n++;
  return n;
}
static int polls() {
  int n = 0;
  for (auto &f : id(uart_0).tx) n += is_qpigs(f);
  return n;
}
static void push(const std::string &cmd) {  // what every producer does
  id(command_queue).push_back(cmd);
  if (id(command_queue).size() == 1) id(command_retries) = 20;
}
static void rx(const std::string &s) { id(uart_0).feed(s); interval_50ms(); }
static const std::string ACK = std::string("(ACK") + "\x39\x20" + "\r";
static const std::string NAK = std::string("(NAK") + "\x73\x73" + "\r";

TEST(dispatcher, idle_sends_qpigs_every_tick) {
  for (int i = 0; i < 3; i++) interval_3s();
  CHECK_EQ(polls(), 3);
  CHECK_EQ(id(uart_0).tx.size(), (size_t) 3);
  CHECK(!id(poll_turn));
}

TEST(dispatcher, commands_and_polls_alternate) {
  push("POP02");
  for (int i = 0; i < 6; i++) interval_3s();
  auto &tx = id(uart_0).tx;
  CHECK_EQ(tx.size(), (size_t) 6);
  for (size_t i = 0; i < tx.size(); i++)
    if (is_qpigs(tx[i]) != (i % 2 == 1)) g_fail.push_back("tick " + std::to_string(i) + " out of turn");
  CHECK_EQ(id(command_retries), 17);
}

TEST(dispatcher, crc_matches_known_pi30_values) {
  struct { const char *cmd; uint8_t hi, lo; } known[] = {
      {"QPIGS", 0xB7, 0xA9}, {"QPIRI", 0xF8, 0x54}, {"QMOD", 0x49, 0xC1},
  };
  for (auto &k : known) {
    id(uart_0).reset();
    id(command_queue).clear();
    id(poll_turn) = false;
    id(command_retries) = 0;
    push(k.cmd);
    interval_3s();
    auto &f = id(uart_0).tx.at(0);
    std::vector<uint8_t> want(k.cmd, k.cmd + strlen(k.cmd));
    want.push_back(k.hi); want.push_back(k.lo); want.push_back(0x0D);
    if (f != want) g_fail.push_back(std::string("CRC of ") + k.cmd);
  }
}

TEST(dispatcher, crc_never_emits_reserved_bytes) {
  std::vector<std::string> cmds = {"POP00", "POP01", "POP02", "PGR00", "PGR01", "QPIGS", "QPIRI", "QMOD"};
  for (int i = 0; i <= 999; i++) { char b[16]; snprintf(b, sizeof b, "MUCHGC%03d", i); cmds.push_back(b); }
  for (int k = 200; k <= 300; k++) {
    char b[16];
    snprintf(b, sizeof b, "PCVV%d.%d", k / 10, k % 10); cmds.push_back(b);
    snprintf(b, sizeof b, "PBFT%d.%d", k / 10, k % 10); cmds.push_back(b);
  }
  int bad = 0;
  for (auto &c : cmds) {
    id(uart_0).reset();
    id(command_queue).clear();
    id(poll_turn) = false;
    id(command_retries) = 0;
    push(c);
    interval_3s();
    auto &f = id(uart_0).tx.at(0);
    uint8_t hi = f[f.size() - 3], lo = f[f.size() - 2];
    for (uint8_t b : {hi, lo})
      if (b == 0x28 || b == 0x0D || b == 0x0A) bad++;
  }
  CHECK_EQ(bad, 0);
}

TEST(dispatcher, ack_pops_and_primes_next) {
  push("POP02");
  push("MUCHGC030");
  interval_3s();
  rx(ACK);
  CHECK_EQ(queue(), (Q{"MUCHGC030"}));
  CHECK_EQ(id(command_retries), 20);
  interval_3s();  // poll turn
  interval_3s();
  CHECK_EQ(sends_of("MUCHGC030"), 1);
  rx(ACK);
  CHECK(queue().empty());
  CHECK_EQ(id(command_retries), 0);
}

TEST(dispatcher, silence_gets_twenty_tries_while_polls_continue) {
  push("PCVV28.0");
  for (int i = 0; i < 60; i++) interval_3s();
  CHECK_EQ(sends_of("PCVV28.0"), 20);
  CHECK(queue().empty());
  CHECK(polls() >= 20);
}

TEST(dispatcher, nak_cuts_retries_to_two) {
  push("PBFT28.4");
  interval_3s();
  rx(NAK);
  CHECK_EQ(id(command_retries), 2);
  CHECK_EQ(queue(), (Q{"PBFT28.4"}));
  for (int i = 0; i < 20; i++) {
    interval_3s();
    if (!id(uart_0).tx.empty() && !is_qpigs(id(uart_0).tx.back())) rx(NAK);
  }
  CHECK_EQ(sends_of("PBFT28.4"), 3);
  CHECK(queue().empty());
}

TEST(dispatcher, nak_never_raises_a_low_counter) {
  push("POP00");
  id(command_retries) = 1;
  rx(NAK);
  CHECK_EQ(id(command_retries), 1);
}

TEST(dispatcher, nak_then_ack_on_retry_pops) {
  push("POP00");
  interval_3s();
  rx(NAK);
  interval_3s();
  interval_3s();
  rx(ACK);
  CHECK(queue().empty());
  CHECK_EQ(sends_of("POP00"), 2);
}

TEST(dispatcher, give_up_primes_next_command) {
  push("PCVV28.0");
  push("POP02");
  for (int i = 0; i < 200; i++) interval_3s();
  CHECK_EQ(sends_of("PCVV28.0"), 20);
  CHECK_EQ(sends_of("POP02"), 20);
  CHECK(queue().empty());
}

TEST(dispatcher, stray_ack_with_empty_queue_is_harmless) {
  rx(ACK);
  CHECK(queue().empty());
  CHECK_EQ(id(command_retries), 0);
}

TEST(dispatcher, push_during_last_try_does_not_revive_refused_command) {
  // Fixed: producers used to prime the counter with `if (command_retries ==
  // 0)`, reading 0 as "queue idle". But 0 also means "front command has used
  // its last try and gives up on its next turn", so a command queued in that
  // 3-6 s window handed the refused command 20 fresh tries, undoing the NAK
  // cut to 2. They now prime only when their command is the front.
  push("PBFT28.4");
  interval_3s();
  rx(NAK);  // cut to 2
  for (int i = 0; i < 4; i++) {
    interval_3s();
    if (!is_qpigs(id(uart_0).tx.back())) rx(NAK);
  }
  CHECK_EQ(sends_of("PBFT28.4"), 3);
  CHECK_EQ(id(command_retries), 0);  // last try spent, give-up is next
  id(select_max_charge).make_call().set_option("30").perform();  // e.g. HA steering
  for (int i = 0; i < 60; i++) interval_3s();
  CHECK_EQ(sends_of("PBFT28.4"), 3);
  CHECK_EQ(sends_of("MUCHGC030"), 20);
}

// --- reply parsing ----------------------------------------------------------
static std::string qpigs_reply(const char *grid, const char *out, const char *watt, const char *batt) {
  std::string p = std::string(grid) + " 49.9 " + out + " 49.9 0230 " + watt +
                  " 004 405 " + batt + " 005 100 0039 0000 000.0 00.00 00003 00010101 00 00 00000 010";
  return "(" + p + "\x11\x22" + "\r";
}

TEST(reply, qpigs_publishes_sensors) {
  rx(qpigs_reply("231.5", "230.1", "0161", "27.10"));
  CHECK(id(sns_grid_v).has_state());
  CHECK_EQ(id(sns_grid_v).state, 231.5f);
  CHECK_EQ(id(sns_grid_f).state, 49.9f);
  CHECK_EQ(id(sns_out_v).state, 230.1f);
  CHECK_EQ(id(sns_watt).state, 161.0f);
  CHECK_EQ(id(sns_load_pct).state, 4.0f);
  CHECK_EQ(id(sns_batt_v).state, 27.1f);
  CHECK_EQ(id(sns_batt_charge_a).state, 5.0f);
  CHECK_EQ(id(sns_batt_discharge_a).state, 3.0f);
}

TEST(reply, emi_sanity_bounds) {
  id(sns_grid_v).reset();
  rx(qpigs_reply("300.1", "230.0", "0161", "27.10"));
  rx(qpigs_reply("230.0", "300.1", "0161", "27.10"));
  rx(qpigs_reply("230.0", "230.0", "15001", "27.10"));
  rx(qpigs_reply("230.0", "230.0", "0161", "09.99"));
  CHECK(!id(sns_grid_v).has_state());
  rx(qpigs_reply("300.0", "300.0", "15000", "10.00"));  // all exactly at the limits
  CHECK_EQ(id(sns_grid_v).state, 300.0f);
  CHECK_EQ(id(sns_watt).state, 15000.0f);
}

TEST(reply, short_or_truncated_frames_ignored) {
  id(sns_grid_v).reset();
  rx("(230.0 49.9 230.0\r");
  rx("(230.0 49.9 230.0 49.9 0230 0161 004 405 27.10 005 100 0039\x11\x22\r");  // 12 fields
  rx("230.0 49.9 230.0 49.9 0230 0161 004 405 27.10 005 100 0039 0000 000.0 00.00 00003 00010101\r");
  CHECK(!id(sns_grid_v).has_state());
}

TEST(reply, frame_split_across_ticks) {
  std::string f = qpigs_reply("222.0", "230.0", "0100", "26.50");
  rx(f.substr(0, 30));
  CHECK_EQ(id(sns_grid_v).state, 230.0f);  // unchanged from baseline
  rx(f.substr(30));
  CHECK_EQ(id(sns_grid_v).state, 222.0f);
}

TEST(reply, overflow_drops_garbage_then_recovers) {
  rx(std::string(450, 'x') + "\r");
  rx(qpigs_reply("219.0", "230.0", "0100", "26.50"));
  CHECK_EQ(id(sns_grid_v).state, 219.0f);
}

TEST(reply, ack_ends_the_tick) {
  push("POP02");
  interval_3s();
  id(uart_0).feed(ACK + qpigs_reply("210.0", "230.0", "0100", "26.50"));
  interval_50ms();
  CHECK(queue().empty());
  CHECK_EQ(id(sns_grid_v).state, 230.0f);  // data waits for the next tick
  interval_50ms();
  CHECK_EQ(id(sns_grid_v).state, 210.0f);
}

// ============================================================================
// Grid health and calculated sensors
// ============================================================================
TEST(grid, unsafe_thresholds) {
  id(sns_grid_v).reset();
  CHECK(!grid_safe_lambda().has_value());
  CHECK(!grid_in_range_lambda().has_value());
  struct { float v; bool unsafe; } cases[] = {
      {0.0f, true}, {185.0f, true}, {185.1f, false}, {230.0f, false}, {249.9f, false}, {250.0f, true}, {280.0f, true},
  };
  for (auto &c : cases) {
    id(sns_grid_v).publish_state(c.v);
    if (*grid_safe_lambda() != c.unsafe) g_fail.push_back("grid_safe at " + show(c.v));
  }
}

TEST(grid, in_range_is_exact_inverse_of_unsafe) {
  for (int k = 1500; k <= 2800; k++) {
    id(sns_grid_v).publish_state(k / 10.0f);
    if (*grid_in_range_lambda() == *grid_safe_lambda()) g_fail.push_back("disagree at " + show(k / 10.0f));
  }
}

TEST(grid, real_power) {
  CHECK(std::isnan(*sns_grid_real_power_lambda()));  // BMS power missing
  id(sns_watt).publish_state(400);
  id(sns_bms_power).publish_state(0);
  id(sns_batt_charge_a).publish_state(0);
  CHECK_EQ(*sns_grid_real_power_lambda(), 430.0f);
  id(sns_bms_power).publish_state(-2.0f);   // not below -2: still grid
  CHECK_EQ(*sns_grid_real_power_lambda(), 430.0f);
  id(sns_bms_power).publish_state(-2.5f);
  CHECK_EQ(*sns_grid_real_power_lambda(), 0.0f);
  id(sns_batt_charge_a).publish_state(10);
  id(sns_bms_power).publish_state(500);
  CHECK_EQ(*sns_grid_real_power_lambda(), 930.0f);
  id(sns_grid_v).publish_state(149.9f);
  CHECK_EQ(*sns_grid_real_power_lambda(), 0.0f);
  id(sns_grid_v).publish_state(150.0f);
  CHECK_EQ(*sns_grid_real_power_lambda(), 930.0f);
}

TEST(uptime, accumulates_with_carry_and_survives_millis_wrap) {
  // The lambda keeps static state between calls: sync once, then measure deltas.
  fake_millis_value = 1000000;
  interval_60s();
  uint32_t base = id(total_uptime_sec);
  fake_millis_value += 60500;
  interval_60s();
  CHECK_EQ(id(total_uptime_sec) - base, 60u);
  fake_millis_value += 60500;
  interval_60s();
  CHECK_EQ(id(total_uptime_sec) - base, 121u);  // two half seconds carried
  fake_millis_value = 0xFFFFFFFFu - 29999u;      // just before the 49.7-day wrap
  interval_60s();
  base = id(total_uptime_sec);
  fake_millis_value += 60000u;                   // wraps to 30000
  interval_60s();
  CHECK_EQ(id(total_uptime_sec) - base, 60u);
  CHECK_EQ(*sns_total_uptime_lambda(), (float) (id(total_uptime_sec) / 86400.0));
}

// ============================================================================
int main() {
  fw_wire();
  int passed = 0, failed = 0, known = 0, known_fixed = 0;
  for (auto &t : registry()) {
    baseline();
    g_fail.clear();
    std::string err;
    try {
      t.fn();
    } catch (const std::exception &e) {
      g_fail.push_back(std::string("exception: ") + e.what());
    }
    bool known_bug = std::string(t.group).rfind("KNOWN_BUG", 0) == 0;
    if (g_fail.empty()) {
      if (known_bug) {
        known_fixed++;
        printf("KNOWN-BUG FIXED?  %s.%s passes now - move it to a normal group\n", t.group, t.name);
      } else {
        passed++;
      }
      continue;
    }
    if (known_bug) known++;
    else failed++;
    printf("%s %s.%s\n", known_bug ? "KNOWN-BUG (still present)" : "FAIL", t.group, t.name);
    for (auto &f : g_fail) printf("    %s\n", f.c_str());
  }
  printf("\n%d lambdas extracted from power-station.yaml\n", FW_LAMBDA_COUNT);
  printf("%zu tests: %d passed, %d failed, %d known bug(s) still present, %d known bug(s) passing\n",
         registry().size(), passed, failed, known, known_fixed);
  return failed ? 1 : 0;
}
