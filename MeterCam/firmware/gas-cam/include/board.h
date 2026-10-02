// The AI-Thinker ESP32-CAM's wiring to its OV2640.
//
// Fixed by the module, not chosen by anyone here, which is why it lives apart
// from config.h's choices. RESET is not
// brought out on this board and so is -1 rather than a pin.
#pragma once

#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// The module's high-power flash, beside the lens. Not used as a light -- see
// the lights section of config.h -- but it is on the board whether anyone
// wants it or not, so the firmware holds it LOW: left floating, its
// transistor's gate drifts and the LED glows.
#define FLASH_LED_GPIO_NUM 4
