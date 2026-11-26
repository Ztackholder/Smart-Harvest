from __future__ import annotations
import math
from datetime import timezone
from sqlalchemy.orm import Session
from ..core import Principal,error,verify_scope,record,Record
from .common import new_id,hash_observation,audit,parse_period

UNITS={"air_temperature":{"C","°C"},"relative_humidity":{"percent","%"},"soil_moisture_index":{"percent","%"},"pressure":{"hPa"},"soil_raw":{"ADC"},"soil_status":{"category"}}
RANGES={"air_temperature":(-15,60),"relative_humidity":(0,100),"soil_moisture_index":(0,100),"pressure":(300,1200),"soil_raw":(0,4095)}
class FarmDataIntegrationService:
 def __init__(self,session:Session,farm_record): self.db,self.farm_record=session,farm_record
 def submit_observation(self,data:dict,principal:Principal|None=None,device_authorized=False)->dict:
  if principal: verify_scope(principal,data["farm_id"])
  if data["source"] in {"iot","simulated_iot"}:
   if not data.get("device_id"): error("DEVICE_REQUIRED","device_id is required for IoT observations",422)
   dev=record(self.db,"Device",data["device_id"])
   if dev is None or dev.payload["farm_id"]!=data["farm_id"]: error("FORBIDDEN","Device is not bound to this farm",403)
  if data.get("crop_id") and ((crop:=self.db.get(Record,data["crop_id"])) is None or crop.kind!="Crop"): error("CROP_NOT_FOUND","Crop is not configured",404)
  normalized=[]; seen=set()
  for item in data["measurements"]:
   typ=item["type"]; unit=item["unit"]; value=item["value"]
   if typ not in UNITS or unit not in UNITS[typ] or not math.isfinite(value): error("INVALID_MEASUREMENT","Measurement type, unit or value is invalid",422)
   if typ in seen: error("DUPLICATE_MEASUREMENT","Measurement type may appear once per observation",422)
   seen.add(typ)
   if typ in RANGES and not RANGES[typ][0]<=value<=RANGES[typ][1]: error("MEASUREMENT_OUT_OF_RANGE","Measurement is outside the allowed range",422)
   canonical={"air_temperature":"air_temperature","relative_humidity":"relative_humidity","soil_moisture_index":"soil_moisture_index","pressure":"pressure","soil_raw":"soil_raw","soil_status":"soil_status"}[typ]
   canonical_unit="C" if typ=="air_temperature" else "percent" if typ in {"relative_humidity","soil_moisture_index"} else "hPa" if typ=="pressure" else unit
   normalized.append({"type":canonical,"value":value,"unit":canonical_unit})
  data["measurements"]=normalized
  data["observed_at"]=data["observed_at"].astimezone(timezone.utc).isoformat().replace("+00:00","Z")
  data["recorded_at"]=__import__("datetime").datetime.now(timezone.utc).isoformat().replace("+00:00","Z")
  if data.get("source")=="iot" and not data.get("provenance"): data["provenance"]="mqtt_public_unverified"
  dedup_key={"farm_id":data["farm_id"],"device_id":data.get("device_id"),"message_id":data["message_id"]} if data.get("message_id") else {"farm_id":data["farm_id"],"device_id":data.get("device_id"),"observed_at":data["observed_at"],"measurements":normalized}
  fingerprint=hash_observation(dedup_key)
  if record(self.db,"Observation","OBS-"+fingerprint[:24]): error("DUPLICATE_OBSERVATION","Observation at this timestamp was already recorded",409)
  data["observation_id"]="OBS-"+fingerprint[:24]; data["status"]="RECORDED"
  result=self.farm_record.persist_observation(data)
  if principal: audit(self.db,principal.user_id,"submitFarmObservation",data["observation_id"],{"source":data["source"]})
  return result
 def submit_estimate(self,data:dict,principal:Principal)->dict:
  verify_scope(principal,data["farm_id"]); parse_period(data["harvest_period"])
  self.farm_record.get_crop_context(data["farm_id"],data["crop_id"])
  data.update(estimate_id=new_id("EST"),status="RECORDED",reported_by=principal.user_id)
  if data["recorded_at"].tzinfo is None: error("TIMEZONE_REQUIRED","recorded_at requires timezone",422)
  data["recorded_at"]=data["recorded_at"].astimezone(timezone.utc).isoformat().replace("+00:00","Z")
  result=self.farm_record.persist_estimate(data); audit(self.db,principal.user_id,"submitHarvestEstimate",data["estimate_id"])
  return result


