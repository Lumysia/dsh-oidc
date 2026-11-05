# @lumysia/dsh-oidc

Provider-neutral OpenID Connect sign-in for the DeepSeek Harness (DSH) Web profile. It uses Authorization Code + PKCE through `openid-client`, then hands a successful browser to DSH's unchanged native Connection plugin.

This is a maintained fork of [Senti100/dsh-oidc](https://github.com/Senti100/dsh-oidc). Senti100 wrote the original design and code; this fork keeps that design and follows current DSH releases instead of one pinned release. MIT licensed, see [LICENSE](LICENSE).

## Security architecture

This package is a Host-only Cordis plugin. It registers `/auth/login`, `/auth/callback`, `/auth/check`, `/auth/signin`, and `/auth/logout`; it does **not** replace or copy `@deepseek-ai/dsh-client-connection`. After validating the ID token and admission policy, it creates a short-lived opaque in-memory session and redirects through `ctx.connection.authenticatedUrl(publicOrigin)` so DSH mints its own native browser cookie.

A reverse proxy is a mandatory part of the security boundary. It must send **only** `/auth/login`, `/auth/callback`, `/auth/check`, `/auth/signin`, and `/auth/logout` directly to DSH, deny unmatched `/auth/*`, and guard **every other path** (root, static assets, `/api`, uploads, SSE/streams, and WebSocket upgrades) with `forward_auth /auth/check`. Strip `Connection` and `Upgrade` on the auth-check subrequest only, preserving the application proxy's WebSocket upgrade. Before proxying, Caddy strips browser-supplied authorization, proxy-authorization, identity aliases, and `X-Dsh-Oidc-Client-Ip`, then sets that dedicated header from its connection-observed `{remote_host}`. A stale native DSH cookie is not sufficient after the OIDC session is removed. DSH must be reachable only by the proxy. For a strictly HTTPS-only origin, do not expose HTTP port 80 at the address; an automatic redirect or HSTS cannot protect an already-stored non-`Secure` native cookie before its first HTTP request. The proxy example marks **new** native cookies `Secure`, but cannot repair cookies already stored by a browser. See the [deployment guide](docs/deployment.md).

### Trusted proxies

The plugin uses `X-Dsh-Oidc-Client-Ip` for the login rate limit. It believes the header only when the TCP peer of the request is listed in `trustedProxies`, and then only if it holds exactly one valid IP; otherwise `/auth/login` answers 403. The default is loopback (`127.0.0.0/8` and `::1`), which fits Caddy on the same host.

When Caddy reaches DSH from another container (for example over a Docker network), set `trustedProxies` to Caddy's address or its network, such as `["172.18.0.0/16"]`. The list replaces the default, so include `127.0.0.0/8` too if loopback callers also need it. Entries are IPv4/IPv6 addresses or CIDR ranges; IPv4-mapped IPv6 peers match their IPv4 entry; `/0` and empty lists are rejected. List only addresses that nothing but your proxy can connect from, and keep the DSH port unreachable from anywhere else, because any peer in the list can choose the address the rate limit sees.

DSH has one process-wide operator. Every admitted user shares the same DSH home, sessions, workspaces, credentials, tools, approvals, and event stream. Groups control admission only; they do not create internal roles or isolation. Run one DSH home/process per user when isolation is required.

## Compatibility

| Plugin                    | DSH                   | Node     |
| ------------------------- | --------------------- | -------- |
| 0.3.x (this fork)         | `>=0.2.1-rc.1 <0.3.0` | `>=24.9` |
| 0.2.x (Senti100/dsh-oidc) | exactly `0.2.0-rc.2`  | 22       |

The DSH peers are a range over the 0.2 line, so new 0.2.x releases work without a new plugin release. DSH checks that range itself when the plugin is installed and at startup. On load the plugin also checks that the DSH APIs it calls exist (`ctx.effect`, `webServer.register`, `connection.authenticatedUrl`, `credentials.resolve`) and refuses to start, naming what is missing, if a release removed or renamed one. CI runs the real-stack acceptance test against the newest DSH release on every push and weekly, so an upstream break shows up as a red build. DSH 0.3 will need a deliberate range bump after that test passes.

## Configuration

| Field                       | Meaning                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                    | Exact HTTPS issuer identifier used for discovery and token validation.                                                                                              |
| `clientId`                  | Exact OIDC client identifier.                                                                                                                                       |
| `clientSecretRef`           | Optional DSH credential reference name. The secret value is resolved for each login/callback/logout operation and is never configuration. Omit for a public client. |
| `publicOrigin`              | Fixed HTTPS origin, path `/`; never derived from `Host` or forwarded headers.                                                                                       |
| `allowedSubjects`           | Exact `{ issuer, subject }` tuples.                                                                                                                                 |
| `allowedEmails`             | Exact email values as an additional policy category, never identity; admission also requires literal boolean `email_verified: true`.                                |
| `allowedGroups`             | Exact case-sensitive values from `groupsClaim`.                                                                                                                     |
| `groupMode`                 | `any` or `all` for configured allowed groups.                                                                                                                       |
| `requiredClaims`            | Exact allowed values per required claim; categories are ANDed.                                                                                                      |
| `sessionMaxAgeSeconds`      | Absolute local OIDC-session lifetime (default 8 hours).                                                                                                             |
| `sessionIdleTimeoutSeconds` | Idle expiry (default 30 minutes). Provider policy changes do not invalidate an already-issued session before these limits.                                          |
| `trustedProxies`            | Socket peers (IPs or CIDR ranges) allowed to set `X-Dsh-Oidc-Client-Ip`. Default `["127.0.0.0/8", "::1"]`. See [Trusted proxies](#trusted-proxies).                 |

At least one allow category is mandatory. Every configured category is ANDed; values within subject, email, and `any` group categories are ORed. Match comparison is byte-exact with no case folding or substring behavior. Explicit empty policy lists are invalid. Group claims must be nonempty bounded arrays of unique nonempty bounded strings; scalar groups always deny. Custom required claims may be one bounded nonempty string or the same bounded unique-string array shape.

See the [deployment guide](docs/deployment.md), [`examples/cordis.patch.yml`](examples/cordis.patch.yml), [`examples/Caddyfile`](examples/Caddyfile), and [`.env.example`](.env.example). Before sign-in, the bare root returns 401 to API clients; a **browser navigation** is redirected to the bundled sign-in page at `/auth/signin`, whose Sign-in button starts OIDC at `/auth/login`. With `directLogin: true` the navigation goes straight to `/auth/login` and the provider instead. The redirect triggers only on `sec-fetch-mode: navigate` (or an HTML-only `Accept` when the header is absent); `fetch`/XHR/WebSocket subrequests keep the plain 401 because Caddy's `forward_auth` subrequest copies no such navigation signals. The page is self-contained inline HTML with a strict CSP and no external assets. The package is not published to npm; install it from a tarball built from this checkout. Configuration values in the patch are environment-backed; the client secret value stays behind `ctx.credentials` and only its reference name appears in plugin config.

## Protocol behavior

- OpenID Connect discovery over HTTPS with redirects rejected and a bounded request timeout.
- Authorization Code only, PKCE S256, independent random state/nonce/verifier/transaction/session/CSRF values.
- One-use five-minute transaction with a bound `Secure; HttpOnly; SameSite=Lax; Path=/` cookie.
- ID-token signature, issuer, audience, expiry, nonce, and optional `auth_time` validation by `openid-client`/`oauth4webapi`, followed by an exact `azp === clientId` check whenever `azp` exists and a mandatory `azp` for multi-valued audiences.
- `HEAD /auth/login` is a state-free readiness response: it creates no transaction, cookie, or provider request.
- Opaque hashed server-side sessions; no access token, refresh token, raw ID token, claims, secret, code, state, or nonce is retained in cookies or logs.
- GET logout only renders a confirmation form. POST requires exact Origin and session CSRF before local deletion. RP-initiated logout is optional and provider-advertised.

## Known limits

- **Sessions live in process memory.** Every DSH restart (upgrade, crash, host reboot) signs everyone out and fails logins in progress; users simply sign in again. For the one-user or small-team setups this targets that is rare and cheap, so there is no persistent session store. It also means a single DSH process: replicas would not share sessions.
- Provider-side account or group changes reach an existing session only at its idle or absolute expiry, or at restart.
- Logout ends the outer session; DSH's native cookie cannot be revoked on its own, which is why the proxy gate is mandatory.

## Local development

Node 24.9 or newer.

```sh
npm ci
npm run check
```

`npm run check` runs formatting, lint, strict TypeScript, coverage-gated unit tests, build, package-content inspection, and a secret-pattern scan.

`npm run test:acceptance` is the real-stack test. It packs this repository, installs the newest DSH release (or `DSH_OIDC_DSH_VERSION`) in a temporary directory, adds the tarball with `dsh plugin --profile web add`, boots the Web profile with the shipped [`examples/cordis.patch.yml`](examples/cordis.patch.yml) behind the shipped [`examples/Caddyfile`](examples/Caddyfile), and drives Chromium through a synthetic OIDC issuer: denied identities, sign-in, native cookie flags, root, API, upload, WebSocket, logout with stale-cookie replay, live unload, no printed bearer URL, and a loopback-only listener. It needs a Caddy v2 binary in `DSH_OIDC_CADDY_BIN` and Playwright's Chromium (`npx playwright install chromium`). It uses no live provider, real DSH home, DNS, or credentials.

## Non-goals

This package does not change DSH RPC methods, permissions, model credentials, workspace authorization, per-user ownership, or event delivery. It does not make exposing DSH directly to a network safe. It does not deploy or configure an identity provider, proxy, DNS, or DSH instance.
