# D3 verification results

Updated: 2026-11-26 (Asia/Jakarta). Public checks used the authorized Cloudflare hostname and receive-only HiveMQ subscription. No MQTT messages were published.

## D2 baseline scenarios

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| TEST-01 | Valid manual/form observation stored | PASS | Backend API flow returns 201 and the existing frontend supports the manual observation workflow. |
| TEST-02 | IoT normalization | PASS adapter; live sensor unverified | Subscriber is enabled and bound to exact HiveMQ topic/farm/device; latest 50-second receive-only DB monitor got zero observations. No physical origin claim. |
| TEST-03 | Invalid value/unit rejected | PASS | API-01 rejects RH=101 with 422 and stable `MEASUREMENT_OUT_OF_RANGE`; MQTT unknown keys/wrong block are rejected in unit tests. |
| TEST-04 | Prediction stored/retrieved with model metadata | PASS | Existing `rf-synthetic-v3` runs using sklearn 1.9.1; metadata identifies synthetic provenance. This proves wiring, not model quality. |
| TEST-05 | Coordinator approves availability | PASS | Matching `MANUAL_ESTIMATE` basis returns APPROVED with coordinator identity, timestamp and version. |
| TEST-06 | Member availability and prediction authorization | PASS | Member can read approved availability; member access to coordinator prediction retrieval returns 403. |
| TEST-07 | Actual harvest remains separate | PASS | Actual harvest row is stored separately and coordinator versioned adjustment cites it. |
| TEST-08 | Member attempts coordinator approval | PASS | Member session attempts API-05 and receives 403. |

## Supplemental domain and auth cases

| Check | Result | Evidence / limitation |
|---|---|---|
| Model unavailable/manual estimate fallback | PASS | Model-disabled test returns `503 PREDICTION_UNAVAILABLE`; coordinator can approve matching estimate manually. |
| Eligible/noneligible member selection | PASS | Eligible MBR-001 succeeds; regular MBR-002 is rejected. |
| Feedback receipt gate | PASS | Feedback before confirmed receipt returns 409; coordinator receipt confirmation enables feedback. |
| Version conflict and message deduplication | PASS | Stale expected version returns 409; duplicate same-message ID returns 409. |
| Optional humidity | PASS | `hum` maps to relative humidity when present; older payload without humidity remains accepted and missing. |
| Dataset v3 sensor aggregation | PASS | Complete, missing-interval and stale fixtures match `sensor_fixture_expected.json`. |
| Username/password login | PASS | Generic wrong-password/unknown-user response, login throttle, Argon2id verification, cookie issuance and role profile are covered by `backend/tests/test_auth.py`. |
| CSRF, password change and logout | PASS | Missing CSRF returns 403; valid session permits protected action; password change revokes sessions; logout invalidates the session. |
| Legacy bearer rejection | PASS | `Authorization: Bearer` no longer authorizes API requests. |
| Public Playwright browser flow | PASS | Deployed login returned the Farmer workspace; account dialog exposed password change/logout; logout returned to sign-in. |
| Public HTTP auth smoke | PASS | Root/deep link 200; anonymous catalog and wrong password 401; valid login 200; `/auth/me` FARMER; missing CSRF 403; logout 200 then session 401; `/docs` 404. |
| Cookie settings | PASS | Public cookie has HttpOnly, Secure, SameSite=Lax and Path=/api/v1. |
| Existing PostgreSQL records after auth migration | PASS | Alembic revision `0002_password_sessions`; eight existing farm/demo records remain unchanged; four auth accounts seeded. |
| Local Mosquitto end-to-end | NOT RUN | Shared HiveMQ topic was not used to publish tests. |
| Physical BME280/humidity delivery | NOT VERIFIED | Latest 50-second receive-only window had zero observations across six samples. |
| Replacement model/training | NOT RUN | Deferred by user; do not alter or train current artifact. |
| Dataset repository suite | BLOCKED | `datasets/tests/test_v3.py` imports absent `generate_dataset.py`; backend fixture-parity tests pass independently. |

## Builds and migration

- `backend/.venv/Scripts/python.exe -m pytest backend/tests -q -p no:cacheprovider` — **12 passed**, one Starlette/AnyIO deprecation warning.
- `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_auth.py -q` — **5 passed**.
- Isolated SQLite Alembic upgrade and live PostgreSQL migration — **PASS**, revision `0002_password_sessions`.
- `npm.cmd run build` — **PASS**, TypeScript check and Vite production build.
- `docker compose config -q` and API/web/migration image builds — **PASS**.
- OpenAPI is exported to `docs/openapi.json` (refresh after auth rollout).

## Known limitations

Physical device power/Wi-Fi/publishing are inaccessible here. MQTT is public anonymous QoS 0, so transport does not verify physical sensor identity. PostgreSQL row-lock concurrency stress was not run during the auth rollout. The Cloudflare-injected Insights script is blocked by the configured CSP; the initial unauthenticated `/auth/me` 401 is expected before login.
