import type { AuthorizationPolicy } from './config.js'

const MAX_GROUPS = 256
const MAX_GROUP_LENGTH = 512

export interface Principal {
  readonly issuer: string
  readonly subject: string
  readonly displayName?: string
  readonly email?: string
  readonly username?: string
  /** HTTPS profile picture URL from the `picture` claim. */
  readonly picture?: string
  readonly groups: readonly string[]
}

const MAX_PROFILE_LENGTH = 256
const MAX_PICTURE_LENGTH = 2048

function profileText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PROFILE_LENGTH
    ? value
    : undefined
}

/** Keep only an absolute HTTPS URL without credentials; anything else falls back to initials. */
function pictureUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_PICTURE_LENGTH) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

function exactArrayClaimValues(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GROUPS) return undefined
  if (
    !value.every(
      (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_GROUP_LENGTH,
    )
  )
    return undefined
  return new Set(value).size === value.length ? value : undefined
}

function exactCustomClaimValues(value: unknown): readonly string[] | undefined {
  if (typeof value === 'string')
    return value.length > 0 && value.length <= MAX_GROUP_LENGTH ? [value] : undefined
  return exactArrayClaimValues(value)
}

/** Apply exact subject/group/claim admission policy to validated ID-token claims. */
export function authorizeClaims(
  claims: Readonly<Record<string, unknown>>,
  expectedIssuer: string,
  policy: AuthorizationPolicy,
): Principal | undefined {
  if (claims.iss !== expectedIssuer || typeof claims.sub !== 'string' || claims.sub.length === 0)
    return undefined
  const subjectAllowed =
    policy.allowedSubjects.size === 0 ||
    policy.allowedSubjects.has(`${expectedIssuer}\u0000${claims.sub}`)
  const emailAllowed =
    policy.allowedEmails.size === 0 ||
    (typeof claims.email === 'string' &&
      claims.email_verified === true &&
      policy.allowedEmails.has(claims.email))
  let groups: readonly string[] = []
  let groupAllowed = false
  if (policy.allowedGroups.size > 0) {
    const parsed = exactArrayClaimValues(claims[policy.groupsClaim])
    if (parsed === undefined) return undefined
    groups = parsed
    groupAllowed =
      policy.groupMode === 'all'
        ? [...policy.allowedGroups].every((group) => parsed.includes(group))
        : parsed.some((group) => policy.allowedGroups.has(group))
  }
  if (!subjectAllowed || !emailAllowed || (policy.allowedGroups.size > 0 && !groupAllowed))
    return undefined
  for (const [claim, allowed] of policy.requiredClaims) {
    const actual = exactCustomClaimValues(claims[claim])
    if (actual === undefined || !actual.some((value) => allowed.has(value))) return undefined
  }
  const display = profileText(claims.name)
  const email = profileText(claims.email)
  const username = profileText(claims.preferred_username)
  const picture = pictureUrl(claims.picture)
  return {
    issuer: expectedIssuer,
    subject: claims.sub,
    ...(display === undefined ? {} : { displayName: display }),
    ...(email === undefined ? {} : { email }),
    ...(username === undefined ? {} : { username }),
    ...(picture === undefined ? {} : { picture }),
    groups,
  }
}
