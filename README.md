# @soffits/dsh-oidc

Provider-neutral OpenID Connect sign-in for the DeepSeek Harness (DSH) Web profile. It uses Authorization Code + PKCE through `openid-client`, then hands a successful browser to DSH's unchanged native Connection plugin.

This is a maintained fork of [Senti100/dsh-oidc](https://github.com/Senti100/dsh-oidc). Senti100 wrote the original design and code; this fork keeps that design and follows current DSH releases instead of one pinned release. MIT licensed, see [LICENSE](LICENSE).

## Security architecture

This package is a DSH bundle with a Host plugin and a small browser half. The Host plugin registers `/auth/login`, `/auth/callback`, `/auth/check`, `/auth/signin`, `/auth/logout`, and the profile read `/_dsh-oidc/session`; it does **not** replace or copy `@deepseek-ai/dsh-client-connection`. After validating the ID token and admission policy, it creates a short-lived opaque in-memory session and redirects through `ctx.connection.authenticatedUrl(publicOrigin)` so DSH mints its own native browser cookie.

A reverse proxy is a mandatory part of the security boundary. It must send **only** `/auth/login`, `/auth/callback`, `/auth/check`, `/auth/signin`, and `/auth/logout` directly to DSH, deny unmatched `/auth/*`, and guard **every other path** (root, static assets, `/api`, uploads, SSE/streams, WebSocket upgrades, and `/_dsh-oidc/session`) with `forward_auth /auth/check`. Strip `Connection` and `Upgrade` on the auth-check subrequest only, preserving the application proxy's WebSocket upgrade. Before proxying, Caddy strips browser-supplied authorization, proxy-authorization, identity aliases, and `X-Dsh-Oidc-Client-Ip`, then sets that dedicated header from its connection-observed `{remote_host}`. A stale native DSH cookie is not sufficient after the OIDC session is removed. DSH must be reachable only by the proxy. For a strictly HTTPS-only origin, do not expose HTTP port 80 at the address; an automatic redirect or HSTS cannot protect an already-stored non-`Secure` native cookie before its first HTTP request. The proxy example marks **new** native cookies `Secure`, but cannot repair cookies already stored by a browser. See the [deployment guide](docs/deployment.md).

### Trusted proxies

The plugin uses `X-Dsh-Oidc-Client-Ip` for the login rate limit. It believes the header only when the TCP peer of the request is listed in `trustedProxies`, and then only if it holds exactly one valid IP; otherwise `/auth/login` answers 403. The default is loopback (`127.0.0.0/8` and `::1`), which fits Caddy on the same host.

When Caddy reaches DSH from another container (for example over a Docker network), set `trustedProxies` to Caddy's address or its network, such as `["172.18.0.0/16"]`. The list replaces the default, so include `127.0.0.0/8` too if loopback callers also need it. Entries are IPv4/IPv6 addresses or CIDR ranges; IPv4-mapped IPv6 peers match their IPv4 entry; `/0` and empty lists are rejected. List only addresses that nothing but your proxy can connect from, and keep the DSH port unreachable from anywhere else, because any peer in the list can choose the address the rate limit sees.

DSH has one process-wide operator. Every admitted user shares the same DSH home, sessions, workspaces, credentials, tools, approvals, and event stream. Groups control admission only; they do not create internal roles or isolation. Run one DSH home/process per user when isolation is required.

### Sidebar account button

In the sidebar's lower slot (`settings.launcher`, which DSH's built-in DeepSeek account menu occupies), the browser half places the signed-in user's name and picture—or initials if the provider supplies no image. It borrows DSH's Menu component, the sidebar row tokens, and collapsed-rail geometry. Since this slot replaces the Settings control that DSH itself provides, its menu retains **Settings** and also includes **Sign out**. It is registered before the DeepSeek account menu, so when both are enabled this is the one displayed. Its labels track the UI language (English and Chinese).

The button reads `GET /_dsh-oidc/session`; that endpoint responds only for a live OIDC session originating from the same origin. From the validated ID token it returns `name`, `username`, `email`, and `picture` (HTTPS only), along with the CSRF value used for logout in that session. Nothing—token, subject, issuer, or group—is sent outside the Host. This route is not among the five paths that the proxy bypasses; therefore the proxy's `forward_auth` protects it in the same way as the application. **Sign out** issues the same CSRF-guarded form POST to `/auth/logout` that the confirmation page relies on. This is a form navigation rather than `fetch`, so the browser includes `Origin` and then follows the provider's end-session redirect.

### Turning it off

A switch for the bundle appears on the **Plugins** page, and its `soffits-oidc` row has a separate one. Disabling either switch unregisters all `/auth/*` routes. `/auth/check` then returns 404 to Caddy's `forward_auth`, which it interprets as denial; as a result, every application path through the proxy answers 404, including stale native cookies: the gate defaults to closed on failure. The real-stack test verifies this. DSH could be reopened only by a reconfigured proxy, something the plugin cannot control. For another sign-in, re-enable it from a shell that runs on the DSH host: either restore `@soffits/dsh-oidc` to `dsh.profile.bundles` in the profile's `package.json`, or delete the `soffits-oidc` `disabled: true` override from the profile's `cordis.patch.yml`; then restart DSH (or allow HMR to pick it up).

## Compatibility

| Plugin                    | DSH                   | Node     |
| ------------------------- | --------------------- | -------- |
| 0.3.x (this fork)         | `>=0.2.1-rc.1 <0.3.0` | `>=24.9` |
| 0.2.x (Senti100/dsh-oidc) | exactly `0.2.0-rc.2`  | 22       |

The DSH peers are a range over the 0.2 line, so new 0.2.x releases work without a new plugin release. DSH checks that range itself when the plugin is installed and at startup. On load the plugin also checks that the DSH APIs it calls exist (`ctx.effect`, `webServer.register`, `connection.authenticatedUrl`, `credentials.resolve`) and refuses to start, naming what is missing, if a release removed or renamed one. CI runs the real-stack acceptance test against the newest DSH release on every push and weekly, so an upstream break shows up as a red build. DSH 0.3 will need a deliberate range bump after that test passes.

## Configuration

Values for the site are supplied by the environment of the DSH process. Any variable that is present with a non-empty value takes precedence over the matching field from the row config: it substitutes for that field instead of merging with it. Consequently, no profile patch is able to broaden a proxy list or an allowlist configured by the environment. Fields left unset by the environment may use the row config as their source. If neither source provides a value, the plugin will not start, no route is registered, and the proxy rejects all traffic.

| Variable                     | Field             | Format                                                                   |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `DSH_OIDC_ISSUER`            | `issuer`          | URL, required                                                            |
| `DSH_OIDC_CLIENT_ID`         | `clientId`        | string, required                                                         |
| `DSH_OIDC_PUBLIC_ORIGIN`     | `publicOrigin`    | URL, required                                                            |
| `DSH_OIDC_CLIENT_SECRET_REF` | `clientSecretRef` | credential reference name; omit for a public PKCE client                 |
| `DSH_OIDC_ALLOWED_SUBJECTS`  | `allowedSubjects` | JSON array of `{ "issuer", "subject" }`, or of subjects under the issuer |
| `DSH_OIDC_ALLOWED_EMAILS`    | `allowedEmails`   | JSON array of strings                                                    |
| `DSH_OIDC_ALLOWED_GROUPS`    | `allowedGroups`   | JSON array of strings                                                    |
| `DSH_OIDC_TRUSTED_PROXIES`   | `trustedProxies`  | JSON array of IPs or CIDR ranges                                         |
| `DSH_OIDC_DIRECT_LOGIN`      | `directLogin`     | `true` or `false`                                                        |
| `DSH_OIDC_ALLOW_ANY_USER`    | `allowAnyUser`    | `true` or `false`                                                        |

A malformed value stops the plugin with a message naming the variable, never the value. At startup the log names which fields came from the environment.

DSH's Plugins page edits only fields a plugin declares volatile, and this plugin declares none, because a change to any of them must restart the routes. So the page shows the bundle, its switch and the row, but no editable form; there is nothing in the UI that could override an environment value. The remaining fields (session lifetimes, scopes, group mode, required claims and so on) are ordinary row config: add them under `config:` in an override of the `soffits-oidc` row in the profile patch. Extra allow categories there still apply, since categories are ANDed and can only narrow admission.

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
| `directLogin`               | Send signed-out browser navigations straight to the provider instead of the bundled sign-in page (default `false`).                                                 |
| `allowAnyUser`              | Admit every account the provider signs in, when access is already restricted at the provider (an application group, for example). Default `false`.                  |

At least one allow category is mandatory unless `allowAnyUser` is `true`; it cannot be switched on by an empty list or a missing value. Every configured category is ANDed; values within subject, email, and `any` group categories are ORed. Match comparison is byte-exact with no case folding or substring behavior. Explicit empty policy lists are invalid. Group claims must be nonempty bounded arrays of unique nonempty bounded strings; scalar groups always deny. Custom required claims may be one bounded nonempty string or the same bounded unique-string array shape.

See the [deployment guide](docs/deployment.md), the bundle layer [`cordis.patch.yml`](cordis.patch.yml), [`examples/Caddyfile`](examples/Caddyfile), and [`.env.example`](.env.example). Before sign-in, the bare root returns 401 to API clients; a **browser navigation** is redirected to the bundled sign-in page at `/auth/signin`, whose Sign-in button starts OIDC at `/auth/login`. With `directLogin: true` the navigation goes straight to `/auth/login` and the provider instead. The redirect triggers only on `sec-fetch-mode: navigate` (or an HTML-only `Accept` when the header is absent); `fetch`/XHR/WebSocket subrequests keep the plain 401 because Caddy's `forward_auth` subrequest copies no such navigation signals. The page is self-contained inline HTML with a strict CSP and no external assets. The package is not published to npm; install a GitHub release tarball or one built from this checkout. The client secret value stays behind `ctx.credentials`; only its reference name is configuration.

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

`npm run test:acceptance` is the real-stack test. It packs this repository, installs the newest DSH release (or `DSH_OIDC_DSH_VERSION`) in a temporary directory, adds the tarball with `dsh plugin --profile web add`, boots the Web profile with the bundle enabled, an empty profile patch and every site value in `DSH_OIDC_*`, behind the shipped [`examples/Caddyfile`](examples/Caddyfile), and drives Chromium through a synthetic OIDC issuer: denied identities, sign-in, native cookie flags, root, API, upload, WebSocket, logout with stale-cookie replay, the sidebar account button (name, picture, menu, Settings, sign-out), switching the row off failing closed through the proxy, no printed bearer URL, and a loopback-only listener. Set `DSH_OIDC_SCREENSHOT_DIR` to keep light and dark screenshots of the open account menu. It needs a Caddy v2 binary in `DSH_OIDC_CADDY_BIN` and Playwright's Chromium (`npx playwright install chromium`). It uses no live provider, real DSH home, DNS, or credentials.

## Non-goals

This package does not change DSH RPC methods, permissions, model credentials, workspace authorization, per-user ownership, or event delivery. It does not make exposing DSH directly to a network safe. It does not deploy or configure an identity provider, proxy, DNS, or DSH instance.
