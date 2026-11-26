# REST API contract

All business operations use prefix `/api/v1`, a username/password-backed browser session, and JSON bodies where applicable. The API sets an HttpOnly opaque session cookie at login; protected POST requests also require the matching `X-CSRF-Token`. Success: GET 200, stored POST 201. Errors use `{"error":{"code":"STABLE_CODE","message":"Readable explanation"}}`.

| ID | Method/path | SoaML operation and service | Role |
|---|---|---|---|
| API-01 | POST /farm-observations | SVC-01 submitFarmObservation | FARMER owning the farm |
| API-02 | POST /harvest-estimates | SVC-01 submitHarvestEstimate | FARMER owning the farm |
| API-03 | POST /harvest-predictions | SVC-03 generateHarvestPrediction | COORDINATOR |
| API-04 | GET /harvest-predictions/{id} | SVC-03 getPrediction | COORDINATOR |
| API-05 | POST /approved-availability | SVC-04 approveAvailability | COORDINATOR |
| API-06 | GET /approved-availability?period=YYYY-Www | SVC-05 getApprovedAvailability | MEMBER; COORDINATOR read access |
| API-07 | POST /member-selections | SVC-05 submitMemberSelection | eligible MEMBER |
| API-08 | POST /allocation-adjustments | SVC-04 adjustAllocation | COORDINATOR |
| API-09 | POST /actual-harvests | SVC-02 recordActualHarvest | COORDINATOR recorder |
| API-10 | POST /member-feedback | SVC-05 submitFeedback | MEMBER after receipt |
| API-11 | POST /supply-risk-assessments | SVC-04 assessSupplyRisk | COORDINATOR |
| API-12 | GET /allocation-updates?period=YYYY-Www | SVC-05 getAllocationUpdate (D2 addendum) | MEMBER, own changes only |

## Baseline payloads

- API-01: farm_id, optional crop_id, device_id for IoT, timezone-aware observed_at, source, and measurements list with type/value/unit. Sources: manual, csv, iot, simulated_iot, external.
- API-02: farm_id, crop_id, harvest_period, estimated_quantity_kg, recorded_at.
- API-03: farm_id, crop_id, target_period, data_reference_ids. Successful response carries prediction ID, kg quantity, model version, training provenance, route, generated time, status and coordinator review flag.
- API-05: farm_id, crop_id, period, basis_type (PREDICTION or MANUAL_ESTIMATE), basis_id, approved_quantity_kg, approval_note.
- API-07: period, items with availability_id, availability_version and quantity_kg. Member identity is server-derived.
- API-08: availability_id, expected_version, approved_quantity_kg, reason, member allocations and optional matching actual_harvest_id.
- API-09: farm/crop/period, nonnegative actual_quantity_kg, timezone-aware harvested_at, source and confirmation_note.
- API-10: period and nonempty comment; member identity and receipt are server-derived.
- API-11: prediction_id and coordinator-entered planned_demand_kg.

## Authentication, authorization and status

Auth support paths are `POST /auth/login` (`username`,`password`), `GET /auth/me`, `POST /auth/logout`, and `POST /auth/password` (`current_password`,`new_password`). Login requires matching Origin/Host. Cookie sessions expire after 12 hours; passwords are Argon2id hashes, and logout/password change revoke sessions. Login uses a generic invalid-credentials response and throttling. There is no public registration or role selector.

Farmer access is farm-bound. Member identity and package eligibility come from the persisted authenticated account, never from request body. Coordinator-only mutations are checked server-side. Quantities are finite and nonnegative, periods are real ISO weeks, and timestamps include timezones. Invalid syntax/media is 400/415, unauthenticated/forbidden 401/403, missing objects 404, duplicates/stale versions 409, business field/rule errors 422, temporary service outage 503. Internal errors never return SQL or stack traces.

D3 support reads hydrate the existing portal: /catalog, /farm-contexts/{farm_id}, /farm-observations?farm_id=, /harvest-estimates?farm_id=&period=, /harvest-predictions?farm_id=&period=, /supply-risk-assessments?period=, /actual-harvests?farm_id=&period=, /member-selections?period= and /allocation-adjustments?period=. /package-receipts is a coordinator support operation for confirmed receipt. These do not rename the D2 baseline. validateFarmData, getCropHistory and getHarvestRecord remain internal operations.

OpenAPI is generated from FastAPI at docs/openapi.json after dependencies are installed.
