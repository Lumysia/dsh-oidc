# Threat model and invariants

## Assets and attackers

Assets are OIDC credentials, authorization transactions, local sessions, DSH's native bootstrap token/cookie, and the shared operator authority. Attackers include an unauthenticated internet client, a malicious site driving a browser, a DNS-rebinding origin, a denied issuer identity, and a client forging proxy/identity headers. Compromise of the DSH host, identity provider, reverse proxy, or an admitted shared operator is outside the plugin's containment ability.

## Invariants

1. The configured HTTPS issuer and fixed `publicOrigin` are the only URL authorities. Host and forwarded headers never derive redirect or issuer values.
2. `openid-client` owns discovery, JWKS/signature, issuer, audience, expiry/time, nonce, PKCE, and optional `auth_time` validation. The plugin then independently requires exact string `azp === clientId` whenever present and requires `azp` for a multi-valued audience. Discovery results are cached in memory: reused for 1 h, and kept as a fallback for up to 24 h when rediscovery fails; only a result that passed validation is cached, and the cache is keyed on the client secret. A provider that rotates its signing key is followed once the cached JWKS copy is 60 s old (openid-client refetches on an unknown `kid`).
3. Each callback needs one unexpired transaction cookie and exact state, consumes the transaction before token exchange, and cannot replay.
4. Site configuration comes from the DSH process environment (`DSH_OIDC_*`), which replaces, never merges with, the same fields in the row config; missing or malformed required values stop the plugin before any route registers. Configuration contains only a credential reference. Missing resolution fails closed. Logs and browser state exclude secret/token/code/state/nonce/verifier/claim material.
5. Every configured policy category is required. Empty configured lists, malformed identity/groups/claims, and exact-match failures deny.
6. Local session and transaction bearers are independent 256-bit values indexed by hash, memory-only, bounded, and expired by cleanup.
7. Logout state change requires the local session, exact public Origin, content type, and session-bound CSRF value.
8. `/_dsh-oidc/session` returns display claims (name, username, email, HTTPS picture) and the logout CSRF value only for a live session on a same-origin request; it is not a bypass path and sits behind the proxy's `/auth/check` like the application. No token, subject, issuer or group is returned.
9. The reverse proxy admits only the five exact `/auth/login`, `/auth/callback`, `/auth/check`, `/auth/signin`, and `/auth/logout` paths directly; unmatched `/auth/*` denies. Every other HTTP and upgrade path requires `/auth/check` success. It strips WebSocket upgrade headers **on the auth-check subrequest only** and preserves them to the application. It strips client authorization/proxy-authorization/identity/address aliases and supplies the login-limiter address from `{remote_host}`. The plugin accepts that header only from a socket peer in `trustedProxies` (default loopback). Logout therefore defeats stale DSH cookies. Switching the bundle or its row off removes `/auth/check`, which `forward_auth` reads as a denial, so the gate fails closed.
10. DSH is reachable only by the proxy (loopback, or a network only the proxy can reach). Strict HTTPS-only network reachability protects previously issued non-`Secure` native cookies; a proxy rewrite marks newly issued native cookies `Secure`, but cannot repair existing browser cookies. HSTS/redirects alone do not close a shared TCP/80 path.
11. All admitted users are equivalent shared operators; no per-user DSH isolation or attribution is claimed.

## Residual risks

Provider policy changes remain latent until idle/absolute expiry or restart. Memory-local state does not support multi-process replicas. Provider back-channel logout/revocation and refresh tokens are absent. The DSH bootstrap URL carries a temporary query bearer, requiring URL printing and query logging to be disabled. CI and local acceptance exercise Caddy, the newest DSH release, and Playwright Chromium; real Authentik, Dex/Keycloak, and live deployment interoperability remain separate isolated gates.
