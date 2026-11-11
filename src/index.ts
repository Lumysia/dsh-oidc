import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { OidcAdmission } from './admission.js'
import { assertRuntimeCompatibility } from './compatibility.js'
import { Config, resolveConfig, type Config as OidcConfig } from './config.js'
import { applyEnvironment, readEnvironment } from './env.js'
import { OpenIdClientProtocol } from './oidc.js'

export { Config }
export type { OidcConfig as ConfigType }
export { authorizeClaims, type Principal } from './policy.js'
export { resolveConfig } from './config.js'
export { ENVIRONMENT_FIELDS, applyEnvironment, readEnvironment } from './env.js'
export { REQUIRED_SEAMS, RuntimeCompatibilityError } from './compatibility.js'
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
  const admission = new OidcAdmission(
    config,
    ctx.credentials,
    ctx.connection,
    new OpenIdClientProtocol(config),
    ctx.logger,
  )
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
}
