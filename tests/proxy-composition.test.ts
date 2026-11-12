import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const caddy = readFileSync(new URL('../examples/Caddyfile', import.meta.url), 'utf8')
const nginx = readFileSync(new URL('../examples/nginx.conf', import.meta.url), 'utf8')
const traefikStatic = readFileSync(
  new URL('../examples/traefik/traefik.yml', import.meta.url),
  'utf8',
)
const traefikDynamic = readFileSync(
  new URL('../examples/traefik/dynamic.yml', import.meta.url),
  'utf8',
)
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dsh: { bundle: { patch: string }; client: { platform: string } }
  exports: Record<string, unknown>
}
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

describe('proxy and composition security examples', () => {
  it('ships a bundle layer that adds only the Host plugin row, without site values', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    expect(manifest.exports['./client']).toEqual({ default: './dist/client.js' })
    expect(manifest.dsh.client.platform).toBe('web')
    expect(patch).toContain("name: '@soffits/dsh-oidc'")
    expect(patch).toContain('- id: soffits-oidc')
    expect(patch).not.toContain("name: '@deepseek-ai/dsh-client-connection'")
    expect(patch).toContain('inject: [webServer, connection, credentials]')
    // Site values come from DSH_OIDC_* in the environment, never the shipped layer.
    const row = patch.slice(patch.indexOf('- id: soffits-oidc'))
    expect(row).not.toMatch(/^\s+(?:config|issuer|clientId|publicOrigin|allowedSubjects):/mu)
    expect(patch).not.toMatch(/clientSecret:\s/u)
    // A patch row replaces the whole config: keep upstream's other values so --no-open still works.
    expect(patch).toContain(
      '- id: web-runtime\n  config:\n    openBrowser: !!js ctx.webStartup.openBrowser\n    printUrl: false\n',
    )
    expect(patch).toContain('fail closed')
  })

  it('routes only exact auth endpoints and gates every other path before one reverse proxy', () => {
    const authAt = caddy.indexOf(
      '@oidcEndpoints path /auth/login /auth/callback /auth/check /auth/signin /auth/logout',
    )
    const routeAt = caddy.indexOf('route {', authAt)
    const authHandleAt = caddy.indexOf('handle @oidcEndpoints', routeAt)
    const denyAt = caddy.indexOf('handle /auth/*', authHandleAt)
    const genericAt = caddy.indexOf('handle {', denyAt)
    const forwardAt = caddy.indexOf('forward_auth 127.0.0.1:3080', genericAt)
    const applicationProxyAt = caddy.indexOf('reverse_proxy 127.0.0.1:3080', forwardAt)
    expect(authAt).toBeGreaterThan(0)
    expect(routeAt).toBeGreaterThan(authAt)
    expect(authHandleAt).toBeGreaterThan(routeAt)
    expect(denyAt).toBeGreaterThan(authHandleAt)
    expect(caddy.slice(denyAt, genericAt)).toContain('respond "not found" 404')
    expect(genericAt).toBeGreaterThan(denyAt)
    expect(forwardAt).toBeGreaterThan(genericAt)
    expect(caddy.slice(forwardAt, applicationProxyAt)).toContain('header_up -Connection')
    expect(caddy.slice(forwardAt, applicationProxyAt)).toContain('header_up -Upgrade')
    expect(caddy.slice(applicationProxyAt)).not.toContain('header_up -Upgrade')
    expect(applicationProxyAt).toBeGreaterThan(forwardAt)
    for (const path of ['root', 'assets', '/api', 'uploads', 'SSE', 'WebSocket'])
      expect(readme).toContain(path)
  })

  it('fixes public Host, strips identity headers, omits query logs, and documents HTTPS-only reachability', () => {
    expect(caddy).toContain('header_up Host {host}')
    expect(caddy).toContain('request_header -Authorization')
    expect(caddy).toContain('request_header -Proxy-Authorization')
    expect(caddy).toContain('request_header -X-Dsh-Oidc-Client-Ip')
    expect(caddy).toContain('header_up X-Dsh-Oidc-Client-Ip {remote_host}')
    expect(caddy).toContain('request_header -X-Forwarded-User')
    expect(caddy).toContain('request_header -X-Forwarded-Email')
    expect(caddy).toContain('request_header -X-Auth-Request-User')
    expect(caddy).toContain('request_header -X-Auth-Request-Email')
    expect(caddy).toContain('request_header -X-Remote-User')
    expect(caddy).toContain('request_header -Remote-User')
    expect(caddy).toContain('request>uri query delete')
    expect(caddy).toContain('Strict-Transport-Security')
    expect(caddy).toContain('auto_https disable_redirects')
    expect(caddy).toContain('>Set-Cookie')
    expect(caddy).toContain('dsh-auth-')
    expect(caddy).not.toMatch(/http:\/\/dsh\.example/u)
    expect(readme).toContain('do not expose HTTP port 80')
  })

  it('keeps the nginx example on the same routing, header and logging rules', () => {
    const stripped = [
      'Authorization',
      'Proxy-Authorization',
      'X-Forwarded-User',
      'X-Forwarded-Email',
      'X-Auth-Request-User',
      'X-Auth-Request-Email',
      'X-Remote-User',
      'Remote-User',
    ]
    for (const path of ['login', 'callback', 'check', 'signin', 'logout'])
      expect(nginx).toMatch(
        new RegExp(
          `location = /auth/${path} +\\{ proxy_pass http://dsh_oidc/auth/${path}; \\}`,
          'u',
        ),
      )
    expect(nginx).toMatch(/location \/auth\/ \{\s+return 404;/u)
    const checkAt = nginx.indexOf('location = /_dsh_oidc_check {')
    const appAt = nginx.indexOf('location / {', checkAt)
    const check = nginx.slice(checkAt, appAt)
    const server = nginx.slice(nginx.indexOf('server_name dsh.example;'), checkAt)
    expect(check).toContain('internal;')
    expect(check).toContain('proxy_pass_request_body off;')
    for (const block of [server, check]) {
      expect(block).toMatch(/proxy_set_header Host +\$host;/u)
      expect(block).toMatch(/proxy_set_header X-Dsh-Oidc-Client-Ip \$remote_addr;/u)
      for (const name of stripped)
        expect(block).toMatch(new RegExp(`proxy_set_header ${name} +"";`, 'u'))
    }
    for (const name of ['Upgrade', 'Connection', 'Content-Length'])
      expect(check).toMatch(new RegExp(`proxy_set_header ${name} +"";`, 'u'))
    expect(server).toMatch(/proxy_set_header Upgrade +\$http_upgrade;/u)
    const app = nginx.slice(appAt)
    expect(app).toContain('auth_request /_dsh_oidc_check;')
    expect(app).not.toContain('proxy_set_header')
    expect(nginx).toContain('proxy_cookie_flags ~^dsh-auth- secure;')
    const logFormatAt = nginx.indexOf('log_format dsh_oidc ')
    const logFormat = nginx.slice(logFormatAt, nginx.indexOf(';', logFormatAt))
    expect(logFormatAt).toBeGreaterThan(0)
    expect(logFormat).toContain('$uri')
    expect(nginx).toContain('access_log /var/log/nginx/dsh.access.log dsh_oidc;')
    expect(logFormat).not.toMatch(/\$request(?:_uri)?\b|\$args|\$query_string/u)
    expect(nginx).toMatch(/^\s+listen 443 ssl;$/mu)
    expect(nginx).not.toMatch(/^\s*listen\s+(?:\S+:)?80\b/mu)
  })

  it('keeps the Traefik example on the same routing and header rules', () => {
    expect(traefikDynamic).toContain(
      'Path(`/auth/login`) || Path(`/auth/callback`) ||\n        Path(`/auth/check`) || Path(`/auth/signin`) || Path(`/auth/logout`))',
    )
    expect(traefikDynamic).toContain('rule: Host(`dsh.example`) && !PathPrefix(`/auth/`)')
    expect(traefikDynamic).toContain('middlewares: [dsh-oidc-strip, dsh-oidc-check]')
    expect(traefikDynamic).toContain('middlewares: [dsh-oidc-strip, dsh-oidc-client-ip]')
    for (const name of [
      'Authorization',
      'Proxy-Authorization',
      'X-Dsh-Oidc-Client-Ip',
      'X-Forwarded-User',
      'X-Forwarded-Email',
      'X-Auth-Request-User',
      'X-Auth-Request-Email',
      'X-Remote-User',
      'Remote-User',
    ])
      expect(traefikDynamic).toContain(`          ${name}: ''`)
    expect(traefikDynamic).toContain('address: http://127.0.0.1:9180/auth/check')
    expect(traefikDynamic).toContain('preserveLocationHeader: true')
    expect(traefikDynamic).toContain('Host: dsh.example')
    expect(traefikStatic).toContain("address: '127.0.0.1:9180'")
    expect(traefikStatic).toContain('RequestPath: drop')
    expect(traefikStatic).not.toMatch(/address: '?:80'?/u)
  })

  it('states shared-operator behavior and stale-cookie denial', () => {
    expect(readme).toContain('Every admitted user shares the same DSH home')
    expect(readme).toContain('stale native DSH cookie')
    expect(readme).toContain('forward_auth /auth/check')
  })
})
