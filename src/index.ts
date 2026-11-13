import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { OidcAdmission } from './admission.js'
import { RuntimeCompatibilityError, assertRuntimeCompatibility } from './compatibility.js'
import { Config, resolveConfig, type Config as OidcConfig, type ResolvedConfig } from './config.js'
import { applyEnvironment, readEnvironment } from './env.js'
import { OpenIdClientProtocol } from './oidc.js'
import {
  SESSION_TABLE,
  policyFingerprint,
  sessionDomain,
  type SessionDomainFacility,
} from './persistence.js'
import { applySenderContext } from './sender.js'
import type { SessionPersistence } from './state.js'

export { Config }
export type { OidcConfig as ConfigType }
export { authorizeClaims, type Principal } from './policy.js'
export { resolveConfig } from './config.js'
export { SESSION_DOMAIN, parsePersistedSession, policyFingerprint } from './persistence.js'
export { ENVIRONMENT_FIELDS, applyEnvironment, readEnvironment } from './env.js'
export { REQUIRED_SEAMS, RuntimeCompatibilityError } from './compatibility.js'
export { SENDER_SOURCE_KIND, senderOf, senderTag } from './sender.js'
export const name = 'soffits-oidc'
export const inject = ['webServer', 'connection', 'credentials']

/** Same-origin profile read for the sidebar account button; guarded by the proxy like the app. */
export const SESSION_PATH = '/_dsh-oidc/session'

/**
 * Register Host-only OIDC routes alongside the unchanged native Connection plugin.
 * DSH_OIDC_* environment values win over the row config field by field; an
 * incomplete or invalid result throws, so no route registers and the proxy's
 * `/auth/check` subrequest fails closed.
 */
export async function apply(ctx: Context, rawConfig: OidcConfig | undefined): Promise<void> {
  const rowConfig = rawConfig ?? {}
  const environment = readEnvironment(process.env, rowConfig)
  const config = resolveConfig(applyEnvironment(rowConfig, environment))
  if (environment.fields.length > 0)
    ctx.logger.info(`dsh-oidc: from environment: ${environment.fields.join(', ')}`)
  assertRuntimeCompatibility(ctx)
  if (!config.persistSessions) {
    await serve(ctx, config)
    return
  }
  // Routes register only once the stored sessions are loaded, so until then
  // the proxy's `/auth/check` subrequest fails closed.
  ctx.inject(['storageDomain'], async (sub) => {
    const facility = member(sub, 'storageDomain') as SessionDomainFacility | undefined
    if (typeof member(facility, 'open') !== 'function')
      throw new RuntimeCompatibilityError([
        'ctx.storageDomain.open() (persistSessions session store)',
      ])
    const domain = await facility!.open(sessionDomain)
    sub.effect(() => () => domain.close(), 'dsh-oidc: session store')
    await serve(sub, config, {
      table: domain.table(SESSION_TABLE),
      policy: policyFingerprint(config),
      onError: () => sub.logger.warn('dsh-oidc: session store write failed'),
    })
  })
}

function member(target: unknown, key: string): unknown {
  return typeof target === 'object' && target !== null
    ? (target as Record<string, unknown>)[key]
    : undefined
}

/**
 * Build the admission, load any persisted sessions, then register its routes
 * (and the sender line) on `ctx`.
 */
async function serve(
  ctx: Context,
  config: ResolvedConfig,
  persistence?: SessionPersistence,
): Promise<void> {
  const admission = new OidcAdmission(
    config,
    ctx.credentials,
    ctx.connection,
    new OpenIdClientProtocol(config),
    ctx.logger,
    persistence,
  )
  if (persistence !== undefined) {
    const restored = await admission.restoreSessions()
    ctx.logger.info(`dsh-oidc: restored ${String(restored)} persisted session(s)`)
  }
  const routes: readonly WebRoute[] = [
    { kind: 'exact', path: '/auth/login', handler: (req, res) => admission.login(req, res) },
    { kind: 'exact', path: '/auth/callback', handler: (req, res) => admission.callback(req, res) },
    { kind: 'exact', path: '/auth/check', handler: (req, res) => admission.check(req, res) },
    {
      kind: 'exact',
      path: '/auth/signin',
      handler: (req, res) => admission.signin(req, res),
    },
    { kind: 'exact', path: SESSION_PATH, handler: (req, res) => admission.session(req, res) },
    {
      kind: 'exact',
      path: '/auth/logout',
      handler: (req, res) =>
        req.method === 'POST' ? admission.logout(req, res) : admission.logoutConfirmation(req, res),
    },
  ]
  for (const route of routes)
    ctx.effect(() => ctx.webServer.register(route), `dsh-oidc: ${route.path}`)
  if (config.senderContext) applySenderContext(ctx, (req) => admission.principalOf(req))
}
