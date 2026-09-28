// ESP32 example: reads an analog current sensor and posts to the ingestion API every 30 s.
// Libraries: WiFi, HTTPClient (bundled with the ESP32 Arduino core).
// Register the device first with channels, e.g. current: { unit: "A", scale: 0.00806 } so raw ADC counts
// are converted server-side (0.00806 = 3.3 V / 4095 / 0.1 V-per-A for a 100 mV/A sensor; adjust to yours).
#include <WiFi.h>
#include <HTTPClient.h>
#include <time.h>

const char* WIFI_SSID = "your-wifi";
const char* WIFI_PASS = "your-password";
const char* API_URL   = "http://192.168.1.10:3000/api/ingest";   // use https:// in production
const char* API_KEY   = "sk_dev_...";                            // from POST /api/devices
const int   ADC_PIN   = 34;

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  configTime(0, 0, "pool.ntp.org");   // real timestamps; if NTP fails, omit "ts" and the server time is used
}

void loop() {
  // average 64 samples to reduce ADC noise
  long sum = 0;
  for (int i = 0; i < 64; i++) { sum += analogRead(ADC_PIN); delay(2); }
  int raw = sum / 64;

  time_t now = time(nullptr);
  String body = "{";
  if (now > 1700000000) body += "\"ts\":" + String((unsigned long)now) + ",";
  body += "\"current\":" + String(raw) + ",\"rssi\":" + String(WiFi.RSSI()) + "}";

  HTTPClient http;
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  int status = http.POST(body);
  Serial.printf("POST %s -> %d %s\n", body.c_str(), status, http.getString().c_str());
  http.end();

  delay(30000);
}
