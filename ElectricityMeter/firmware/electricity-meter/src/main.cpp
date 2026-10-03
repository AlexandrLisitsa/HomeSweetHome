// ElectricityMeter: count the meter's imp/kWh LED and tell Home Assistant.
//
// Samples analogRead(A0) 100 times a second. Each sample goes through the
// blink detector (detector.h), which counts meter pulses into the register
// (meterPulses) -- kept through restarts by persist.cpp and reported to Home
// Assistant over MQTT by mqtt_link.cpp.
//
// Stage one's raw view is still here, for tuning at the meter. The samples go
// into a ring buffer, served two ways:
//
//   http://<board>/          a live graph and log, sized for a phone held at
//                            the meter
//   http://<board>/samples   the same samples as JSON, for anything else
//
// It still prints every sample over USB serial too, one bare integer a line,
// so the bench workflow from before (monitor, Serial Plotter) is unchanged.
// Lines that start with '#' are status, not samples.
//
// NO SAMPLE MAY BE LOST: this is a meter. So sampling is not done in loop(),
// where the web server would hold it up -- answering a request waits on the
// network, and a sample taken in loop() was skipped or late every few
// requests. It runs from a Ticker instead. On the ESP8266 a Ticker is an SDK
// os_timer: its callback runs whenever the sketch yields to the system, and
// the web server and WiFi yield all the time while they wait. (It is not a
// hardware interrupt, which is why analogRead() is safe to call from it.)
// Serial and HTTP only read the ring the timer fills; when they fall behind
// they catch up, they never skip. Neither may sit in a loop that does not
// yield for longer than a slot, or the timer cannot fire: that is why serial
// output is metered to the UART's free space and HTTP replies are capped.

#include <Arduino.h>
#include <ArduinoOTA.h>
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>
#include <Ticker.h>

#include "config.h"
#include "meter.h"
#include "mqtt_link.h"
#include "persist.h"

static const uint8_t SENSOR_PIN = A0;
static const uint32_t BAUD = 115200;

// 100 Hz, and no faster: that is the ceiling WiFi allows. The ESP8266's ADC
// is shared with the radio's calibration, and reading it every 2, 4 or 5 ms
// kept the board from ever joining WiFi; started after the join, 2 ms
// knocked it off again within seconds. 10 ms holds.
//
// The meter (NIK 2102) is 6400 imp/kWh and the supply is limited to 6 kW, so
// at most it blinks 10.7 times a second, one blink every 94 ms: nine samples a
// period.
// What 100 Hz cannot promise is a sample inside a flash shorter than 10 ms.
// This meter's flash turned out to be about 30 ms, three samples (see
// data/golden/README.md), so it can.
// (SAMPLE_INTERVAL_MS itself lives in meter.h: it is the detector's clock.)

// About forty seconds of history, 8 KB of the 80 KB there is. A phone polling
// four times a second needs only the last quarter of a second; the rest is
// slack for a phone that went to sleep or a WiFi hiccup.
static const uint16_t RING_SIZE = 4096;

// The most a /samples reply carries. Building the JSON does not yield, so the
// timer cannot fire while it runs: keep it well inside one slot. A
// client further behind than that asks again at once.
static const uint16_t MAX_REPLY = 250;

// Values only, no timestamps: sample n was taken n slots after sample 0. That
// holds exactly as long as no slot is missed, and missedSlots below is the
// board's own proof that none was.
static uint16_t ringValue[RING_SIZE];
uint32_t sampleCount = 0;          // samples taken since boot; the ring's seq
static uint32_t printedCount = 0;  // how far the serial output has got

// The proof that nothing was lost, kept by the board rather than inferred
// from the output. Each sample notes micros(); a gap of more than one and a
// half slots since the previous one counts as missed slots.
static Ticker sampler;
static uint32_t lastSampleUs = 0;
uint32_t missedSlots = 0;
uint32_t longestGapUs = 0;

Detector detector;
uint32_t meterPulses = 0;
static Settings settings;

static ESP8266WebServer server(80);
static bool wifiWasUp = false;

static const char PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ElectricityMeter</title>
<style>
:root{--bg:#fff;--fg:#111;--mut:#666;--line:#0a6cff;--grid:#ddd;--pane:#f4f4f4}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#999;--line:#5aa2ff;--grid:#333;--pane:#1c1c1c}}
*{box-sizing:border-box}
body{margin:0;padding:12px 16px;background:var(--bg);color:var(--fg);font:15px system-ui,sans-serif}
h1{font-size:17px;margin:0 0 8px}
#st{font-size:13px;color:var(--mut);margin-bottom:8px}
#meter{font-size:15px;margin-bottom:6px;font-variant-numeric:tabular-nums}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px}
.stats div{background:var(--pane);border-radius:8px;padding:6px;text-align:center}
.stats b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.stats span{font-size:11px;color:var(--mut)}
canvas{width:100%;height:220px;display:block;background:var(--pane);border-radius:8px}
.bar{display:flex;gap:8px;margin:8px 0}
button{flex:1;padding:10px;font-size:15px;border-radius:8px;border:1px solid var(--grid);background:var(--pane);color:var(--fg)}
#log{height:40vh;overflow-y:auto;background:var(--pane);border-radius:8px;padding:6px 8px;
font:12px ui-monospace,monospace;white-space:pre;margin:0}
</style></head><body>
<h1>ElectricityMeter &middot; raw A0</h1>
<div id="meter"></div>
<div id="st">connecting&hellip;</div>
<div class="stats">
<div><b id="now">&ndash;</b><span>now</span></div>
<div><b id="min">&ndash;</b><span>min 10 s</span></div>
<div><b id="max">&ndash;</b><span>max 10 s</span></div>
<div><b id="pp">&ndash;</b><span>max&minus;min</span></div>
</div>
<canvas id="c"></canvas>
<div class="bar"><button id="pause">Pause</button><button id="scale">Scale: auto</button><button id="clear">Clear log</button></div>
<pre id="log"></pre>
<script>
const WINDOW=10000, LOGMAX=1000;
let seq=0, more=false, T=[], V=[], paused=false, full=false, lines=[];
const $=id=>document.getElementById(id), cv=$('c'), cx=cv.getContext('2d');
function note(s){lines.push('# '+s);}
function fmt(t){return (t/1000).toFixed(3).padStart(10)+' s';}
async function poll(){
  try{
    const r=await fetch('/samples?since='+seq,{cache:'no-store'}), j=await r.json();
    if(j.total<seq){note('board restarted');T=[];V=[];}
    else if(seq&&j.from>seq){note('phone fell behind, '+(j.from-seq)+' samples not shown');}
    seq=j.seq;more=j.seq<j.total;
    for(let i=0;i<j.v.length;i++){
      const t=(j.from+i)*j.interval;
      T.push(t);V.push(j.v[i]);
      if(!paused)lines.push(fmt(t)+'  '+String(j.v[i]).padStart(4));
    }
    const cut=T.length?T[T.length-1]-WINDOW:0;
    while(T.length&&T[0]<cut){T.shift();V.shift();}
    $('st').textContent='online · up '+Math.round(j.up/1000)+' s · WiFi '+j.rssi+' dBm · missed '+j.missed+' · longest gap '+(j.gap/1000).toFixed(1)+' ms';
    $('st').style.color=j.missed?'#d33':'';
    $('meter').textContent=(j.pulses/6400).toFixed(4)+' kWh · '+j.watts+' W · levels on '+j.on+' / off '+j.off;
  }catch(e){more=false;$('st').textContent='offline, retrying…';}
  if(!paused)render();
  setTimeout(poll,more?0:250);
}
function render(){
  if(lines.length>LOGMAX)lines.splice(0,lines.length-LOGMAX);
  const lg=$('log');lg.textContent=lines.join('\n');lg.scrollTop=lg.scrollHeight;
  if(!V.length)return;
  let lo=Math.min(...V), hi=Math.max(...V);
  $('now').textContent=V[V.length-1];$('min').textContent=lo;$('max').textContent=hi;$('pp').textContent=hi-lo;
  if(full){lo=0;hi=1023;}else{const pad=Math.max(10,(hi-lo)*0.1);lo-=pad;hi+=pad;}
  const d=devicePixelRatio||1, w=cv.clientWidth*d, h=cv.clientHeight*d;
  cv.width=w;cv.height=h;
  const t1=T[T.length-1], t0=t1-WINDOW, x=t=>(t-t0)/WINDOW*w, y=v=>h-(v-lo)/(hi-lo)*h;
  cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--grid');cx.lineWidth=d;
  for(let s=1;s<10;s++){cx.beginPath();cx.moveTo(s*w/10,0);cx.lineTo(s*w/10,h);cx.stroke();}
  cx.fillStyle=getComputedStyle(document.body).getPropertyValue('--fg');cx.font=(11*d)+'px sans-serif';
  cx.fillText(Math.round(hi),4*d,12*d);cx.fillText(Math.round(lo),4*d,h-4*d);
  cx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--line');cx.lineWidth=1.5*d;cx.beginPath();
  for(let i=0;i<V.length;i++){const X=x(T[i]),Y=y(V[i]);i?cx.lineTo(X,Y):cx.moveTo(X,Y);}
  cx.stroke();
}
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'Resume':'Pause';if(paused)note('paused');};
$('scale').onclick=()=>{full=!full;$('scale').textContent='Scale: '+(full?'0-1023':'auto');render();};
$('clear').onclick=()=>{lines=[];render();};
poll();
</script></body></html>
)HTML";

static void handleSamples() {
  // ?since=<seq> returns every sample from that one on, or as many as the
  // ring still holds. "from" says where it really started, so a client that
  // fell behind can tell it missed some.
  //
  // "seq" is the number to ask for next. When it is less than "total" the
  // reply was capped and there is more waiting.
  uint32_t total = sampleCount;
  uint32_t since = server.hasArg("since") ? server.arg("since").toInt() : 0;
  uint32_t oldest = total > RING_SIZE ? total - RING_SIZE : 0;
  uint32_t from = since;
  if (from < oldest || from > total) {
    from = oldest;
  }
  uint32_t to = min(total, from + MAX_REPLY);

  String body;
  body.reserve(160 + (to - from) * 5);
  body += F("{\"seq\":");
  body += to;
  body += F(",\"total\":");
  body += total;
  body += F(",\"from\":");
  body += from;
  body += F(",\"up\":");
  body += millis();
  body += F(",\"rssi\":");
  body += WiFi.RSSI();
  body += F(",\"missed\":");
  body += missedSlots;
  body += F(",\"gap\":");
  body += longestGapUs;
  body += F(",\"interval\":");
  body += SAMPLE_INTERVAL_MS;
  body += F(",\"pulses\":");
  body += meterPulses;
  body += F(",\"watts\":");
  body += lroundf(meterWatts());
  body += F(",\"on\":");
  body += settings.onLevel;
  body += F(",\"off\":");
  body += settings.offLevel;
  body += F(",\"v\":[");
  for (uint32_t i = from; i < to; i++) {
    if (i != from) body += ',';
    body += ringValue[i % RING_SIZE];
  }
  body += F("]}");

  server.sendHeader(F("Cache-Control"), F("no-store"));
  server.send(200, F("application/json"), body);
}

// Runs from the Ticker, in the system context. Short on purpose: one ADC
// read, the detector and a few stores. No Serial, no allocation.
static void sample() {
  uint32_t nowUs = micros();
  uint16_t value = analogRead(SENSOR_PIN);
  uint32_t skipped = 0;

  if (sampleCount > 0) {
    uint32_t gapUs = nowUs - lastSampleUs;
    if (gapUs > longestGapUs) {
      longestGapUs = gapUs;
    }
    const uint32_t slotUs = SAMPLE_INTERVAL_MS * 1000;
    if (gapUs > slotUs + slotUs / 2) {
      skipped = (gapUs + slotUs / 2) / slotUs - 1;
      missedSlots += skipped;
    }
  }
  lastSampleUs = nowUs;

  // sampleCount is this sample's index and missedSlots the slots lost so far:
  // together, the slot this sample belongs to.
  if (detector.feed(sampleCount + missedSlots, value, skipped)) {
    meterPulses++;
    persistPulse(meterPulses);
  }

  ringValue[sampleCount % RING_SIZE] = value;
  sampleCount++;
}

// Serial lags the timer by however long loop() was busy, then catches up.
// If it fell a whole ring behind -- only possible with loop() stuck for
// forty seconds -- it says so instead of printing samples that were
// overwritten.
//
// It writes only what the UART has room for. A write into a full UART spins
// without yielding until there is room, and while it spins the sampling
// timer cannot fire: a backlog printed in one go is exactly how samples
// would go missing.
static void printSamples() {
  uint32_t total = sampleCount;
  if (total - printedCount > RING_SIZE) {
    Serial.printf("# serial fell behind, %u samples not printed\n",
                  (unsigned)(total - printedCount - RING_SIZE));
    printedCount = total - RING_SIZE;
  }
  while (printedCount < total && Serial.availableForWrite() >= 6) {
    Serial.println(ringValue[printedCount % RING_SIZE]);
    printedCount++;
  }
}

static void reportWifi() {
  bool up = WiFi.status() == WL_CONNECTED;
  if (up == wifiWasUp) {
    return;
  }
  wifiWasUp = up;
  if (up) {
    Serial.printf("# WiFi up: http://%s/  (http://%s.local/)  RSSI %d dBm\n",
                  WiFi.localIP().toString().c_str(), HOSTNAME, WiFi.RSSI());
  } else {
    Serial.println(F("# WiFi down, retrying"));
  }
}

void setup() {
  Serial.begin(BAUD);
  Serial.println();
  Serial.printf("# ElectricityMeter %s, one sample every %u ms\n", FW_VERSION,
                (unsigned)SAMPLE_INTERVAL_MS);

  persistBegin(meterPulses, settings);
  detector.onLevel = settings.onLevel;
  detector.offLevel = settings.offLevel;
  Serial.printf("# register %lu pulses, levels on %u off %u\n",
                (unsigned long)meterPulses, settings.onLevel, settings.offLevel);

  // The radio disturbs the ADC whenever it transmits; that is the price of
  // watching from a phone. Modem sleep would make it quieter between
  // transmissions but slow every reply to the phone, so the radio stays awake.
  WiFi.mode(WIFI_STA);
  WiFi.hostname(HOSTNAME);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // ArduinoOTA also starts mDNS under HOSTNAME, which is what makes
  // electricity-meter.local resolve; the web page is advertised alongside it.
  ArduinoOTA.setHostname(HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() {
    Serial.println(F("# OTA update starting"));
    persistSaveNow(meterPulses, settings);
  });
  ArduinoOTA.begin();
  MDNS.addService("http", "tcp", 80);

  server.on("/", []() { server.send_P(200, "text/html", PAGE); });
  server.on("/samples", handleSamples);
  server.begin();

  mqttBegin(&settings);

  sampler.attach_ms(SAMPLE_INTERVAL_MS, sample);
}

void loop() {
  printSamples();
  reportWifi();
  ArduinoOTA.handle();
  server.handleClient();
  mqttLoop();
  persistLoop(meterPulses, settings);
}
