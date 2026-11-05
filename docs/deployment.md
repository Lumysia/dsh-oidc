# Install and operate DSH OIDC (DSH Web 0.2.x)

This guide installs the plugin from a tarball built from a checkout of this repository; `@lumysia/dsh-oidc` is not published to npm. Try it in a disposable DSH home first, then back up any real home and proxy configuration before repeating it. Do not copy provider exports, session cookies, client secrets, or real subject IDs into a Git checkout or support ticket.

## Prerequisites and topology

- Node 24.9 or newer, a DSH release in the plugin's supported range (see the README) with its shipped `web` profile, `pnpm` on `PATH` (DSH's plugin manager calls it), Caddy v2, a TLS certificate, and an OIDC issuer with authorization-code + PKCE S256 support.
- One DSH process/home behind the reverse proxy, reachable only by that proxy. The application shares **one operator authority** among all admitted identities; use one process/home per identity if isolation is needed.
- An HTTPS public origin with no HTTP path on which a browser could send DSH's native cookie. The Caddy example disables automatic redirects, but an HTTPS site declaration **does not close TCP/80**. Use an isolated IP/edge firewall or equivalent network boundary, and DNS-01 or operator-managed TLS certificates that do not need HTTP-01. Verify from outside the host that TCP/80 for that address is unavailable. When an IP is shared with HTTP sites, do **not** call it strictly HTTPS-only. The example's `Set-Cookie` rewrite protects newly minted native cookies, not cookies already stored without `Secure`.
- The public hostname must be the exact fixed `publicOrigin` and a DSH `--trusted-host` authority.

### Same host or separate containers

With Caddy and DSH on one host, bind DSH to `127.0.0.1` and keep the default `trustedProxies` (loopback).

When Caddy runs in another container, DSH has to listen on its container address (DSH rejects wildcard binds such as `0.0.0.0`; pass the concrete address, for example from `hostname -i`). Put the two containers on a private network that nothing else joins, publish no DSH port to the host, and set `trustedProxies` to Caddy's address or that network, for example `DSH_OIDC_TRUSTED_PROXIES='["172.18.0.0/16"]'`. Without it `/auth/login` answers 403, because the client-address header from a non-trusted peer is ignored. Point the Caddyfile's `127.0.0.1:3080` upstreams at the DSH container name and port.

## Build and install into a profile

Run from this checkout. The commands create a separate `web-oidc` profile and do **not** alter an existing `web` profile:

```sh
export DSH_HOME=/path/to/isolated-dsh-home
npm ci
npm run check
TARBALL="$PWD/$(npm pack --silent | tail -n 1)"
# Initialize the profile from the shipped Web template without opening a listener.
dsh --profile web-oidc --from-default-profile web --dump-config >/dev/null
dsh plugin --profile web-oidc add "file:$TARBALL"
```

DSH checks the plugin's DSH peer range against the running release during `plugin add` and refuses an incompatible pair. Keep the tarball; the profile refers to it by path. Then install the example patch into the fresh profile, refusing to overwrite one that is already customized:

```sh
patch="$DSH_HOME/profiles/web-oidc/cordis.patch.yml"
if grep -vE '^\s*(#|$)' "$patch" | grep -qvx '\[\]'; then echo 'profile patch is not empty' >&2; exit 1; fi
install -m 600 examples/cordis.patch.yml "$patch"
```

**Upgrading from `@senti100/dsh-oidc`:** the package and the Cordis plugin id changed (`senti100-oidc` to `lumysia-oidc`). Remove the old package from the profile, add the new tarball, and update the `id` and `name` in the profile's patch to match `examples/cordis.patch.yml`. Also replace a `web-runtime` row that only sets `printUrl: false` with the full row from the example; the short form drops upstream's `openBrowser` setting, so DSH ignores `--no-open`. Upgrading DSH itself restarts it, which signs everyone out (sessions are in memory).

## Configure the OIDC provider and credentials

Create a confidential OIDC client at your provider with an **exact** redirect URI `https://dsh.example/auth/callback` (substitute your origin), authorization-code flow, and `openid profile email` scopes. Choose an explicit subject allowlist from the provider's `(issuer, sub)` identity; do not assume email alone gives stable identity. Bind admission at the provider **and** in `DSH_OIDC_ALLOWED_SUBJECTS`. The example reference `DSH_OIDC_CLIENT_SECRET_REF=DSH_OIDC_CLIENT_SECRET` names a credential, not its value. Never put its value in `.env.example`, the Cordis patch, command arguments, Caddy, or the Git repository. Inherited process environment or a managed DSH credential record can supply the named reference.

**Do not copy `.env.example` to a DSH `.env` file.** DSH treats the entire `DSH_*` prefix as bootstrap-only and rejects it from both the checkout and `$DSH_HOME/.env`. Use the example as a template for a restricted service-manager **process environment** instead. On a systemd deployment, create a private root-controlled `0600` `/etc/dsh-oidc/oidc.env` with the non-secret settings from [`.env.example`](../.env.example), substituting issuer, client ID, origin, and one quoted JSON subject tuple. Supply `DSH_OIDC_CLIENT_SECRET` through your service secret manager or as an additional entry in that private file; never in the public example. An illustrative unit fragment (adapt user, paths, and binary location):

```ini
[Service]
User=dsh
Environment=DSH_HOME=/srv/dsh-home
EnvironmentFile=/etc/dsh-oidc/oidc.env
ExecStart=/usr/local/bin/dsh --profile web-oidc --no-open --host 127.0.0.1 --port 3080 --trusted-host dsh.example
```

Systemd reads `EnvironmentFile` into the **inherited process environment**; this is different from DSH reading a `.env` layer. In a container, inject the same keys as process environment from a restricted secret source. Process environment can be inspected by sufficiently privileged local principals; use a dedicated service user. The issuer in each tuple must exactly match discovery, and the provider callback must exactly match `publicOrigin + /auth/callback`. A managed DSH credential record may supply the secret instead of the process variable if it is provisioned **before** the first login. Never print resolved config or credential values to logs.

Start DSH with that environment, for example `dsh --profile web-oidc --no-open --host 127.0.0.1 --port 3080 --trusted-host dsh.example`. The example patch sets **`web-runtime.config.printUrl: false`**; `--no-open` alone only stops DSH opening a browser. Confirm that a disposable startup writes no `/?token=` bearer URL to service logs **before** exposing the proxy.

## Proxy and browser checks

Adapt and validate [`examples/Caddyfile`](../examples/Caddyfile) against your Caddy binary and certificate/network layout. Replace `dsh.example`, the upstream address, and the TLS provisioner. Its `auto_https disable_redirects` is a **process-global** choice; when joining an existing multi-site Caddyfile, reconcile the existing global block and other sites' redirect policies instead of pasting it wholesale. HSTS in this template applies only to the named host; enable `includeSubDomains` only after verifying you control and serve every relevant subdomain. The example:

- passes only five **exact** `/auth` routes to the plugin and rejects unmatched `/auth/*` routes;
- strips client-supplied identity and address headers, then gates every other path with `/auth/check`;
- removes `Connection`/`Upgrade` only on the auth pre-check (the application proxy still upgrades WebSockets);
- makes newly issued `dsh-auth-*` cookies `Secure`, including deletion and already-Secure cases, and redacts URL queries from access logs.

Keep a backup of the prior proxy configuration. Do not turn on public routing until DSH and the provider are ready. With no browser cookies, check `/` and `/api` return 401 to API clients, `/auth/not-registered` returns 404, and `HEAD /auth/login` returns 204 (a 403 here usually means `trustedProxies` does not include the proxy). A browser navigation to any protected path is redirected to `/auth/signin`. Sign in in a real browser, then verify the clean DSH root, an API/workspace read and write, a native `dsh-auth-*` browser cookie marked **Secure**, and a working `/api/remote.mux` WebSocket (no persistent "Reconnecting"). Finally use the logout confirmation and POST, then check a stale native cookie cannot reach protected paths.

## Rollback and limitations

Preserve the original DSH profile/home and proxy configuration. On failure, restore the previous proxy and application pair together, verify its health, and leave the new profile disabled; do not delete the shared home or rotate the native signing key as a casual rollback. A restart of DSH invalidates the plugin's in-memory OIDC sessions. Provider-side policy revocation is not immediate for an existing local session; it takes effect at idle/absolute expiry or restart. Logout removes the outer session, not necessarily the native cookie, so the proxy gate remains mandatory. An HTTP redirect, HSTS, or a `Secure` rewrite cannot retroactively prevent an already-stored non-`Secure` cookie from being sent on a first HTTP request.

`npm run test:acceptance` (see the README) exercises a synthetic provider and the newest DSH Web release with the shipped Caddyfile and patch, and CI runs it. It does not certify your provider, your firewall, your container network, or a browser session in your environment.
