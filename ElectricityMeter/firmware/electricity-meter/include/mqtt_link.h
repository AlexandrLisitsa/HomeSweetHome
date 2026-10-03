// Home Assistant over MQTT, through the Mosquitto add-on.
//
// The board announces itself with MQTT discovery, so Home Assistant creates
// one device, "Electricity meter", with six entities and no YAML:
//
//   sensor.electricity_meter_energy           kWh, total_increasing
//   sensor.electricity_meter_power            W
//   number.electricity_meter_reading          set the register to the display
//   number.electricity_meter_threshold_on     detector levels, tunable live
//   number.electricity_meter_threshold_off
//   button.electricity_meter_restart
//
// Topics, under the board's HOSTNAME (electricity-meter):
//
//   <host>/status        online / offline, retained; offline is the LWT
//   <host>/state         retained JSON, checked every 10 s and sent only if it
//                        changed, plus after every command and (re)connect:
//                        energy (kWh), power (W), pulses, uncertain, missed,
//                        on, off, set (register set yet?)
//   <host>/set/reading   kWh -> register
//   <host>/set/on        0-1023, must stay above off
//   <host>/set/off       0-1023, must stay below on
//   <host>/restart       any payload
//
// The energy sensor stays unavailable until the register has been set from
// Home Assistant ("Meter reading"); see Settings::registerSet.
//
// Counting never waits on any of this. A broker that is down only means
// nothing is delivered until it is back; reconnects are tried every 5 s.
#pragma once

#include "persist.h"

void mqttBegin(Settings* settings);
void mqttLoop();

// Publish the state now, outside the 10 s rhythm.
void mqttPublishState();
