# Cloudflare Tunnel deployment

A remotely managed Cloudflare Tunnel and proxied DNS hostname are active. The tunnel routes one hostname to Nginx at http://web:80 over the Compose network. Nginx serves the existing frontend and forwards /api/v1/ to FastAPI on the same hostname. The connector image is pinned to cloudflare/cloudflared:2026.10.0. No account ID, hostname, tunnel UUID, credential JSON or token is stored in tracked files.

## Verified deployment

- Cloudflare reports the tunnel healthy with four registered edge connections.
- Public / and /dashboard return 200.
- Public /api/v1/catalog returns 401 without a signed-in session and 200 with a username/password session.
- Public /docs returns 404.
- PostgreSQL and API are internal to the Compose network. The Nginx origin port is bound to loopback.
- The tunnel token is in the Git-ignored root .env, not in the frontend bundle.
- Database, API, web and tunnel use restart unless-stopped policies.

## Check and operate

From repository root:

    docker compose --env-file .env --profile tunnel ps
    docker compose --env-file .env --profile tunnel logs --tail 50 tunnel
    docker compose --env-file .env --profile tunnel up -d

The tunnel profile is optional in a fresh local environment. It is active on the deployed host. PostgreSQL starts first, migrations complete before the API, and the web proxy waits for API health.

Use the operator-configured hostname for public checks. Test the frontend root and a deep link, API 401 without a session and 200 after username/password sign-in, and ensure docs remain unavailable. Do not expose the origin port beyond loopback.

## Authentication and audience

The application uses username/password accounts, Argon2id hashes, opaque server-side sessions, `HttpOnly` cookies, session-bound CSRF checks, and login throttling. Bootstrap usernames and passwords are set in ignored `.env`; passwords are read only when creating each account. Retrieve initial passwords from the local `.env` file, sign in, and change each password from the Account dialog. Do not paste credentials into chat or commit them. Cloudflare Access can add an identity gate if the deployment needs an audience restriction.

## Rollback

    docker compose --env-file .env --profile tunnel stop tunnel

To end public access, also remove or disable the public hostname route and DNS record in Cloudflare. Rotate or revoke the tunnel token in Cloudflare if it may have been exposed. The app remains available on its loopback origin.

## MQTT and physical sensor status

The API is configured as a receive-only subscriber to the existing HiveMQ host and topic using the teammate firmware format. HiveMQ connectivity succeeded, but a 65-second listen window received zero messages and the database has no sensor observations. The ingestion service is ready; physical delivery is not confirmed. The device must be powered, associated with its configured Wi-Fi and publishing to the exact topic. No messages were published during verification.

## Official Cloudflare references

- [Cloudflare Tunnel getting started](https://developers.cloudflare.com/tunnel/get-started/)
- [Locally managed tunnel configuration](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)
