from __future__ import annotations
import hashlib,json,uuid
from fastapi import HTTPException
from sqlalchemy.orm import Session
from ..core import AuditEvent,Record,error,iso,list_records,record,save,utcnow
from ..schemas import validate_period

def new_id(prefix:str)->str: return prefix+"-"+uuid.uuid4().hex[:12].upper()
def audit(session:Session,actor_id:str,action:str,resource_id:str,details=None):
 session.add(AuditEvent(id=new_id("AUD"),actor_id=actor_id,action=action,resource_id=resource_id,details=details or {}))
def as_dict(row:Record): return row.payload
def parse_period(p:str):
 try: return validate_period(p)
 except ValueError as exc: error("INVALID_PERIOD",str(exc),422)
def require(row,code="NOT_FOUND",message="Requested record was not found"):
 if row is None: error(code,message,404)
 return row
def hash_observation(payload:dict):
 packed=json.dumps(payload,sort_keys=True,separators=(",",":"),ensure_ascii=False)
 return hashlib.sha256(packed.encode()).hexdigest()
