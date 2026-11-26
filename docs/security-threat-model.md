# SmartHarvest threat model

Scope: the deployed prototype's browser, Nginx, FastAPI, PostgreSQL, existing public HiveMQ subscription and trusted local model. This is a repository-grounded review, not a production certification.

## Assets and actors

Assets include crop and farm records, harvest estimates/predictions/actuals, approved availability and member selections, account password hashes, opaque session/CSRF secrets, telemetry provenance, PostgreSQL data, and the local model artifact. Relevant attackers include anonymous web visitors, a user with a seeded account, anonymous publishers on the shared MQTT topic, malformed form/CSV inputs, and an operator who supplies an untrusted model artifact.

## Trust boundaries

| Boundary | Inputs | Main controls |
|---|---|---|
| Browser -> Cloudflare/Nginx -> FastAPI | Login forms, cookies, CSRF header, business inputs | HTTPS at Cloudflare; host checks, request limits, login throttling, Argon2id password verification, opaque revocable sessions, CSRF on POST, role/object authorization, explicit CORS. |
| Public HiveMQ -> MQTT worker | Anonymous QoS 0 payloads on `tani/sensor/lingkungan` | Exact topic, payload cap, key/type/range validation, configured farm/device binding, optional humidity, bounded processing and provenance. Messages remain spoofable and best-effort. |
| FastAPI -> PostgreSQL | IDs, quantities, status and actor actions | Service-level scope checks, transaction/version rules, constraints, session digests and password hashes. DB is internal to Compose. |
| Backend -> model file | Local joblib artifact and inference inputs | Explicit trusted path only; pinned runtime and model metadata; no upload/fetch. Joblib loading can execute code. |
| Cloudflare Tunnel -> web origin | Public HTTPS traffic routed to Nginx | Tunnel token kept in ignored `.env`; origin port bound to loopback; only web proxy is public; docs/readiness hidden. Cloudflare Access may add an audience gate. |

## Abuse cases and mitigations

1. **Credential guessing or account enumeration.** Argon2id hashes, constant-time password verification, a dummy hash for unknown names, uniform invalid-credential responses, eight failed attempts per username/client key per 15-minute window with a 15-minute lock, plus an Nginx login rate limit. Four demo accounts are operator managed and have no self-service recovery or MFA.
2. **Session theft or CSRF.** Session cookies are random, `HttpOnly`, `SameSite=Lax`, `Secure` in production, path restricted, and expire after 12 hours. Only SHA-256 token digests are stored; logout/password change revoke sessions. Login checks Origin/Host and state-changing calls need the per-session CSRF token. Residual: a compromised browser can act as its signed-in user.
3. **Farm/member IDOR.** Principal ID, role, farm assignment and member eligibility come from the user row, never the request. Services validate farm/object/period matches and restrict coordinator/member operations. Allocation changes are versioned; selection enforces quota and total stock.
4. **Forged approval, actual harvest or feedback.** Coordinator-only operations use authenticated actor identity. ActualHarvest is distinct from estimate/prediction/availability. Feedback requires a separately confirmed receipt.
5. **Spoofed/replayed sensor readings or MQTT flood.** Public HiveMQ has no publisher authentication, confidentiality or delivery guarantee. Worker bounds payload and queue, filters keys, validates values and maps the shared topic to a configured farm/device; absent measurement time is server receive time. Physical origin is not proven; a private TLS broker and per-device credentials are needed for production.
6. **Malicious model artifact.** `joblib.load` may execute code. Load only a reviewed local artifact at the configured path; no user upload or automatic download. Missing/incompatible model returns unavailable and retains manual estimate approval.
7. **Public route/configuration exposure.** Nginx only routes frontend/API, DB and API have no host-published ports, docs and readiness are blocked, CSP/security headers are set, CORS is not wildcarded, and API uses the hostname allowlist. Tunnel credentials stay server-side. Residual: without Cloudflare Access, the sign-in page is public and relies on application auth.
8. **Database race or schema drift.** Version checks, unique indexes and transactions guard key writes. The prototype's JSON record table and PostgreSQL concurrency behavior need further hardening/stress testing before production.

## Invariants

- Never place passwords, DB credentials, tunnel token/cert/JSON or model secrets in tracked files or frontend assets.
- Keep bootstrap passwords in ignored `.env`, change them after first sign-in, and remove bootstrap password variables after all accounts are created and credentials safely handed to operators.
- Never publish test data to the shared HiveMQ topic. Keep humidity missing when absent; do not infer it from soil or pressure.
- Mark synthetic predictions and simulated observations accurately. A running tunnel or connected broker does not prove physical sensor delivery.
