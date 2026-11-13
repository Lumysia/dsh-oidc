import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeCompatibilityError } from '../src/compatibility.js'
import { resolveConfig } from '../src/config.js'
import { apply } from '../src/index.js'
import {
  SESSION_DOMAIN,
  SESSION_TABLE,
  parsePersistedSession,
  policyFingerprint,
  sessionDomain,
} from '../src/persistence.js'
import {
  BrowserSessions,
  LAST_USED_WRITE_INTERVAL,
  type PersistedSession,
  type SessionTable,
} from '../src/state.js'

const principal = {
  issuer: 'https://id.example',
  subject: 's',
  email: 'a@b.example',
  groups: ['g'],
}

class MemoryTable implements SessionTable {
  readonly rows = new Map<string, PersistedSession>()
  puts = 0
  fail = false
  entries() {
    return this.rows.entries()
  }
  async put(key: string, value: PersistedSession) {
    if (this.fail) throw new Error('disk full')
    this.puts += 1
    this.rows.set(key, value)
  }
  async delete(key: string) {
    if (this.fail) throw new Error('disk full')
    return this.rows.delete(key)
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('base64url')
const settle = () => new Promise((resolve) => setImmediate(resolve))

function store(table: MemoryTable, policy = 'p1', maxAge = 10_000, idle = 1_000, cap = 10) {
  const onError = vi.fn()
  return { sessions: new BrowserSessions(maxAge, idle, cap, { table, policy, onError }), onError }
}

describe('persisted browser sessions', () => {
  it('writes only the digest of the cookie value and restores the session after a restart', async () => {
    const table = new MemoryTable()
    const session = store(table).sessions.create(principal, 100)!
    await settle()
    expect([...table.rows.keys()]).toEqual([digest(session.value)])
    expect(JSON.stringify([...table.rows])).not.toContain(session.value)
    expect(table.rows.get(digest(session.value))?.policy).toBe('p1')

    const { sessions } = store(table)
    expect(await sessions.restore(200)).toBe(1)
    const view = sessions.read(session.value, 200)
    expect(view?.principal).toEqual(principal)
    expect(view?.csrf).toBe(session.csrf)
    expect(view?.expiresAt).toBe(100 + 10_000)
  })

  it('makes logout revocation durable before it returns', async () => {
    const table = new MemoryTable()
    const { sessions } = store(table)
    const session = sessions.create(principal, 100)!
    await settle()
    await sessions.delete(session.value)
    expect(table.rows.size).toBe(0)
    const restarted = store(table).sessions
    expect(await restarted.restore(200)).toBe(0)
    expect(restarted.read(session.value, 200)).toBeUndefined()
  })

  it('drops and deletes records from another policy, past their limits, or malformed keys', async () => {
    const table = new MemoryTable()
    const make = (
      policy: string,
      issuedAt: number,
      lastUsedAt = issuedAt,
      expiresAt = issuedAt + 10_000,
    ) => ({
      principal,
      issuedAt,
      lastUsedAt,
      expiresAt,
      csrf: 'c'.repeat(43),
      policy,
    })
    table.rows.set('a'.repeat(43), make('p1', 5_000)) // live
    table.rows.set('b'.repeat(43), make('old-policy', 5_000))
    table.rows.set('c'.repeat(43), make('p1', 0, 4_000, 100)) // absolutely expired
    table.rows.set('d'.repeat(43), make('p1', 4_000, 4_000)) // idle since 4000
    table.rows.set('e'.repeat(43), make('p1', 0, 5_400, 50_000)) // stored expiry beyond the current max age
    table.rows.set('f'.repeat(43), make('p1', 9_000)) // issued in the future
    table.rows.set('short', make('p1', 5_000))
    const { sessions } = store(table, 'p1', 10_000, 1_000)
    expect(await sessions.restore(5_500)).toBe(2)
    expect([...table.rows.keys()].sort()).toEqual(['a'.repeat(43), 'e'.repeat(43)])

    const tighter = store(table, 'p1', 5_000, 1_000).sessions
    expect(await tighter.restore(5_500)).toBe(1)
    expect([...table.rows.keys()]).toEqual(['a'.repeat(43)])
  })

  it('keeps the most recently used sessions when the cap shrank', async () => {
    const table = new MemoryTable()
    const first = store(table).sessions
    const older = first.create(principal, 100)!
    const newer = first.create(principal, 200)!
    await settle()
    const capped = store(table, 'p1', 10_000, 1_000, 1).sessions
    expect(await capped.restore(300)).toBe(1)
    expect(capped.read(newer.value, 300)).toBeDefined()
    expect(capped.read(older.value, 300)).toBeUndefined()
    expect(table.rows.size).toBe(1)
  })

  it('writes the last-use time at most once per interval, so a restart can only idle out early', async () => {
    const table = new MemoryTable()
    const { sessions } = store(table, 'p1', 1_000_000, 200_000)
    const session = sessions.create(principal, 0)!
    await settle()
    expect(table.puts).toBe(1)
    sessions.read(session.value, LAST_USED_WRITE_INTERVAL - 1)
    await settle()
    expect(table.puts).toBe(1)
    sessions.read(session.value, LAST_USED_WRITE_INTERVAL + 10)
    await settle()
    expect(table.puts).toBe(2)
    expect(table.rows.get(digest(session.value))?.lastUsedAt).toBe(LAST_USED_WRITE_INTERVAL + 10)
  })

  it('deletes expired sessions from the store when they are read or pruned', async () => {
    const table = new MemoryTable()
    const { sessions } = store(table, 'p1', 10_000, 100)
    const read = sessions.create(principal, 0)!
    await settle()
    expect(sessions.read(read.value, 500)).toBeUndefined()
    await settle()
    expect(table.rows.size).toBe(0)
    sessions.create(principal, 1_000)
    sessions.create(principal, 2_000)
    await settle()
    expect(table.rows.size).toBe(1)
  })

  it('keeps serving from memory and reports a failed store write', async () => {
    const table = new MemoryTable()
    table.fail = true
    const { sessions, onError } = store(table)
    const session = sessions.create(principal, 0)!
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(sessions.read(session.value, 10)).toBeDefined()
    await sessions.delete(session.value)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(sessions.read(session.value, 20)).toBeUndefined()
  })
})

describe('stored record validation', () => {
  const good = {
    principal: { ...principal, displayName: 'A' },
    issuedAt: 1,
    lastUsedAt: 2,
    expiresAt: 3,
    csrf: 'x'.repeat(43),
    policy: 'p',
  }

  it('accepts a well-formed record and drops unknown principal fields', () => {
    expect(parsePersistedSession({ ...good, principal: { ...good.principal, extra: 1 } })).toEqual(
      good,
    )
  })

  it.each([
    ['null', null],
    ['array', []],
    ['short csrf', { ...good, csrf: 'x' }],
    ['missing policy', { ...good, policy: undefined }],
    ['float time', { ...good, expiresAt: 1.5 }],
    ['negative time', { ...good, issuedAt: -1 }],
    ['string time', { ...good, lastUsedAt: '2' }],
    ['no subject', { ...good, principal: { issuer: 'i', groups: [] } }],
    ['groups not array', { ...good, principal: { ...principal, groups: 'g' } }],
    ['non-string group', { ...good, principal: { ...principal, groups: [1] } }],
    ['non-string email', { ...good, principal: { ...principal, email: 5 } }],
  ])('rejects %s', (_label, value) => {
    expect(() => parsePersistedSession(value)).toThrow()
  })

  it('declares a valid DSH storage unit', () => {
    expect(SESSION_DOMAIN).toMatch(/^[a-z][a-z0-9_]*$/u)
    expect(sessionDomain.layout).toBe('single')
    expect(sessionDomain.invalidRecords).toBe('backup-and-skip')
    expect(Object.keys(sessionDomain.tables)).toEqual([SESSION_TABLE])
  })
})

describe('policy fingerprint', () => {
  const base = {
    issuer: 'https://id.example',
    clientId: 'client',
    publicOrigin: 'https://dsh.example',
    allowedEmails: ['a@x.example', 'b@x.example'],
  }

  it('is stable across list order and changes when admission rules change', () => {
    const fingerprint = policyFingerprint(resolveConfig(base))
    expect(
      policyFingerprint(resolveConfig({ ...base, allowedEmails: ['b@x.example', 'a@x.example'] })),
    ).toBe(fingerprint)
    for (const change of [
      { allowedEmails: ['a@x.example'] },
      { clientId: 'other' },
      { issuer: 'https://id.example/other' },
      { allowedGroups: ['admins'] },
      { requiredClaims: { tenant: ['t'] } },
    ])
      expect(policyFingerprint(resolveConfig({ ...base, ...change }))).not.toBe(fingerprint)
    // Lifetimes are re-applied on restore, so they do not sign anyone out.
    expect(policyFingerprint(resolveConfig({ ...base, sessionMaxAgeSeconds: 3600 }))).toBe(
      fingerprint,
    )
  })
})

describe('plugin wiring', () => {
  const config = {
    issuer: 'https://id.example/tenant',
    clientId: 'client',
    publicOrigin: 'https://dsh.example',
    allowedSubjects: [{ issuer: 'https://id.example/tenant', subject: 'operator' }],
    persistSessions: true,
  }

  function host(storageDomain: unknown) {
    const routes: string[] = []
    const injected: string[][] = []
    const disposers: Array<() => unknown> = []
    let pending: Promise<unknown> = Promise.resolve()
    const ctx: Record<string, unknown> = {
      logger: { info: vi.fn(), warn: vi.fn() },
      webServer: { register: (route: { path: string }) => routes.push(route.path) },
      connection: { authenticatedUrl: (url: string) => url },
      credentials: { resolve: async () => undefined },
      effect: (factory: () => unknown) => {
        const result = factory()
        if (typeof result === 'function') disposers.push(result as () => unknown)
      },
      storageDomain,
      inject(deps: string[], callback: (sub: unknown) => Promise<void>) {
        injected.push(deps)
        pending = callback(ctx)
      },
    }
    return { ctx: ctx as unknown as Context, routes, injected, disposers, done: () => pending }
  }

  it('opens the session domain, restores it, and only then registers routes', async () => {
    const table = new MemoryTable()
    const close = vi.fn(async () => undefined)
    let opened: unknown
    const facility = {
      open: async (spec: unknown) => {
        opened = spec
        return { table: () => table, close }
      },
    }
    const { ctx, routes, injected, disposers, done } = host(facility)
    await apply(ctx, config)
    expect(injected).toEqual([['storageDomain']])
    await done()
    expect(opened).toBe(sessionDomain)
    expect(routes).toHaveLength(6)
    for (const dispose of disposers) await dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it('registers no route when the storage service lacks open()', async () => {
    const { ctx, routes, done } = host({})
    await apply(ctx, config)
    await expect(done()).rejects.toBeInstanceOf(RuntimeCompatibilityError)
    expect(routes).toEqual([])
  })

  it('registers no route when the store cannot be opened', async () => {
    const { ctx, routes, done } = host({ open: async () => Promise.reject(new Error('locked')) })
    await apply(ctx, config)
    await expect(done()).rejects.toThrow('locked')
    expect(routes).toEqual([])
  })

  it('leaves the default in-memory path untouched', async () => {
    const { ctx, routes, injected } = host(undefined)
    await apply(ctx, { ...config, persistSessions: false })
    expect(injected).toEqual([])
    expect(routes).toHaveLength(6)
  })
})
