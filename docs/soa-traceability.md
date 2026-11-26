# D2 to D3 SOA traceability

Implementation is one modular Python application with five logical service boundaries. The API routes and MQTT worker are adapters; service methods use injected service collaborators and typed ports in `backend/app/contracts.py`. No HTTP hop or database access from the frontend to internal stores is used.

## Services and dependencies

| D2 service | D3 provider module | Responsibility and owned record kinds | Main consumers |
|---|---|---|---|
| SVC-01 Farm Data Integration | `services/svc_01_farm_data.py` | Normalize, validate, deduplicate, provenance; Observation and HarvestEstimate via SVC-02 contract | REST API-01/02 and MQTT adapter |
| SVC-02 Farm Record | `services/svc_02_farm_record.py` | Farm/Crop/Planting/Device/Member/Receipt, Observation, HarvestEstimate, ActualHarvest persistence and crop context | SVC-01, SVC-03, API-09 |
| SVC-03 Harvest Prediction | `services/svc_03_prediction.py` | Seven-day feature assembly, replaceable predictor, prediction metadata and review flag | REST API-03/04; SVC-02 context; existing `ai/src/predict.py` |
| SVC-04 Supply Coordination | `services/svc_04_supply.py` | Explicit shortage rule, review/approval, versioned availability and adjustment audit | REST API-05/08/11; SVC-03 prediction, SVC-02 actual |
| SVC-05 Member Information | `services/svc_05_member.py` | Approved availability read, eligible selections, personal updates, confirmed-receipt feedback | REST API-06/07/10/12; SVC-04 contract |

## API baseline

| API | Route | Provider | Code | Role and core rule |
|---|---|---|---|---|
| API-01 | POST `/api/v1/farm-observations` | SVC-01 | `api.submit_observation` | FARMER assigned to farm; normalized observation. |
| API-02 | POST `/api/v1/harvest-estimates` | SVC-01 | `api.submit_estimate` | FARMER assigned to farm; distinct HarvestEstimate. |
| API-03 | POST `/api/v1/harvest-predictions` | SVC-03 | `api.generate_prediction` | COORDINATOR; context/reference scope; returns 503 if unavailable. |
| API-04 | GET `/api/v1/harvest-predictions/{id}` | SVC-03 | `api.get_prediction` | COORDINATOR with farm scope. |
| API-05 | POST `/api/v1/approved-availability` | SVC-04 | `api.approve` | COORDINATOR; matching basis farm/crop/week/quantity. |
| API-06 | GET `/api/v1/approved-availability?period=` | SVC-05 | `api.approved` | MEMBER; reads only approved records. |
| API-07 | POST `/api/v1/member-selections` | SVC-05 | `api.selection` | Eligible MEMBER; quota, stock, version and period checked. |
| API-08 | POST `/api/v1/allocation-adjustments` | SVC-04 | `api.adjust` | COORDINATOR; reason, expected version, allocations and optional matching ActualHarvest. |
| API-09 | POST `/api/v1/actual-harvests` | SVC-02 | `api.actual` | COORDINATOR recorder; distinct confirmed ActualHarvest. |
| API-10 | POST `/api/v1/member-feedback` | SVC-05 | `api.feedback` | MEMBER with prior confirmed receipt. |
| API-11 | POST `/api/v1/supply-risk-assessments` | SVC-04 | `api.risk` | COORDINATOR; gap is `max(0, planned_demand_kg - predicted_quantity_kg)`. |
| API-12 | GET `/api/v1/allocation-updates?period=` | SVC-05 | `api.updates` | MEMBER; own update rows only; D2 addendum. |

D3 support reads and the coordinator receipt confirmation operation are listed in `docs/api-contract.md`. `validateFarmData`, `getCropHistory` and `getHarvestRecord` remain internal service operations as specified in D2.

## D2 requirements / feature / BPMN matrix

| D2 requirement | Feature IDs | BPMN | D2 service and operations | API | Test evidence |
|---|---|---|---|---|---|
| REQ-01: accept farm data through form, CSV, external API and IoT | F-01, F-02, F-03 | BP-01, BP-02 | SVC-01 `submitFarmObservation`, `submitHarvestEstimate`, `validateFarmData` | API-01, API-02 | TEST-01, TEST-02, TEST-03; see status matrix. |
| REQ-02: store farm data and harvest records uniformly | F-03, F-10 | BP-02, BP-08 | SVC-02 `getCropHistory`, `recordActualHarvest`, `getHarvestRecord` | API-01, API-09 | TEST-07 and separate record kinds. |
| REQ-03: predict harvest quantity and identify shortage | F-04, F-05 | BP-03, BP-04 | SVC-03 `generateHarvestPrediction`, `getPrediction`; SVC-04 `assessSupplyRisk` | API-03, API-04, API-11 | TEST-04 and explicit unavailable branch. |
| REQ-04: coordinator review, availability approval and allocation adjustment | F-06, F-09 | BP-04, BP-05 | SVC-04 `reviewPrediction`, `approveAvailability`, `adjustAllocation` | API-05, API-08 | TEST-05, TEST-08; stale version test. |
| REQ-05: members read approved availability and allocation updates | F-07 | BP-06 | SVC-05 `getApprovedAvailability`, `getAllocationUpdate` | API-06, API-12 | TEST-06. |
| REQ-06: package-eligible members select produce | F-08 | BP-06 | SVC-05 `submitMemberSelection` | API-07 | Eligible and ineligible selection test. |
| REQ-07: record actual harvest and member feedback | F-10, F-11 | BP-08 | SVC-02 `recordActualHarvest`; SVC-05 `submitFeedback` | API-09, API-10 | TEST-07; receipt-gate flow. |

BP-07 field operations (planning, harvest, sorting, packing, delivery and handover) remain manual and out of prototype scope, as D2 states. D2 feature priorities F-13..F-15 remain out of scope (member registration/payment/production identity, automatic allocation substitution, multi-period analysis).

## Cross-service flow

```mermaid
sequenceDiagram
    participant F as Farmer / MQTT adapter
    participant S1 as SVC-01 Integration
    participant S2 as SVC-02 Farm Record
    participant S3 as SVC-03 Prediction
    participant S4 as SVC-04 Supply
    participant S5 as SVC-05 Member
    participant C as Coordinator
    participant M as Member
    F->>S1: API-01 observation / API-02 estimate
    S1->>S2: persist normalized typed record
    C->>S3: API-03 generate for context and references
    S3->>S2: read planting context and observation history
    S3-->>C: prediction metadata; review required
    C->>S4: API-11 demand assessment
    S4-->>C: shortage gap and status
    C->>S4: API-05 explicit approval
    S4-->>S5: approved availability contract
    M->>S5: API-06 read; API-07 eligible selection
    C->>S2: API-09 confirm actual harvest
    C->>S4: API-08 versioned manual adjustment
    C->>S5: coordinator confirms package receipt
    M->>S5: API-10 feedback after receipt
```

## Boundaries and deviations

- REST and MQTT call the same SVC-01 operation. Each service receives a SQLAlchemy session and collaborators through the composition function.
- A shared PostgreSQL database is used; cross-service access is via service operations, not raw cross-service repository writes in controllers.
- D2’s proposed DHT/HTTP sensor differs from teammate firmware. D3 preserves actual HiveMQ topic and BME280 payload. Humidity is accepted as `hum` when present and remains optional.
- API-12 is implemented as D2's addendum. User management, payments, automatic approval, automatic risk decisions, and physical BP-07 are not implemented.
- Storage is a single `records` table with a strict kind discriminator, JSON payloads, farm/crop reference FKs, kind/version checks and partial unique indexes. This is a documented D3 simplification versus fully normalized entity tables.
