import { createHash } from 'node:crypto'
import type { ResolvedConfig } from './config.js'
import type { Principal } from './policy.js'
import type { PersistedSession, SessionTable } from './state.js'

/**
 * Optional session persistence on DSH's storage-domain service. The domain is
 * one JSON unit under the Harness home (`storages/dsh_oidc_sessions.json`),
 * which DSH writes atomically with owner-only permissions.
 */
export const SESSION_DOMAIN = 'dsh_oidc_sessions'
export const SESSION_TABLE = 'sessions'

const TOKEN = /^[A-Za-z0-9_-]{43}$/u
const PRINCIPAL_TEXT = ['displayName', 'email', 'username', 'picture'] as const

function invalid(): never {
  throw new Error('invalid dsh-oidc session record')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) invalid()
  return value
}

function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

function principalOf(value: unknown): Principal {
  const raw = record(value)
  if (!Array.isArray(raw.groups) || raw.groups.length > 256) invalid()
  const principal: Record<string, unknown> = {
    issuer: text(raw.issuer),
    subject: text(raw.subject),
    groups: raw.groups.map(text),
  }
  for (const field of PRINCIPAL_TEXT)
    if (raw[field] !== undefined) principal[field] = text(raw[field])
  return principal as unknown as Principal
}

/**
 * Validate one stored record; DSH calls this on load and backs up and skips a
 * record that throws, so a damaged entry never admits anyone.
 */
export function parsePersistedSession(value: unknown): PersistedSession {
  const raw = record(value)
  const csrf = text(raw.csrf)
  if (!TOKEN.test(csrf)) invalid()
  return {
    principal: principalOf(raw.principal),
    issuedAt: time(raw.issuedAt),
    lastUsedAt: time(raw.lastUsedAt),
    expiresAt: time(raw.expiresAt),
    csrf,
    policy: text(raw.policy),
  }
}

export const sessionDomain = Object.freeze({
  name: SESSION_DOMAIN,
  version: 1,
  layout: 'single',
  invalidRecords: 'backup-and-skip',
  tables: { [SESSION_TABLE]: { valueSchema: { parse: parsePersistedSession } } },
} as const)

/**
 * A digest of everything that decided who may sign in. A restored session is
 * kept only when it matches, so narrowing the policy (or switching provider or
 * client) and restarting signs out everyone admitted under the old rules.
 */
export function policyFingerprint(config: ResolvedConfig): string {
  const sorted = (values: ReadonlySet<string>) => [...values].sort()
  const { policy } = config
  const material = JSON.stringify({
    issuer: config.issuerId,
    clientId: config.clientId,
    subjects: sorted(policy.allowedSubjects),
    emails: sorted(policy.allowedEmails),
    groups: sorted(policy.allowedGroups),
    groupMode: policy.groupMode,
    groupsClaim: policy.groupsClaim,
    requiredClaims: [...policy.requiredClaims]
      .map(([claim, allowed]) => [claim, sorted(allowed)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  })
  return createHash('sha256').update(material).digest('base64url')
}

/** The DSH storage-domain service, reduced to what this plugin calls. */
export interface SessionDomainFacility {
  open(spec: typeof sessionDomain): Promise<SessionDomain>
}

export interface SessionDomain {
  table(name: typeof SESSION_TABLE): SessionTable
  close(): Promise<void>
}
