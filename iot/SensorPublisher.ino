#include <WiFi.h>
#include <WiFiMulti.h>
#include <PubSubClient.h>
#include <BluetoothSerial.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

// Kalibrasi Capacitive Soil Moisture Sensor
const int NILAI_KERING = 3300; 
const int NILAI_BASAH  = 1700; 

// Interval pengiriman: 5000 ms = 5 detik
const unsigned long INTERVAL_KIRIM = 5000; 

// Konfigurasi MQTT
const char* mqtt_server = "broker.hivemq.com";
const int   mqtt_port   = 1883;
const char* mqtt_topic  = "tani/sensor/lingkungan";

// Definisi Pin
#define SOIL_POWER_PIN 25
#define SOIL_ADC_PIN   34
#define I2C_SDA        21
#define I2C_SCL        22

WiFiMulti wifiMulti;
WiFiClient espClient;
PubSubClient client(espClient);
BluetoothSerial SerialBT;
Adafruit_BME280 bme;

unsigned long waktuTerakhirKirim = 0;

void logData(String pesan) {
  Serial.println(pesan);
  if (SerialBT.hasClient()) {
    SerialBT.println(pesan);
  }
}

void setup_wifi() {
  wifiMulti.addAP("POCOX3Pro", "12345678");
  logData("Mencari jaringan Wi-Fi terdaftar...");
  
  int retry = 0;
  while (wifiMulti.run() != WL_CONNECTED && retry < 20) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    logData("\nTerhubung ke Wi-Fi: " + WiFi.SSID() + " | IP: " + WiFi.localIP().toString());
  } else {
    logData("\nBelum ada Wi-Fi terdaftar yang aktif. Lanjut mode offline Bluetooth...");
  }
}

void reconnect_mqtt() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!client.connected()) {
    String clientId = "ESP32-Lahan-" + String(random(0xffff), HEX);
    client.connect(clientId.c_str());
  }
}

void setup() {
  Serial.begin(115200);
  SerialBT.begin("ESP32_Env_Logger");

  pinMode(SOIL_POWER_PIN, OUTPUT);
  digitalWrite(SOIL_POWER_PIN, HIGH);
  analogReadResolution(12);

  Wire.begin(I2C_SDA, I2C_SCL);
  if (!bme.begin(0x76) && !bme.begin(0x77)) {
    logData("ERROR: BME280 tidak terdeteksi! Cek wiring SDA(21)/SCL(22).");
    while (1);
  }

  bme.setSampling(Adafruit_BME280::MODE_NORMAL,
                  Adafruit_BME280::SAMPLING_X2,
                  Adafruit_BME280::SAMPLING_X16,
                  Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::FILTER_X16,
                  Adafruit_BME280::STANDBY_MS_500);

  setup_wifi();
  client.setServer(mqtt_server, mqtt_port);
}

void loop() {
  if (wifiMulti.run() == WL_CONNECTED) {
    if (!client.connected()) reconnect_mqtt();
    client.loop();
  }

  unsigned long sekarang = millis();
  if (sekarang - waktuTerakhirKirim >= INTERVAL_KIRIM) {
    waktuTerakhirKirim = sekarang;

    float suhu       = bme.readTemperature();
    float tekanan    = bme.readPressure() / 100.0F;
    float kelembapan = bme.readHumidity();
    int rawSoil      = analogRead(SOIL_ADC_PIN);
    int tanah        = constrain(map(rawSoil, NILAI_KERING, NILAI_BASAH, 0, 100), 0, 100);

    char payload[160];
    snprintf(payload, sizeof(payload),
             "{\"temp\":%.2f,\"pres\":%.2f,\"hum\":%.2f,\"soil_pct\":%d,\"soil_raw\":%d}",
             suhu, tekanan, kelembapan, tanah, rawSoil);

    String statusMQTT = (client.connected() && client.publish(mqtt_topic, payload)) ? "OK" : "FAIL";

    String namaWiFi = (WiFi.status() == WL_CONNECTED) ? WiFi.SSID() : "OFFLINE";
    String logLine = "[" + namaWiFi + " | MQTT:" + statusMQTT + "] " +
                     "T:" + String(suhu, 1) + "C | P:" + String(tekanan, 0) +
                     "hPa | H:" + String(kelembapan, 1) + "% | Soil:" + String(tanah) + "% (" + String(rawSoil) + ")";
    logData(logLine);
  }
}