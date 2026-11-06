import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { applyEnvironment, readEnvironment } from '../src/env.js'

const issuer = 'https://id.example'
const row = {
  issuer: 'https://row.example',
  clientId: 'row-client',
  publicOrigin: 'https://row-dsh.example',
  allowedSubjects: [
    { issuer: 'https://row.example', subject: 'row-subject' },
    { issuer, subject: 'intruder' },
  ],
  trustedProxies: ['0.0.0.0/1', '128.0.0.0/1'],
  directLogin: false,
  sessionIdleTimeoutSeconds: 600,
}
const env = {
  DSH_OIDC_ISSUER: issuer,
  DSH_OIDC_CLIENT_ID: 'env-client',
  DSH_OIDC_PUBLIC_ORIGIN: 'https://dsh.example/',
  DSH_OIDC_ALLOWED_SUBJECTS: JSON.stringify(['env-subject']),
  DSH_OIDC_TRUSTED_PROXIES: JSON.stringify(['172.18.0.0/16']),
  DSH_OIDC_DIRECT_LOGIN: 'true',
}

describe('DSH_OIDC_* environment precedence', () => {
  it('replaces every field the environment sets and keeps the rest from the row', () => {
    const layer = readEnvironment(env, row)
    expect(layer.fields).toEqual([
      'issuer',
      'clientId',
      'publicOrigin',
      'allowedSubjects',
      'trustedProxies',
      'directLogin',
    ])
    const config = resolveConfig(applyEnvironment(row, layer))
    expect(config.issuerId).toBe(issuer)
    expect(config.clientId).toBe('env-client')
    expect(config.publicOrigin.href).toBe('https://dsh.example/')
    expect(config.directLogin).toBe(true)
    // The row cannot add subjects or proxies to an environment-set list.
    expect([...config.policy.allowedSubjects]).toEqual([`${issuer}\u0000env-subject`])
    expect(config.trustedProxies.entries).toEqual(['172.18.0.0/16'])
    expect(config.trustedProxies.has('10.0.0.1')).toBe(false)
    // Fields the environment leaves unset stay editable in the row.
    expect(config.sessionIdleTimeoutSeconds).toBe(600)
  })

  it('lets the row narrow admission with extra categories but never widen it', () => {
    const layer = readEnvironment(env, row)
    const config = resolveConfig(applyEnvironment({ ...row, allowedGroups: ['operators'] }, layer))
    expect(config.policy.allowedGroups.has('operators')).toBe(true)
    expect(config.policy.allowedSubjects.size).toBe(1)
  })

  it('ignores empty variables and accepts explicit issuer/subject pairs', () => {
    const layer = readEnvironment(
      {
        DSH_OIDC_ISSUER: '',
        DSH_OIDC_ALLOWED_SUBJECTS: JSON.stringify([{ issuer, subject: 's' }]),
        DSH_OIDC_ALLOWED_EMAILS: '["a@example.test"]',
        DSH_OIDC_ALLOWED_GROUPS: '["g"]',
        DSH_OIDC_CLIENT_SECRET_REF: 'REF',
      },
      row,
    )
    expect(layer.values.issuer).toBeUndefined()
    expect(layer.values.allowedSubjects).toEqual([{ issuer, subject: 's' }])
    expect(layer.values).toMatchObject({
      allowedEmails: ['a@example.test'],
      allowedGroups: ['g'],
      clientSecretRef: 'REF',
    })
  })

  it.each([
    [{ DSH_OIDC_ALLOWED_SUBJECTS: 'not json' }, /JSON array/u],
    [{ DSH_OIDC_ALLOWED_SUBJECTS: '{}' }, /JSON array/u],
    [{ DSH_OIDC_ALLOWED_SUBJECTS: '[1]' }, /subject strings/u],
    [{ DSH_OIDC_TRUSTED_PROXIES: '[1]' }, /array of strings/u],
    [{ DSH_OIDC_DIRECT_LOGIN: 'yes' }, /true or false/u],
  ])('rejects malformed variables %#', (variables, pattern) => {
    expect(() => readEnvironment(variables, row)).toThrow(pattern)
  })

  it('needs an issuer for bare subjects', () => {
    expect(() => readEnvironment({ DSH_OIDC_ALLOWED_SUBJECTS: '["s"]' }, {})).toThrow(/issuer/u)
  })

  it('fails closed when neither layer names a required field', () => {
    for (const missing of ['issuer', 'clientId', 'publicOrigin'] as const) {
      const partial = { ...row, [missing]: undefined }
      expect(() => resolveConfig(applyEnvironment(partial, readEnvironment({}, partial)))).toThrow(
        new RegExp(`${missing} is required`, 'u'),
      )
    }
    expect(() => resolveConfig({})).toThrow(/required/u)
    // A complete environment needs no row config at all.
    expect(resolveConfig(applyEnvironment({}, readEnvironment(env))).clientId).toBe('env-client')
  })
})
