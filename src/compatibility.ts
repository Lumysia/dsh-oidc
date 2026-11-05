/**
 * The DSH host APIs this plugin calls. Each entry names the injected service,
 * the member that must be a function, and what the plugin uses it for.
 *
 * DSH is pre-stable, so instead of pinning package versions the plugin checks
 * at startup that every API it calls is present. A release that renames or
 * removes one of them fails loudly before any route is registered; a release
 * that keeps them keeps working without a new plugin version.
 */
export const REQUIRED_SEAMS = [
  { service: 'webServer', member: 'register', use: 'exact /auth/* route registration' },
  { service: 'connection', member: 'authenticatedUrl', use: 'native DSH cookie bootstrap' },
  { service: 'credentials', member: 'resolve', use: 'client secret lookup' },
] as const

export class RuntimeCompatibilityError extends Error {
  readonly code = 'DSH_OIDC_UNSUPPORTED_RUNTIME'

  constructor(readonly missing: readonly string[]) {
    super(
      `dsh-oidc: this DSH release does not provide ${missing.join(', ')}; ` +
        'look for a dsh-oidc release that supports it',
    )
    this.name = 'RuntimeCompatibilityError'
  }
}

function member(target: unknown, name: string): unknown {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null)
    return undefined
  try {
    return (target as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

/** Refuse to start when the host lacks an API the plugin calls, before route registration. */
export function assertRuntimeCompatibility(ctx: unknown): void {
  const missing: string[] = []
  if (typeof member(ctx, 'effect') !== 'function') missing.push('ctx.effect()')
  for (const seam of REQUIRED_SEAMS) {
    if (typeof member(member(ctx, seam.service), seam.member) !== 'function')
      missing.push(`ctx.${seam.service}.${seam.member}() (${seam.use})`)
  }
  if (missing.length > 0) throw new RuntimeCompatibilityError(missing)
}
