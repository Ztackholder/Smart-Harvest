# Security best-practices review

Review date: 2026-11-26. Reviewed the username/password and cookie session implementation, API authorization, MQTT adapter, database, reverse proxy, Compose and existing frontend. This is a prototype review, not a production certification.

## Authentication and authorization

- Four operator-bootstrapped accounts retain the current principal IDs and farm/member scopes. Login does not accept a role, farm, or member ID from the browser. New users are not self-registered.
- Passwords are hashed with Argon2id (`argon2-cffi`); the existing bootstrap password is used only when creating a missing account. Unknown usernames and wrong passwords return the same error. Login attempts are limited to eight per username/client key within 15 minutes, with a 15-minute lockout; Nginx adds a Cloudflare-client rate limit on the login endpoint.
- Session IDs are random opaque values. The database stores only SHA-256 digests and expires/revokes sessions. Browser cookies use `HttpOnly`, `SameSite=Lax`, `Secure` in production, an API-only path, and a 12-hour expiry. Logout and password changes revoke sessions.
- All state-changing API requests require an authenticated session and per-session CSRF token. Login checks `Origin` against `Host`. Frontend code keeps the CSRF value in memory and never reads or stores the session cookie. CORS is explicit; no wildcard origins or bearer-token fallback remain.
- Existing role, farm, member ownership, eligibility, quota, approval, receipt and version checks continue to use the server-side principal and service rules.

## Other controls

- Request bodies are capped at Nginx and FastAPI layers; JSON schemas reject unexpected values, nonfinite numbers, invalid units and naive timestamps. Errors use a stable envelope and do not expose SQL or traces.
- MQTT is disabled by default in fresh configuration. Live HiveMQ messages are public, anonymous and untrusted; the adapter caps payload size, validates keys/ranges, binds configured farm/device identity, records provenance and accepts optional humidity without filling missing values.
- PostgreSQL is internal to Compose. The web origin binds to loopback; only Nginx frontend and `/api/v1/` paths are proxied. Docs/readiness endpoints remain unavailable publicly. CSP and common response headers are configured. Cloudflare Tunnel is a separately managed public boundary.
- Model loading is restricted to an explicitly configured trusted local artifact. `joblib` can execute code; never load user-supplied artifacts.

## Remaining risks

- Accounts are prototype operator-managed identities. There is no self-service registration, email recovery, MFA, or user administration. Protect and change the bootstrap credentials; optionally add Cloudflare Access for the demo audience.
- The public HiveMQ topic cannot prove physical publisher identity, encrypt data, or guarantee delivery. Use a private broker with TLS and per-device credentials for production.
- The repository persists domain records in one JSON payload table and requires additional relational constraints and PostgreSQL concurrency stress before production.
- Physical sensor delivery was not confirmed; the previous receive-only check obtained no messages. Synthetic model provenance is not field accuracy evidence.
