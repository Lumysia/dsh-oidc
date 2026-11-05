import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { authorizeClaims } from '../src/policy.js'

const base = {
  issuer: 'https://id.example/application/o/dsh/',
  clientId: 'client',
  publicOrigin: 'https://dsh.example',
  allowedSubjects: [{ issuer: 'https://id.example/application/o/dsh/', subject: 'subject-1' }],
}

describe('configuration and policy', () => {
  it('resolves fixed URLs, defaults, and credential references', () => {
    const config = resolveConfig({ ...base, clientSecretRef: 'OIDC_CLIENT_SECRET' })
    expect(config.issuer.href).toBe('https://id.example/application/o/dsh/')
    expect(config.publicOrigin.href).toBe('https://dsh.example/')
    expect(config.redirectUri).toBe('https://dsh.example/auth/callback')
    expect(config.clientSecretRef).toBe('OIDC_CLIENT_SECRET')
    expect(config.scopes).toContain('openid')
  })

  it('defaults trusted proxies to loopback and parses addresses and CIDR ranges', () => {
    const defaults = resolveConfig(base).trustedProxies
    expect(defaults.entries).toEqual(['127.0.0.0/8', '::1'])
    expect(defaults.has('127.0.0.1')).toBe(true)
    expect(defaults.has('127.8.9.10')).toBe(true)
    expect(defaults.has('::1')).toBe(true)
    expect(defaults.has('::ffff:127.0.0.1')).toBe(true)
    expect(defaults.has('10.0.0.1')).toBe(false)
    expect(defaults.has('not-an-ip')).toBe(false)

    const custom = resolveConfig({
      ...base,
      trustedProxies: ['10.0.0.0/8', '192.0.2.7', 'fd12:3456::/48', '::ffff:198.51.100.0/24'],
    }).trustedProxies
    expect(custom.has('10.200.0.1')).toBe(true)
    expect(custom.has('192.0.2.7')).toBe(true)
    expect(custom.has('192.0.2.8')).toBe(false)
    expect(custom.has('fd12:3456:0:1::9')).toBe(true)
    expect(custom.has('fd12:3457::1')).toBe(false)
    expect(custom.has('198.51.100.4')).toBe(true)
    expect(custom.has('127.0.0.1')).toBe(false)
  })

  it.each([
    [[], /explicitly empty/u],
    [['0.0.0.0/0'], /every address/u],
    [['::/0'], /every address/u],
    [['10.0.0.0/33'], /invalid prefix/u],
    [['fd00::/129'], /invalid prefix/u],
    [['10.0.0.0/08'], /invalid prefix/u],
    [['10.0.0.0/'], /invalid prefix/u],
    [['10.0.0.0/8/8'], /not an IP or CIDR/u],
    [['proxy.internal'], /not an IP or CIDR/u],
    [[' 10.0.0.1'], /exact strings/u],
    [['10.0.0.1', '10.0.0.1'], /duplicates/u],
  ])('rejects invalid trustedProxies %#', (trustedProxies, pattern) => {
    expect(() => resolveConfig({ ...base, trustedProxies })).toThrow(pattern)
  })

  it.each([
    [{ ...base, issuer: 'http://id.example' }, /HTTPS/u],
    [{ ...base, publicOrigin: 'https://dsh.example/path' }, /path \/?/u],
    [{ ...base, scopes: ['profile'] }, /openid/u],
    [{ ...base, allowedSubjects: [] }, /explicitly empty/u],
    [{ ...base, allowedSubjects: [{ issuer: base.issuer, subject: ' x' }] }, /exact strings/u],
    [
      {
        ...base,
        allowedSubjects: [
          { issuer: base.issuer, subject: 'x' },
          { issuer: base.issuer, subject: 'x' },
        ],
      },
      /duplicates/u,
    ],
    [{ ...base, sessionMaxAgeSeconds: 60, sessionIdleTimeoutSeconds: 61 }, /idle timeout/u],
    [{ ...base, requiredClaims: { department: [] } }, /must not be empty/u],
  ])('rejects invalid config %#', (input, pattern) => {
    expect(() => resolveConfig(input)).toThrow(pattern)
  })

  it('ANDs configured categories while allowing values within a category', () => {
    const policy = resolveConfig({
      ...base,
      allowedGroups: ['operators'],
      requiredClaims: { department: ['engineering', 'security'] },
    }).policy
    const issuer = 'https://id.example/application/o/dsh/'
    expect(
      authorizeClaims(
        { iss: issuer, sub: 'subject-1', groups: ['operators'], department: 'engineering' },
        issuer,
        policy,
      )?.subject,
    ).toBe('subject-1')
    expect(
      authorizeClaims(
        { iss: issuer, sub: 'subject-1', groups: ['operators'], department: ['security'] },
        issuer,
        policy,
      )?.groups,
    ).toEqual(['operators'])
    expect(
      authorizeClaims(
        { iss: issuer, sub: 'other', groups: ['operators'], department: 'engineering' },
        issuer,
        policy,
      ),
    ).toBeUndefined()
    expect(
      authorizeClaims(
        { iss: issuer, sub: 'subject-1', groups: ['OPERATORS'], department: 'engineering' },
        issuer,
        policy,
      ),
    ).toBeUndefined()
  })

  it('enforces all-group mode and rejects malformed or duplicate group claims', () => {
    const groupOnly = {
      issuer: base.issuer,
      clientId: base.clientId,
      publicOrigin: base.publicOrigin,
    }
    const policy = resolveConfig({
      ...groupOnly,
      allowedGroups: ['a', 'b'],
      groupMode: 'all',
    }).policy
    const claims = { iss: 'https://id.example/application/o/dsh', sub: 's' }
    expect(
      authorizeClaims({ ...claims, groups: ['a', 'b'], name: 'Operator' }, claims.iss, policy)
        ?.displayName,
    ).toBe('Operator')
    expect(authorizeClaims({ ...claims, groups: ['a'] }, claims.iss, policy)).toBeUndefined()
    for (const malformedGroups of [
      'a',
      [],
      ['a', ''],
      ['a', 'x'.repeat(513)],
      ['a', 'a', 'b'],
      ['a', 2, 'b'],
      Array.from({ length: 257 }, (_, index) => `g${String(index)}`),
    ]) {
      expect(
        authorizeClaims({ ...claims, groups: malformedGroups }, claims.iss, policy),
      ).toBeUndefined()
    }
  })

  it('treats email as an exact additional category rather than identity', () => {
    const policy = resolveConfig({ ...base, allowedEmails: ['operator@example.test'] }).policy
    const claims = { iss: base.issuer, sub: 'subject-1' }
    expect(
      authorizeClaims(
        { ...claims, email: 'operator@example.test', email_verified: true },
        base.issuer,
        policy,
      ),
    ).toBeDefined()
    expect(
      authorizeClaims({ ...claims, email: 'Operator@example.test' }, base.issuer, policy),
    ).toBeUndefined()
    expect(
      authorizeClaims({ ...claims, email: ['operator@example.test'] }, base.issuer, policy),
    ).toBeUndefined()
    for (const email_verified of [undefined, false, 'true', 1, null]) {
      expect(
        authorizeClaims(
          { ...claims, email: 'operator@example.test', email_verified },
          base.issuer,
          policy,
        ),
      ).toBeUndefined()
    }
  })
})
