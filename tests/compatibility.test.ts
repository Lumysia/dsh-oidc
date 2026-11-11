import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, inject, name } from '../src/index.js'
import {
  REQUIRED_SEAMS,
  RuntimeCompatibilityError,
  assertRuntimeCompatibility,
} from '../src/compatibility.js'

// Compile-time seam checks against the installed DSH type declarations. If an
// upstream release changes one of these signatures, typecheck fails here.
type Assert<T extends true> = T
export type SeamTypes = [
  Assert<
    HostConnectionHandle['authenticatedUrl'] extends (baseUrl: string) => string ? true : false
  >,
  Assert<
    Parameters<WebServer['register']>[0] extends infer R
      ? WebRoute extends R
        ? true
        : false
      : false
  >,
  Assert<ReturnType<WebServer['register']> extends () => void ? true : false>,
  Assert<
    CredentialProvider['resolve'] extends (...args: never[]) => Promise<unknown> ? true : false
  >,
  Assert<Context['effect'] extends (...args: never[]) => unknown ? true : false>,
]

function host(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effect: () => undefined,
    webServer: { register: () => () => undefined },
    connection: { authenticatedUrl: (url: string) => url },
    credentials: { resolve: async () => undefined },
    ...overrides,
  }
}

const config = {
  issuer: 'https://id.example/tenant',
  clientId: 'client',
  publicOrigin: 'https://dsh.example',
  allowedSubjects: [{ issuer: 'https://id.example/tenant', subject: 'operator' }],
}

describe('DSH host seam check', () => {
  it('exposes the Cordis plugin shape', () => {
    expect(name).toBe('soffits-oidc')
    expect(inject).toEqual(['webServer', 'connection', 'credentials'])
    expect(typeof apply).toBe('function')
    expect(REQUIRED_SEAMS.map(({ service }) => service).sort()).toEqual([...inject].sort())
  })

  it('declares DSH peer ranges instead of exact versions', async () => {
    const manifest = (await import('../package.json', { with: { type: 'json' } })).default
    for (const peer of [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-host-webserver',
    ] as const) {
      expect(manifest.peerDependencies[peer]).toBe(manifest.engines.dsh)
    }
    expect(manifest.engines.dsh).toMatch(/^>=0\.2\.1-rc\.1 <0\.3\.0-0$/u)
  })

  it('accepts a host that provides every seam', () => {
    expect(() => assertRuntimeCompatibility(host())).not.toThrow()
  })

  it.each([
    ['webServer', { webServer: {} }, 'ctx.webServer.register()'],
    ['connection', { connection: { authenticatedUrl: 'not-a-function' } }, 'authenticatedUrl'],
    ['credentials', { credentials: undefined }, 'ctx.credentials.resolve()'],
    ['effect', { effect: undefined }, 'ctx.effect()'],
  ])('names a missing %s seam', (_label, overrides, expected) => {
    let thrown: unknown
    try {
      assertRuntimeCompatibility(host(overrides))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RuntimeCompatibilityError)
    const error = thrown as RuntimeCompatibilityError
    expect(error.code).toBe('DSH_OIDC_UNSUPPORTED_RUNTIME')
    expect(error.missing).toHaveLength(1)
    expect(error.message).toContain(expected)
  })

  it('treats a throwing getter as a missing seam', () => {
    const ctx = host()
    Object.defineProperty(ctx, 'connection', {
      get() {
        throw new Error('service not ready')
      },
    })
    expect(() => assertRuntimeCompatibility(ctx)).toThrow(/authenticatedUrl/u)
    expect(() => assertRuntimeCompatibility(null)).toThrow(RuntimeCompatibilityError)
  })

  it('registers no route when a seam is missing', async () => {
    const routes: unknown[] = []
    const ctx = host({
      connection: {},
      webServer: { register: (route: unknown) => routes.push(route) },
    }) as unknown as Context
    await expect(apply(ctx, config)).rejects.toBeInstanceOf(RuntimeCompatibilityError)
    expect(routes).toEqual([])
  })

  it('registers the complete exact authentication route set through the public webserver seam', async () => {
    const routes: Array<{ kind: string; path: string }> = []
    const effects: Array<() => void> = []
    const ctx = host({
      logger: {},
      webServer: {
        register(route: { kind: string; path: string }) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index !== -1) routes.splice(index, 1)
          }
        },
      },
      effect(factory: () => () => void) {
        effects.push(factory())
      },
    }) as unknown as Context

    await apply(ctx, config)

    expect(routes.map(({ kind, path }) => ({ kind, path }))).toEqual([
      { kind: 'exact', path: '/auth/login' },
      { kind: 'exact', path: '/auth/callback' },
      { kind: 'exact', path: '/auth/check' },
      { kind: 'exact', path: '/auth/signin' },
      { kind: 'exact', path: '/_dsh-oidc/session' },
      { kind: 'exact', path: '/auth/logout' },
    ])
    expect(effects).toHaveLength(6)
    for (const dispose of effects) dispose()
    expect(routes).toEqual([])
  })

  it('takes a bare bundle row from the environment and registers nothing when it is incomplete', async () => {
    const saved = { ...process.env }
    const routes: unknown[] = []
    const info: string[] = []
    const ctx = host({
      logger: { info: (message: string) => info.push(message) },
      webServer: { register: (route: unknown) => routes.push(route) },
      effect: (factory: () => unknown) => factory(),
    }) as unknown as Context
    try {
      for (const key of Object.keys(process.env))
        if (key.startsWith('DSH_OIDC_')) Reflect.deleteProperty(process.env, key)
      await expect(apply(ctx, undefined)).rejects.toThrow(/issuer is required/u)
      expect(routes).toEqual([])
      Object.assign(process.env, {
        DSH_OIDC_ISSUER: 'https://id.example',
        DSH_OIDC_CLIENT_ID: 'client',
        DSH_OIDC_PUBLIC_ORIGIN: 'https://dsh.example/',
        DSH_OIDC_ALLOWED_SUBJECTS: '["operator"]',
      })
      await apply(ctx, undefined)
      expect(routes).toHaveLength(6)
      expect(info.join('\n')).toContain('issuer, clientId, publicOrigin, allowedSubjects')
      expect(info.join('\n')).not.toContain('operator')
    } finally {
      for (const key of Object.keys(process.env))
        if (key.startsWith('DSH_OIDC_')) Reflect.deleteProperty(process.env, key)
      Object.assign(process.env, saved)
    }
  })
})
