import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Principal } from './policy.js'

const TOKEN_BYTES = 32
const SAFE_TOKEN = /^[A-Za-z0-9_-]{43}$/u
export const SESSION_COOKIE = '__Host-dsh-oidc-session'
export const TRANSACTION_COOKIE = '__Host-dsh-oidc-transaction'

export interface AuthorizationTransaction {
  readonly id: string
  readonly state: string
  readonly nonce: string
  readonly verifier: string
  readonly expiresAt: number
}

export interface SessionView {
  readonly principal: Principal
  readonly issuedAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly csrf: string
}

function opaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function equalToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class AuthorizationTransactions {
  private readonly entries = new Map<string, AuthorizationTransaction>()

  constructor(
    private readonly maxAgeMilliseconds: number,
    private readonly maxEntries: number,
  ) {}

  create(verifier: string, nonce: string, now = Date.now()): AuthorizationTransaction | undefined {
    this.prune(now)
    if (this.entries.size >= this.maxEntries) return undefined
    const transaction = {
      id: opaqueToken(),
      state: opaqueToken(),
      nonce,
      verifier,
      expiresAt: now + this.maxAgeMilliseconds,
    }
    this.entries.set(digest(transaction.id), transaction)
    return transaction
  }

  consume(
    id: string | undefined,
    state: string | undefined,
    now = Date.now(),
  ): AuthorizationTransaction | undefined {
    if (id === undefined || !SAFE_TOKEN.test(id)) return undefined
    const key = digest(id)
    const transaction = this.entries.get(key)
    this.entries.delete(key)
    if (
      state === undefined ||
      !SAFE_TOKEN.test(state) ||
      transaction === undefined ||
      transaction.expiresAt <= now
    )
      return undefined
    return equalToken(id, transaction.id) && equalToken(state, transaction.state)
      ? transaction
      : undefined
  }

  get size(): number {
    return this.entries.size
  }

  private prune(now: number): void {
    for (const [key, value] of this.entries) if (value.expiresAt <= now) this.entries.delete(key)
  }
}

/**
 * One session as written to the optional persistent store. The record is keyed
 * by the SHA-256 digest of the cookie value; the cookie value itself is never
 * stored, so a copy of the store cannot be turned back into a working cookie.
 */
export interface PersistedSession {
  readonly principal: Principal
  readonly issuedAt: number
  readonly lastUsedAt: number
  readonly expiresAt: number
  readonly csrf: string
  /** Fingerprint of the issuer, client and allow policy the session was admitted under. */
  readonly policy: string
}

/** The slice of a DSH storage-domain table the session store uses. */
export interface SessionTable {
  entries(): Iterable<[string, PersistedSession]>
  put(key: string, value: PersistedSession): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface SessionPersistence {
  readonly table: SessionTable
  /** Current policy fingerprint; restored sessions with another one are dropped. */
  readonly policy: string
  /** Called with a failed store write; the in-memory state stays authoritative. */
  readonly onError: (error: unknown) => void
}

/**
 * How often a session's last-use time is written back. The proxy checks every
 * request, so writing each one would rewrite the store constantly. A restored
 * session can therefore idle out up to this much early, never late.
 */
export const LAST_USED_WRITE_INTERVAL = 60_000

const DIGEST = /^[A-Za-z0-9_-]{43}$/u

interface StoredSession extends SessionView {
  readonly idleTimeoutMilliseconds: number
  /** Last-use time most recently written to the persistent store. */
  readonly writtenLastUsedAt: number
}

export class BrowserSessions {
  private readonly entries = new Map<string, StoredSession>()

  constructor(
    private readonly maxAgeMilliseconds: number,
    private readonly idleTimeoutMilliseconds: number,
    private readonly maxEntries: number,
    private readonly persistence?: SessionPersistence,
  ) {}

  /**
   * Load the persistent store into memory. Records admitted under another
   * issuer, client or policy, records past the current absolute or idle limits,
   * and records beyond the session cap are dropped and deleted from the store.
   * @returns the number of sessions restored.
   */
  async restore(now = Date.now()): Promise<number> {
    const persistence = this.persistence
    if (persistence === undefined) return 0
    const stale: string[] = []
    const live: Array<[string, PersistedSession]> = []
    for (const [key, record] of persistence.table.entries()) {
      const expiresAt = Math.min(record.expiresAt, record.issuedAt + this.maxAgeMilliseconds)
      if (
        !DIGEST.test(key) ||
        record.policy !== persistence.policy ||
        record.issuedAt > now ||
        expiresAt <= now ||
        record.lastUsedAt + this.idleTimeoutMilliseconds <= now
      )
        stale.push(key)
      else live.push([key, { ...record, expiresAt }])
    }
    // Keep the most recently used sessions when the cap shrank.
    live.sort(([, a], [, b]) => b.lastUsedAt - a.lastUsedAt)
    for (const [key, record] of live) {
      if (this.entries.size >= this.maxEntries) {
        stale.push(key)
        continue
      }
      this.entries.set(key, {
        principal: record.principal,
        issuedAt: record.issuedAt,
        lastUsedAt: record.lastUsedAt,
        expiresAt: record.expiresAt,
        csrf: record.csrf,
        idleTimeoutMilliseconds: this.idleTimeoutMilliseconds,
        writtenLastUsedAt: record.lastUsedAt,
      })
    }
    await Promise.all(stale.map((key) => this.remove(key)))
    return this.entries.size
  }

  create(
    principal: Principal,
    now = Date.now(),
  ): { readonly value: string; readonly expiresAt: number; readonly csrf: string } | undefined {
    this.prune(now)
    if (this.entries.size >= this.maxEntries) return undefined
    const value = opaqueToken()
    const csrf = opaqueToken()
    const expiresAt = now + this.maxAgeMilliseconds
    const key = digest(value)
    const session: StoredSession = {
      principal,
      issuedAt: now,
      lastUsedAt: now,
      expiresAt,
      csrf,
      idleTimeoutMilliseconds: this.idleTimeoutMilliseconds,
      writtenLastUsedAt: now,
    }
    this.entries.set(key, session)
    this.write(key, session)
    return { value, expiresAt, csrf }
  }

  read(value: string | undefined, now = Date.now()): SessionView | undefined {
    if (value === undefined || !SAFE_TOKEN.test(value)) return undefined
    const key = digest(value)
    const session = this.entries.get(key)
    if (session === undefined) return undefined
    if (session.expiresAt <= now || session.lastUsedAt + session.idleTimeoutMilliseconds <= now) {
      void this.remove(key)
      return undefined
    }
    const due = now - session.writtenLastUsedAt >= LAST_USED_WRITE_INTERVAL
    const updated = {
      ...session,
      lastUsedAt: now,
      writtenLastUsedAt: due ? now : session.writtenLastUsedAt,
    }
    this.entries.set(key, updated)
    if (due) this.write(key, updated)
    return updated
  }

  /**
   * Revoke a session. With a persistent store the returned promise settles
   * once the deletion is written, so a logout answered afterwards stays
   * revoked across a restart.
   */
  async delete(value: string | undefined): Promise<void> {
    if (value !== undefined && SAFE_TOKEN.test(value)) await this.remove(digest(value))
  }

  get size(): number {
    return this.entries.size
  }

  private prune(now: number): void {
    for (const [key, value] of this.entries) {
      if (value.expiresAt <= now || value.lastUsedAt + value.idleTimeoutMilliseconds <= now)
        void this.remove(key)
    }
  }

  private async remove(key: string): Promise<void> {
    this.entries.delete(key)
    const persistence = this.persistence
    if (persistence === undefined) return
    try {
      await persistence.table.delete(key)
    } catch (error) {
      persistence.onError(error)
    }
  }

  private write(key: string, session: StoredSession): void {
    const persistence = this.persistence
    if (persistence === undefined) return
    const record: PersistedSession = {
      principal: session.principal,
      issuedAt: session.issuedAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      csrf: session.csrf,
      policy: persistence.policy,
    }
    persistence.table.put(key, record).catch(persistence.onError)
  }
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; start: number }>()
  constructor(
    private readonly limit: number,
    private readonly windowMilliseconds = 60_000,
    private readonly maxKeys = 10_000,
  ) {}
  admit(key: string, now = Date.now()): boolean {
    const prior = this.windows.get(key)
    if (prior === undefined || prior.start + this.windowMilliseconds <= now) {
      for (const [candidate, window] of this.windows) {
        if (window.start + this.windowMilliseconds <= now) this.windows.delete(candidate)
      }
      if (!this.windows.has(key) && this.windows.size >= this.maxKeys) return false
      this.windows.set(key, { count: 1, start: now })
      return true
    }
    if (prior.count >= this.limit) return false
    prior.count += 1
    return true
  }
}

export function readCookie(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined
  for (const segment of raw.split(';')) {
    const at = segment.indexOf('=')
    if (at !== -1 && segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

export function secureCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

export function expiredCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`
}
