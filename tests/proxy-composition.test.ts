import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const caddy = readFileSync(new URL('../examples/Caddyfile', import.meta.url), 'utf8')
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

  it('states shared-operator behavior and stale-cookie denial', () => {
    expect(readme).toContain('Every admitted user shares the same DSH home')
    expect(readme).toContain('stale native DSH cookie')
    expect(readme).toContain('forward_auth /auth/check')
  })
})
