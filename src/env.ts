import type { Config } from './config.js'

/**
 * Site settings the plugin reads from its own process environment. A variable
 * that is set and non-empty wins over the profile row's config for that field,
 * so the deployment's environment stays the source of truth and nothing edited
 * in the profile can replace it. Unset or empty variables leave the row's
 * value in place.
 */
export const ENVIRONMENT_FIELDS = {
  DSH_OIDC_ISSUER: 'issuer',
  DSH_OIDC_CLIENT_ID: 'clientId',
  DSH_OIDC_CLIENT_SECRET_REF: 'clientSecretRef',
  DSH_OIDC_PUBLIC_ORIGIN: 'publicOrigin',
  DSH_OIDC_ALLOWED_SUBJECTS: 'allowedSubjects',
  DSH_OIDC_ALLOWED_EMAILS: 'allowedEmails',
  DSH_OIDC_ALLOWED_GROUPS: 'allowedGroups',
  DSH_OIDC_TRUSTED_PROXIES: 'trustedProxies',
  DSH_OIDC_DIRECT_LOGIN: 'directLogin',
  DSH_OIDC_ALLOW_ANY_USER: 'allowAnyUser',
  DSH_OIDC_SENDER_CONTEXT: 'senderContext',
} as const satisfies Record<string, keyof Config>

export type EnvironmentVariable = keyof typeof ENVIRONMENT_FIELDS
export type EnvironmentField = (typeof ENVIRONMENT_FIELDS)[EnvironmentVariable]

export interface EnvironmentLayer {
  /** Field values the environment sets. */
  readonly values: Partial<Config>
  /** Fields the environment sets, in declaration order. */
  readonly fields: readonly EnvironmentField[]
}

function jsonArray(name: string, raw: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`dsh-oidc: ${name} must be a JSON array`)
  }
  if (!Array.isArray(parsed)) throw new Error(`dsh-oidc: ${name} must be a JSON array`)
  return parsed
}

function stringArray(name: string, raw: string): string[] {
  const values = jsonArray(name, raw)
  if (!values.every((value) => typeof value === 'string'))
    throw new Error(`dsh-oidc: ${name} must be a JSON array of strings`)
  return values
}

/**
 * `[{ "issuer": "...", "subject": "..." }]`, or bare subject strings that
 * belong to the issuer the environment or config names.
 */
function subjects(raw: string, issuer: string | undefined): Config['allowedSubjects'] {
  return jsonArray('DSH_OIDC_ALLOWED_SUBJECTS', raw).map((entry) => {
    if (typeof entry === 'string') {
      if (issuer === undefined)
        throw new Error('dsh-oidc: DSH_OIDC_ALLOWED_SUBJECTS bare subjects need an issuer')
      return { issuer, subject: entry }
    }
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { issuer?: unknown }).issuer === 'string' &&
      typeof (entry as { subject?: unknown }).subject === 'string'
    ) {
      const { issuer: entryIssuer, subject } = entry as { issuer: string; subject: string }
      return { issuer: entryIssuer, subject }
    }
    throw new Error(
      'dsh-oidc: DSH_OIDC_ALLOWED_SUBJECTS entries must be subject strings or { issuer, subject }',
    )
  })
}

function boolean(name: string, raw: string): boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`dsh-oidc: ${name} must be true or false`)
}

/** Read the DSH_OIDC_* variables; malformed values throw so the plugin refuses to start. */
export function readEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  config: Partial<Config> = {},
): EnvironmentLayer {
  const read = (name: EnvironmentVariable): string | undefined => {
    const value = env[name]
    return value === undefined || value === '' ? undefined : value
  }
  const values: Partial<Config> = {}
  const issuer = read('DSH_OIDC_ISSUER')
  if (issuer !== undefined) values.issuer = issuer
  const clientId = read('DSH_OIDC_CLIENT_ID')
  if (clientId !== undefined) values.clientId = clientId
  const secret = read('DSH_OIDC_CLIENT_SECRET_REF')
  if (secret !== undefined) values.clientSecretRef = secret
  const origin = read('DSH_OIDC_PUBLIC_ORIGIN')
  if (origin !== undefined) values.publicOrigin = origin
  const allowedSubjects = read('DSH_OIDC_ALLOWED_SUBJECTS')
  if (allowedSubjects !== undefined)
    values.allowedSubjects = subjects(allowedSubjects, issuer ?? config.issuer)
  const allowedEmails = read('DSH_OIDC_ALLOWED_EMAILS')
  if (allowedEmails !== undefined)
    values.allowedEmails = stringArray('DSH_OIDC_ALLOWED_EMAILS', allowedEmails)
  const allowedGroups = read('DSH_OIDC_ALLOWED_GROUPS')
  if (allowedGroups !== undefined)
    values.allowedGroups = stringArray('DSH_OIDC_ALLOWED_GROUPS', allowedGroups)
  const proxies = read('DSH_OIDC_TRUSTED_PROXIES')
  if (proxies !== undefined)
    values.trustedProxies = stringArray('DSH_OIDC_TRUSTED_PROXIES', proxies)
  const direct = read('DSH_OIDC_DIRECT_LOGIN')
  if (direct !== undefined) values.directLogin = boolean('DSH_OIDC_DIRECT_LOGIN', direct)
  const anyUser = read('DSH_OIDC_ALLOW_ANY_USER')
  if (anyUser !== undefined) values.allowAnyUser = boolean('DSH_OIDC_ALLOW_ANY_USER', anyUser)
  const sender = read('DSH_OIDC_SENDER_CONTEXT')
  if (sender !== undefined) values.senderContext = boolean('DSH_OIDC_SENDER_CONTEXT', sender)
  const fields = (Object.values(ENVIRONMENT_FIELDS) as EnvironmentField[]).filter(
    (field) => values[field] !== undefined,
  )
  return { values, fields }
}

/**
 * Overlay the environment on the row config. Fields the environment sets are
 * replaced, never merged, so profile config cannot widen an environment
 * allowlist or trust list. Extra allow categories in the profile still apply,
 * because categories are ANDed and can only narrow admission.
 */
export function applyEnvironment(
  config: Partial<Config>,
  layer: EnvironmentLayer,
): Partial<Config> {
  return { ...config, ...layer.values }
}
