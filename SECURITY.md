# Security policy

## Reporting

Report suspected vulnerabilities privately to the repository maintainers. Do not include production credentials, tokens, cookies, identity claims, or deployment logs in a public issue.

## Deployment requirements

- Keep DSH reachable only by the HTTPS reverse proxy: bind it to `127.0.0.1`, or, when the proxy runs in another container, to an address on a network only the proxy can reach. Set `trustedProxies` to that proxy and nothing wider.
- Guard every path except the five exact registered OIDC endpoints with `/auth/check`, including static files, `/api`, WebSocket, and streaming paths. Deny unmatched `/auth/*` and strip `Connection`/`Upgrade` **only on the auth pre-check**, not the application WebSocket proxy.
- When DSH serves plain HTTP behind the proxy, mark newly issued native `dsh-auth-*` cookies `Secure` at the TLS proxy; test multiple `Set-Cookie` headers, deletion, and an already-Secure value. This is not retroactive for cookies already in browsers.
- Preserve the public Host header, strip client-supplied proxy/identity headers, disable query-string access logging, and configure DSH Connection `trustedHosts` with the public authority.
- Disable DSH URL printing/browser opening. The native bootstrap URL temporarily contains a bearer query token.
- For strict HTTPS-only security, serve the DSH address only on HTTPS and keep TCP/80 unreachable at the network edge; HSTS or HTTP-to-HTTPS redirects do not prevent an old non-`Secure` cookie from being sent on a first HTTP request. A shared IP with other HTTP sites does **not** meet this stronger guarantee. See [deployment options](docs/deployment.md).
- Configure only `clientSecretRef` in the Cordis patch. Keep the actual client secret in a supported DSH credential provider or inherited process environment supplied by a restricted service manager; never put `DSH_*` bootstrap variables in `$DSH_HOME/.env` or commit a real EnvironmentFile. See [deployment options](docs/deployment.md).

Local OIDC sessions are memory-only by default. Restart and logout invalidate them; with the opt-in `persistSessions` they survive a restart in a `0600` file under the DSH home that holds only SHA-256 digests of the cookie values, display claims and logout CSRF values, and logout deletes the record before answering. Changing the issuer, client or allow policy drops every persisted session at the next start. In both modes DSH's native cookie cannot be individually revoked; the mandatory proxy gate supplies revocation. Provider-side account or group changes take effect no later than local idle/absolute expiry, or at a restart that drops the session.

All admitted identities share one DSH operator authority. This package is admission control, not per-user authorization.
