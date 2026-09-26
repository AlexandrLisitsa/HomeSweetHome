"""The rooms the dashboard knows, and where things sit in them. One list for every tool.

A room is found in the model by any plan point inside it (cm, plan y pointing down).
LIGHTS are the lamps that get a light-only overlay: the photo each is lit in
(renders/<key>.png, taken by render.sh), its room, and a brightness gain that needs no
re-render. SPOTS are the plan points (x, y, height) where dashboard icons go.
An A/C's `flow` names its piece in the model: the card draws its air leaving the unit.
"""

ROOMS = {
    "kitchen":  {"name": "Kitchen",     "point": (665, 450)},
    "hallway":  {"name": "Hallway",     "point": (300, 700)},
    "bedroom":  {"name": "Bedroom",     "point": (630, 690)},
    "living":   {"name": "Living room", "point": (400, 968)},
    "bathroom": {"name": "Bathroom",    "point": (330, 370)},
    # Behind the entrance door; HA calls this area "vestibule".
    "vestibule": {"name": "Vestibule",  "point": (130, 630)},
}

LIGHTS = {
    "kitchen_led":     {"room": "kitchen",  "gain": 0.75},
    "kitchen_ceiling": {"room": "kitchen",  "gain": 1.17},  # the ceiling lamps: their shapes
    "hallway":         {"room": "hallway",  "gain": 0.83},  # are specks in the render copy, and
    "bathroom":        {"room": "bathroom", "gain": 0.83},  # no longer block ~20% of their light
    "living_tv":       {"room": "living",   "gain": 1.0},   # the screen's glow
}

# Icons float at the height given: a point on a floor the walls hide would land on the
# wall in front of it, which is why badges sit mid-room at 130 cm.
SPOTS = {
    "kitchen_ceiling":   (665.3, 451.6, 244.0),
    "kitchen_led":       (650.0, 386.0, 145.0),
    "kitchen_climate":   (560.0, 450.0, 130.0),
    "hallway_light":     (299.0, 610.0, 120.0),   # the bulb is at 209; that reads as the next room
    "bathroom_light":    (340.0, 375.0, 150.0),
    # Both A/Cs hang on the wall between the bedroom and the living room, back to back.
    # At their real height their icons would sit over that wall and read as the other
    # room's, so they are pulled half a metre into their own room, each with its plug
    # beside it rather than under its label.
    "bedroom_ac":        (842.0, 760.0, 150.0),
    "bedroom_ac_plug":   (842.0, 700.0, 110.0),
    "bedroom_router":    (860.0, 640.0, 90.0),
    "bedroom_climate":   (600.0, 686.0, 130.0),
    "living_ac":         (725.0, 870.0, 150.0),
    "living_ac_plug":    (680.0, 935.0, 110.0),
    "living_tv":         (713.0, 1110.0, 133.0),
    "living_climate":    (403.5, 1030.0, 130.0),
    # South of the entrance door: left of it, seen from the hallway.
    "inverter":          (205.0, 737.0, 138.0),
    "inverter_battery":  (205.0, 780.0, 110.0),
}

# What the dashboard shows, room by room. `spot` is a SPOTS key; a light names its
# overlay (a LIGHTS key); a device may name a `value` entity to show as its reading.
ITEMS = [
    # Kitchen
    {"kind": "light", "room": "kitchen", "spot": "kitchen_ceiling", "overlay": "kitchen_ceiling",
     "entity": "light.kitchen_relay", "name": "Ceiling", "icon": "mdi:ceiling-light"},
    {"kind": "light", "room": "kitchen", "spot": "kitchen_led", "overlay": "kitchen_led",
     "entity": "light.0xa4c1385443844c1e", "name": "LED strip", "icon": "mdi:led-strip-variant"},
    {"kind": "badge", "room": "kitchen", "spot": "kitchen_climate",
     "entities": ["sensor.0xa4c1383900dd497c_temperature", "sensor.0xa4c1383900dd497c_humidity"]},
    # Hallway
    {"kind": "light", "room": "hallway", "spot": "hallway_light", "overlay": "hallway",
     "entity": "light.hallway_relay", "name": "Light", "icon": "mdi:lightbulb"},
    # Bathroom: one relay, both downlights
    {"kind": "light", "room": "bathroom", "spot": "bathroom_light", "overlay": "bathroom",
     "entity": "light.bathroom_relay", "name": "Light", "icon": "mdi:lightbulb-group"},
    # Bedroom
    {"kind": "device", "room": "bedroom", "spot": "bedroom_ac",
     "entity": "climate.153931629566331_climate", "name": "A/C", "icon": "mdi:air-conditioner",
     "flow": "Bedroom A/C"},
    {"kind": "device", "room": "bedroom", "spot": "bedroom_ac_plug",
     "entity": "switch.0xa4c13820fe9ec412", "value": "sensor.0xa4c13820fe9ec412_power",
     "name": "A/C plug", "icon": "mdi:power-socket-eu"},
    {"kind": "device", "room": "bedroom", "spot": "bedroom_router",
     "entity": "sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_download_speed",
     "name": "Router", "icon": "mdi:router-wireless"},
    {"kind": "badge", "room": "bedroom", "spot": "bedroom_climate",
     "entities": ["sensor.0xa4c138437ae3f5a6_temperature", "sensor.0xa4c138437ae3f5a6_humidity"]},
    # Living room. Its ceiling lamp is not in HA, so it is only furniture in the model.
    {"kind": "device", "room": "living", "spot": "living_ac",
     "entity": "climate.daewoo_a_c", "name": "A/C", "icon": "mdi:air-conditioner",
     "flow": "Living room A/C"},
    {"kind": "device", "room": "living", "spot": "living_ac_plug",
     "entity": "switch.0x70b3d52b600fddcb", "value": "sensor.0x70b3d52b600fddcb_power",
     "name": "A/C plug", "icon": "mdi:power-socket-eu"},
    # The TV is a light too: its screen glows blue on the plan while it is on.
    {"kind": "light", "room": "living", "spot": "living_tv", "overlay": "living_tv",
     "entity": "media_player.samsung_7_series_43_ue43nu7090", "name": "TV", "icon": "mdi:television",
     "color": [90, 156, 255]},
    {"kind": "badge", "room": "living", "spot": "living_climate",
     "entities": ["sensor.0xa4c13858c97f07f8_temperature", "sensor.0xa4c13858c97f07f8_humidity"]},
    # Vestibule: the power station
    {"kind": "device", "room": "vestibule", "spot": "inverter",
     "entity": "sensor.powmr_inverter_ac_output_power", "name": "Inverter output", "icon": "mdi:flash"},
    {"kind": "device", "room": "vestibule", "spot": "inverter_battery",
     "entity": "sensor.jkbms_gateway_bms_state_of_charge", "name": "Battery", "icon": "mdi:home-battery"},
]
