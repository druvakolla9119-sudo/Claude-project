// ESP32 + MQ-2 smoke sensor -> Sensor Report System (/api/ingest).
//
// What it does
//   * Warms up the MQ-2 heater, then calibrates R0 in clean air once and saves it in flash (NVS),
//     so a reboot during a fire never "calibrates" against smoke.
//   * Samples every second, converts the reading to smoke ppm with the MQ-2 datasheet curve.
//   * Drives a local buzzer + LED alarm (with hysteresis), which works even when Wi-Fi is down.
//   * Detects a disconnected/shorted sensor (reported as sensor_fault, LED blinks fast).
//   * Reports every 30 s, and immediately whenever the alarm turns on or off.
//   * Buffers reports while the server is unreachable and sends them later (needs NTP time).
//
// Board: any ESP32 dev board, Arduino-ESP32 core 2.x or 3.x. No extra libraries needed.
//
// Wiring (typical MQ-2 breakout board with VCC / GND / DO / AO pins)
//   MQ-2 VCC -> 5V (VIN)        The heater needs 5 V (~150 mA). 3.3 V is NOT enough.
//   MQ-2 GND -> GND
//   MQ-2 AO  -> 10k -> GPIO34 -> 20k -> GND
//               AO swings up to 5 V; the ESP32 ADC only tolerates 3.3 V, so the divider is required.
//               (If you use other resistor values, change DIVIDER_RATIO below.)
//   Buzzer (active, +) -> GPIO25,  LED (+, via 220R) -> GPIO26   (both return to GND)
//   Recalibrate: press the BOOT button (GPIO0) while the LED blinks during warm-up, in clean air.
//
// Register the device on the server first (returns the API key, shown once):
//   curl -X POST http://<server>:3000/api/devices -H "Authorization: Bearer $ADMIN_TOKEN"
//     -H "Content-Type: application/json" -d '{
//     "id": "smoke-01", "name": "Smoke sensor", "type": "smoke-sensor", "location": "Kitchen",
//     "channels": [
//       { "channel": "smoke_ppm",     "unit": "ppm", "minValid": 0, "maxValid": 10000 },
//       { "channel": "smoke_ppm_max", "unit": "ppm", "minValid": 0, "maxValid": 10000 },
//       { "channel": "alarm",         "unit": "" ,   "minValid": 0, "maxValid": 1 },
//       { "channel": "rs_r0",         "unit": "" },
//       { "channel": "sensor_fault",  "unit": "" ,   "minValid": 0, "maxValid": 1 },
//       { "channel": "rssi",          "unit": "dBm" } ] }'

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <time.h>
#include <math.h>

// ---------------------------------------------------------------- settings you must change
const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-password";
const char* API_URL   = "http://192.168.1.10:3000/api/ingest";   // https:// is supported too
const char* API_KEY   = "sk_dev_...";                            // from POST /api/devices
// For https: paste the server's root CA certificate here (PEM). nullptr = encrypted but unverified.
const char* ROOT_CA   = nullptr;

// ---------------------------------------------------------------- hardware
const int   MQ2_PIN        = 34;     // ADC1 pin (ADC2 pins do not work while Wi-Fi is on)
const int   BUZZER_PIN     = 25;
const int   LED_PIN        = 26;
const int   CAL_BUTTON_PIN = 0;      // BOOT button; press during warm-up to recalibrate
const float DIVIDER_RATIO  = 1.5f;   // (10k + 20k) / 20k  -> sensor volts = pin volts * 1.5
const float MQ2_VCC        = 5.0f;   // module supply voltage
const float RL_KOHM        = 1.0f;   // load resistor on the module (usually "102" = 1k). Only
                                     // affects the printed Rs; ppm uses Rs/R0 so RL cancels out.

// ---------------------------------------------------------------- behaviour
const uint32_t WARMUP_MS        = 60UL * 1000;   // heater warm-up after power-on
const uint32_t SAMPLE_MS        = 1000;          // sample period
const uint32_t REPORT_MS        = 30UL * 1000;   // normal report period
const float    ALARM_ON_PPM     = 400.0f;        // alarm when smoke >= this ...
const float    ALARM_OFF_PPM    = 250.0f;        // ... and clear when it falls below this
const int      ALARM_CONFIRM    = 3;             // consecutive samples needed to change state
const float    CLEAN_AIR_RATIO  = 9.83f;         // Rs/R0 in clean air (MQ-2 datasheet)
// MQ-2 smoke curve (datasheet, log-log line): passes through (200 ppm, Rs/R0 = 3.4)
// and (10000 ppm, Rs/R0 = 0.6).
const float    CURVE_X0 = log10f(200.0f),  CURVE_Y0 = log10f(3.4f);
const float    CURVE_SLOPE = (log10f(0.6f) - log10f(3.4f)) / (log10f(10000.0f) - log10f(200.0f));
const float    MAX_PPM = 10000.0f;               // top of the sensor's range

// ---------------------------------------------------------------- state
struct Report { uint32_t ts; float avgPpm; float maxPpm; uint8_t alarm; uint8_t fault; bool hasPpm; float ratio; int rssi; };
const int QUEUE_LEN = 60;                        // ~30 min of reports at 30 s
Report   queue[QUEUE_LEN];
int      queueHead = 0, queueCount = 0;

Preferences prefs;
float    r0 = 0;                                 // sensor resistance in clean air (kOhm)
bool     alarmOn = false;
bool     sensorFault = false;                    // any faulty sample in the current report period
float    lastVolts = 0;
int      alarmVotes = 0;
float    sumPpm = 0, maxPpm = 0, lastRatio = 0;
int      samples = 0;
uint32_t lastSample = 0, lastReport = 0;

// ---------------------------------------------------------------- sensor maths
float readSensorVolts() {
  uint32_t mv = 0;
  for (int i = 0; i < 32; i++) { mv += analogReadMilliVolts(MQ2_PIN); delayMicroseconds(500); }
  lastVolts = (mv / 32.0f) / 1000.0f * DIVIDER_RATIO;
  return lastVolts;
}

// AO stuck at ~0 V means the sensor is unplugged (or the heater is dead); stuck at the supply
// means a short. A broken smoke sensor must never look like clean air.
bool voltsLookFaulty(float v) { return v < 0.02f || v > MQ2_VCC - 0.05f; }

// Sensor resistance in kOhm from the voltage across the load resistor
float readRs() {
  float v = readSensorVolts();
  if (v < 0.01f) v = 0.01f;                      // avoid divide-by-zero with a disconnected sensor
  return RL_KOHM * (MQ2_VCC - v) / v;
}

float ratioToPpm(float ratio) {
  if (ratio <= 0) return MAX_PPM;
  float ppm = powf(10.0f, (log10f(ratio) - CURVE_Y0) / CURVE_SLOPE + CURVE_X0);
  if (ppm < 0) ppm = 0;
  if (ppm > MAX_PPM) ppm = MAX_PPM;
  return ppm;
}

void calibrate() {
  Serial.println("Calibrating R0 in clean air, keep the sensor away from smoke...");
  float sum = 0;
  for (int i = 0; i < 50; i++) { sum += readRs(); delay(100); }
  r0 = (sum / 50.0f) / CLEAN_AIR_RATIO;
  prefs.putFloat("r0", r0);
  Serial.printf("R0 = %.3f kOhm (saved)\n", r0);
}

// ---------------------------------------------------------------- alarm output
void toggleLed() {
  static bool on = false;
  on = !on;
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

void setAlarmOutputs(bool on) {
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

// Returns true when the alarm state changed
bool updateAlarm(float ppm) {
  bool wantChange = alarmOn ? (ppm < ALARM_OFF_PPM) : (ppm >= ALARM_ON_PPM);
  alarmVotes = wantChange ? alarmVotes + 1 : 0;
  if (alarmVotes < ALARM_CONFIRM) return false;
  alarmVotes = 0;
  alarmOn = !alarmOn;
  setAlarmOutputs(alarmOn);
  Serial.printf(">>> ALARM %s (%.0f ppm)\n", alarmOn ? "ON" : "OFF", ppm);
  return true;
}

// ---------------------------------------------------------------- networking
bool timeValid() { return time(nullptr) > 1700000000; }

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  static uint32_t lastTry = 0;
  if (millis() - lastTry > 10000) {             // retry every 10 s without blocking the alarm loop
    lastTry = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
}

void appendReport(String& body, const Report& r) {
  body += "{";
  if (r.ts) body += "\"ts\":" + String(r.ts) + ",";   // no ts -> server receive time is used
  if (r.hasPpm) {                                     // no valid sample -> no ppm, never a fake 0
    body += "\"smoke_ppm\":" + String(r.avgPpm, 1);
    body += ",\"smoke_ppm_max\":" + String(r.maxPpm, 1);
    body += ",\"rs_r0\":" + String(r.ratio, 3) + ",";
  }
  body += "\"alarm\":" + String(r.alarm);
  body += ",\"sensor_fault\":" + String(r.fault);
  body += ",\"rssi\":" + String(r.rssi) + "}";
}

// POSTs every queued report in one JSON array. Returns true if the server stored them.
bool sendQueue() {
  if (!queueCount || WiFi.status() != WL_CONNECTED) return false;

  String body = "[";
  for (int i = 0; i < queueCount; i++) {
    if (i) body += ",";
    appendReport(body, queue[(queueHead + i) % QUEUE_LEN]);
  }
  body += "]";

  WiFiClient plain;
  WiFiClientSecure secure;
  bool https = strncmp(API_URL, "https://", 8) == 0;
  if (https) { if (ROOT_CA) secure.setCACert(ROOT_CA); else secure.setInsecure(); }

  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(https ? (WiFiClient&)secure : plain, API_URL)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  int status = http.POST(body);
  String resp = http.getString();
  http.end();
  Serial.printf("POST %d report(s) -> %d %s\n", queueCount, status, resp.c_str());

  // 200 = stored (or duplicate of a retry). 4xx other than 429 means the data or key is wrong and
  // resending will never help, so drop it instead of blocking the queue forever.
  if (status == 200 || (status >= 400 && status < 500 && status != 429)) {
    if (status == 401 || status == 403) Serial.println("Check API_KEY and that the device is active.");
    queueHead = 0; queueCount = 0;
    return status == 200;
  }
  return false;                                  // network error / 429 / 5xx: keep and retry
}

void queueReport() {
  Report r;
  r.ts = timeValid() ? (uint32_t)time(nullptr) : 0;
  r.hasPpm = samples > 0;
  r.avgPpm = samples ? sumPpm / samples : 0;
  r.maxPpm = maxPpm;
  r.alarm = alarmOn ? 1 : 0;
  r.fault = sensorFault ? 1 : 0;
  r.ratio = lastRatio;
  r.rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  sumPpm = 0; maxPpm = 0; samples = 0; sensorFault = false;

  // Without a real clock, old reports would get the wrong (server) time, so keep only the latest.
  if (!r.ts) { queueHead = 0; queueCount = 0; }
  if (queueCount == QUEUE_LEN) { queueHead = (queueHead + 1) % QUEUE_LEN; queueCount--; }  // drop oldest
  queue[(queueHead + queueCount) % QUEUE_LEN] = r;
  queueCount++;
  sendQueue();
}

// ---------------------------------------------------------------- main
void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(CAL_BUTTON_PIN, INPUT_PULLUP);
  setAlarmOutputs(false);
  analogReadResolution(12);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  bool forceCal = false;
  prefs.begin("smoke", false);
  r0 = prefs.getFloat("r0", 0);

  Serial.printf("Warming up MQ-2 heater for %lu s (press BOOT now to recalibrate)...\n",
                (unsigned long)(WARMUP_MS / 1000));
  uint32_t start = millis();
  while (millis() - start < WARMUP_MS) {           // blink LED while warming up
    digitalWrite(LED_PIN, (millis() / 500) % 2);
    if (digitalRead(CAL_BUTTON_PIN) == LOW && !forceCal) { forceCal = true; Serial.println("Recalibration requested"); }
    delay(50);
  }
  digitalWrite(LED_PIN, LOW);

  readRs();
  while (voltsLookFaulty(lastVolts)) {             // never calibrate against a missing sensor
    Serial.printf("Sensor fault (AO = %.2f V). Check wiring and the 5 V supply.\n", lastVolts);
    toggleLed();
    delay(1000);
    readRs();
  }
  digitalWrite(LED_PIN, LOW);
  if (forceCal || r0 <= 0 || isnan(r0)) calibrate();
  else Serial.printf("Using saved R0 = %.3f kOhm\n", r0);

  lastReport = millis();
}

void loop() {
  ensureWifi();

  if (millis() - lastSample >= SAMPLE_MS) {
    lastSample = millis();
    float rs = readRs();
    if (voltsLookFaulty(lastVolts)) {
      // Reading is meaningless: keep the alarm state as it is and report the fault instead
      sensorFault = true;
      if (!alarmOn) toggleLed();                  // 1 Hz blink = sensor fault
      Serial.printf("SENSOR FAULT: AO = %.2f V\n", lastVolts);
    } else {
      lastRatio = rs / r0;
      float ppm = ratioToPpm(lastRatio);
      sumPpm += ppm; samples++;
      if (ppm > maxPpm) maxPpm = ppm;
      if (!alarmOn) digitalWrite(LED_PIN, LOW);
      Serial.printf("Rs=%.2fk Rs/R0=%.2f smoke=%.0f ppm%s\n", rs, lastRatio, ppm, alarmOn ? " [ALARM]" : "");

      if (updateAlarm(ppm)) {                      // report alarm changes right away
        queueReport();
        lastReport = millis();
      }
    }
  }

  if (millis() - lastReport >= REPORT_MS) {
    lastReport = millis();
    queueReport();
  } else if (queueCount && WiFi.status() == WL_CONNECTED) {
    static uint32_t lastRetry = 0;                 // retry buffered reports every 15 s
    if (millis() - lastRetry > 15000) { lastRetry = millis(); sendQueue(); }
  }

  delay(10);
}
