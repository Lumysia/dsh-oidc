# Changelog

## Unreleased

- Add `directLogin`: signed-out browser navigations go straight to the provider instead of the bundled sign-in page. Off by default.
- Fix: compare the ID token `iss` with the issuer exactly as configured. A bare-origin issuer such as `https://id.example` was normalized to `https://id.example/` and every login was denied.

## 0.3.0-alpha.0 - Unreleased

First release of the Lumysia/dsh-oidc fork. The OIDC, session, policy, and proxy design from Senti100/dsh-oidc is unchanged.

- Rename the package to `@lumysia/dsh-oidc` and the Cordis plugin to `lumysia-oidc`. Existing profiles must update the `name` and `id` in their patch (see `examples/cordis.patch.yml`).
- Support the DSH 0.2 line instead of exactly 0.2.0-rc.2: DSH peers are `>=0.2.1-rc.1 <0.3.0-0`, Cordis `^4.0.5`. Tested with DSH 0.2.1-rc.1 and 0.2.2-rc.1. DSH 0.2.2 refuses plugins whose DSH peers do not match the running release, so the old exact pins no longer load.
- Replace the startup version check with an API check: the plugin refuses to start only when `ctx.effect`, `webServer.register`, `connection.authenticatedUrl`, or `credentials.resolve` is missing, and names it.
- Add `trustedProxies` (IPs or CIDR ranges) for the proxy allowed to set `X-Dsh-Oidc-Client-Ip`. Default stays loopback only. Needed when Caddy reaches DSH from another container.
- Fix the example patch: a DSH patch row replaces the whole config, so `web-runtime: { printUrl: false }` also dropped `openBrowser` and made DSH ignore `--no-open`. The row now restates upstream's config.
- Require Node 24.9 or newer (DSH 0.2.2 requires it).
- Acceptance test installs the newest DSH release with `dsh plugin add` and boots the shipped example patch; CI also runs it weekly.
- Remove the pinned pnpm fixture, override-count checks, the separate public-install and Office scripts, and the 0.2.0-rc.2 seam fixtures; see the PR for reasons.
- Document that sessions are in memory and a DSH restart signs everyone out.

## 0.2.1-alpha.0 - Released

- Add a bundled self-contained sign-in page at `/auth/signin` (strict CSP, inline HTML, no external assets).
- Make `/auth/check` navigation-aware: browser navigations receive `303 -> /auth/signin` (which Caddy's `forward_auth` subrequest copies through verbatim); `fetch`/XHR/WebSocket subrequests keep the plain `401`. This gives human users a real sign-in entry point without any reverse-proxy configuration change.
- Document the sign-in flow and the five-route `/auth` matcher in the README, deployment guide, and shipped `examples/Caddyfile`.
- **Tested with DSH `0.2.0-rc.2`** (the current release): full-profile acceptance against a real DSH `0.2.0-rc.2` Web profile + Caddy 2.10.2 (synthetic OIDC, native-cookie `Secure`, WebSocket, upload), the separate `web-oidc` public-install gate, and a live deployment verified through Caddy 2.11.3 (sign-in redirect, login chain to the provider with PKCE S256, API-client 401 preservation). The compatibility pin to `0.2.0-rc.2` package interfaces is unchanged.

## 0.2.0-alpha.0 - Released

- Isolated exact DSH 0.2.0-rc.2 / Cordis 4.0.4 compatibility candidate with clean locked runtime closure.
- Inspect upstream native-bootstrap, PeerAdmission, API waterfall, and readiness-gated WebSocket changes without replacing the native Connection or weakening the proxy boundary.
- Add mixed-old-peer rejection, real denied-identity and revoked-cookie replay coverage, stronger browser cookie assertions, and isolated TLS listener/trust handling.
- Document pinned clean-home staging and paired application/home rollback; no in-place migration or production/provider change is implied.

## 0.1.0-alpha.0 - Unreleased

- Initial local candidate: provider-neutral OIDC Authorization Code + PKCE admission.
- Host-only exact auth routes with opaque bounded sessions, CSRF logout, exact claim policy, DSH native-cookie bootstrap, and mandatory reverse-proxy gate documentation.
- Exact DSH 0.1.5-rc.1 compatibility pin.
