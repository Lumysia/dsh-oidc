/** Browser half of `/_dsh-oidc/session`: the signed-in profile and the logout form. */

export const SESSION_PATH = '/_dsh-oidc/session'
export const LOGOUT_PATH = '/auth/logout'

export interface AccountProfile {
  readonly csrf: string
  readonly name?: string
  readonly username?: string
  readonly email?: string
  readonly picture?: string
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Validate the endpoint's JSON; anything malformed reads as signed out. */
export function parseProfile(value: unknown): AccountProfile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const csrf = optionalText(record.csrf)
  if (csrf === undefined) return undefined
  const name = optionalText(record.name)
  const username = optionalText(record.username)
  const email = optionalText(record.email)
  const picture = optionalText(record.picture)
  return {
    csrf,
    ...(name === undefined ? {} : { name }),
    ...(username === undefined ? {} : { username }),
    ...(email === undefined ? {} : { email }),
    ...(picture?.startsWith('https://') === true ? { picture } : {}),
  }
}

/** Read the current profile; undefined without a live OIDC session or on any failure. */
export async function fetchProfile(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AccountProfile | undefined> {
  try {
    const response = await fetcher(SESSION_PATH, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    return parseProfile(await response.json())
  } catch {
    return undefined
  }
}

/** Name shown beside the avatar: display name, then username, then email. */
export function profileLabel(profile: AccountProfile | undefined): string | undefined {
  return profile?.name ?? profile?.username ?? profile?.email
}

/** Up to two initials for the fallback avatar, like an address-book entry. */
export function initials(label: string | undefined): string {
  if (label === undefined) return ''
  const base = label.includes('@') ? (label.split('@', 1)[0] ?? label) : label
  const words = base
    .split(/[\s._-]+/u)
    .map((word) => word.trim())
    .filter((word) => word !== '')
  const letters =
    words.length >= 2
      ? [words[0], words[words.length - 1]].map((word) => Array.from(word ?? '')[0] ?? '')
      : Array.from(words[0] ?? '').slice(0, 1)
  return letters.join('').toLocaleUpperCase()
}

/**
 * Sign out through the plugin's CSRF-protected logout: a real form POST, so the
 * browser sends Origin and follows the redirect to the provider's end-session page.
 */
export function submitLogout(csrf: string, doc: Document = document): void {
  const form = doc.createElement('form')
  form.method = 'post'
  form.action = LOGOUT_PATH
  form.style.display = 'none'
  const field = doc.createElement('input')
  field.type = 'hidden'
  field.name = 'csrf'
  field.value = csrf
  form.appendChild(field)
  doc.body.appendChild(form)
  form.submit()
}
