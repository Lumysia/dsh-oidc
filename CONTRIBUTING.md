# Contributing

Use Node 24.9 or newer. Install with `npm ci` and run `npm run check` before proposing a change.

Security behavior requires negative tests. Changes to OIDC, cookies, policy, sessions, CSRF, routes, credentials, DSH versions, or proxy examples must add fail-closed coverage and update the README/SECURITY documentation. Never add live secrets, real client IDs, subject IDs, group names, provider exports, or deployment hostnames.

Keep the native DSH Connection row intact. Use only public DSH APIs; when the plugin starts calling a new one, add it to `REQUIRED_SEAMS` in `src/compatibility.ts`. Widen the DSH peer range only after `npm run test:acceptance` passes against that release.
