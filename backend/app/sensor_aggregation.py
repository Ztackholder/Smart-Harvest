from __future__ import annotations
from collections import defaultdict
from datetime import datetime,timedelta,timezone
import math
WINDOW=timedelta(days=7)
SLOT_SECONDS=900
EXPECTED_SLOTS=672
SPEC={
 "air_temperature":("air_temperature_c","C",-15.0,60.0),
 "air_temperature_c":("air_temperature_c","C",-15.0,60.0),
 "relative_humidity":("relative_humidity_pct","percent",0.0,100.0),
 "relative_humidity_pct":("relative_humidity_pct","%RH",0.0,100.0),
 "soil_moisture_index":("soil_moisture_index_pct","percent",0.0,100.0),
 "soil_moisture_index_pct":("soil_moisture_index_pct","index_pct",0.0,100.0),
}
MODEL_KEYS={"air_temperature_c":"air_temp_mean_7d_c","relative_humidity_pct":"humidity_mean_7d_pct","soil_moisture_index_pct":"soil_moisture_mean_7d_pct"}
def _dt(value):
 if isinstance(value,datetime): result=value
 elif isinstance(value,str): result=datetime.fromisoformat(value.replace("Z","+00:00"))
 else: raise ValueError("timestamp must be RFC3339")
 if result.tzinfo is None or result.utcoffset() is None: raise ValueError("timestamp requires timezone")
 return result.astimezone(timezone.utc)
def aggregate_observations(observations:list[dict],prediction_at:datetime)->dict:
 end=_dt(prediction_at); start=end-WINDOW
 values=defaultdict(lambda:defaultdict(list)); latest={}; sources=set(); seen=set()
 rejected={"invalid":0,"outside_window":0,"duplicates":0,"unsupported":0}
 for observation in observations:
  try: observed=_dt(observation["observed_at"])
  except (KeyError,TypeError,ValueError): rejected["invalid"]+=1; continue
  for measurement in observation.get("measurements",[]):
   try:
    kind=measurement["type"]; raw=float(measurement["value"]); unit=measurement["unit"]
    if not math.isfinite(raw): raise ValueError()
   except (KeyError,TypeError,ValueError,OverflowError): rejected["invalid"]+=1; continue
   if kind not in SPEC: rejected["unsupported"]+=1; continue
   normalized,expected_unit,low,high=SPEC[kind]
   if unit not in {expected_unit, "C" if normalized=="air_temperature_c" else "percent" if normalized!="air_temperature_c" else expected_unit} or not low<=raw<=high:
    rejected["invalid"]+=1; continue
   if observed<start or observed>=end: rejected["outside_window"]+=1; continue
   key=(normalized,observed)
   if key in seen: rejected["duplicates"]+=1; continue
   seen.add(key)
   slot=int((observed-start).total_seconds()//SLOT_SECONDS)
   values[normalized][slot].append(raw);latest[normalized]=max(latest.get(normalized,observed),observed)
   sources.add(observation.get("source","unknown"))
 quality={}; result={}
 for normalized in ("air_temperature_c","relative_humidity_pct","soil_moisture_index_pct"):
  slots=values[normalized]; by_slot={n:sum(samples)/len(samples) for n,samples in slots.items()}
  n=len(by_slot); last=latest.get(normalized); age=(end-last).total_seconds()/3600 if last else None
  valid=n/EXPECTED_SLOTS>=0.8 and age is not None and age<=24
  ys=list(by_slot.values())
  quality[normalized]={"valid_slots":n,"expected_slots":EXPECTED_SLOTS,"coverage":round(n/EXPECTED_SLOTS,5),"last_seen_hours":round(age,5) if age is not None else None,"usable":valid,
   "mean":round(sum(ys)/n,5) if valid else None,"max":round(max(ys),5) if valid else None,"min":round(min(ys),5) if valid else None}
  if valid:
   if normalized=="air_temperature_c": result["air_temp_mean_7d_c"]=quality[normalized]["mean"];result["air_temp_max_7d_c"]=quality[normalized]["max"]
   elif normalized=="relative_humidity_pct": result["humidity_mean_7d_pct"]=quality[normalized]["mean"]
   else: result["soil_moisture_mean_7d_pct"]=quality[normalized]["mean"];result["soil_moisture_min_7d_pct"]=quality[normalized]["min"]
 qflat={"status":"SIMULATED" if sources and sources<= {"simulated_iot"} else "VALID","expected_window_slots":EXPECTED_SLOTS}
 for k,q in quality.items():
  label={"air_temperature_c":"temperature_valid_slots","relative_humidity_pct":"humidity_valid_slots","soil_moisture_index_pct":"soil_valid_slots"}[k]
  qflat[label]=q["valid_slots"]
  if k=="air_temperature_c": qflat["air_temperature_last_seen_hours"]=q["last_seen_hours"]
  elif k=="relative_humidity_pct": qflat["humidity_last_seen_hours"]=q["last_seen_hours"]
  else: qflat["soil_last_seen_hours"]=q["last_seen_hours"]
 air_ages=[age for age in (qflat["air_temperature_last_seen_hours"],qflat["humidity_last_seen_hours"]) if age is not None]
 qflat["air_last_seen_hours"]=max(air_ages) if air_ages else None
 air_ok=quality["air_temperature_c"]["usable"] and quality["relative_humidity_pct"]["usable"]
 soil_ok=quality["soil_moisture_index_pct"]["usable"]
 qflat["air_source"]=("weather_api" if "external" in sources else "iot") if air_ok else ""
 qflat["soil_source"]="iot" if soil_ok else ""
 return {"features":result,"sensor_quality":qflat,"quality":quality,"rejected":rejected,"valid_sensor_readings_7d":min((q["valid_slots"] for q in quality.values()),default=0),
  "window_start":start.isoformat(),"window_end":end.isoformat()}
