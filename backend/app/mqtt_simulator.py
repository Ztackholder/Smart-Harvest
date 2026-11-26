from __future__ import annotations
import argparse,json
from pathlib import Path
def main():
 parser=argparse.ArgumentParser(description="Publish the verified fixture to a local broker only")
 parser.add_argument("--host",default="127.0.0.1");parser.add_argument("--port",type=int,default=1883);parser.add_argument("--topic",default="tani/sensor/lingkungan")
 args=parser.parse_args()
 if args.host.lower() in {"broker.hivemq.com","mqtt.eclipseprojects.io"} or not (args.host in {"127.0.0.1","localhost","::1"} or args.host=="mqtt"):
  raise SystemExit("Simulator only publishes to localhost or the internal Compose service mqtt")
 import paho.mqtt.client as mqtt
 payload=Path(__file__).resolve().parents[1]/"tests"/"fixtures"/"hivemq_sensor_message.json"
 client=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,client_id="smartharvest-local-simulator")
 client.connect(args.host,args.port,keepalive=10);client.loop_start()
 try:
  result=client.publish(args.topic,payload.read_bytes(),qos=0)
  result.wait_for_publish(timeout=5)
  if result.rc!=mqtt.MQTT_ERR_SUCCESS:raise RuntimeError("Local publish failed")
 finally:client.disconnect();client.loop_stop()
 print("Published simulated_iot fixture to configured local broker")
if __name__=="__main__":main()
