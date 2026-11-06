// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The real primitives are DSH's shared page modules; the browser half is
// rendered against them in the acceptance test.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: () => null,
  IconSettingsOutlineMedium: () => null,
}))
import { apply, inject, LAUNCHER_PRIORITY } from '../src/client/index.js'
import { NS, en, zh } from '../src/client/locales.js'
import {
  fetchProfile,
  initials,
  parseProfile,
  profileLabel,
  submitLogout,
} from '../src/client/profile.js'
import { CSS, STYLE_ID, installStyles } from '../src/client/styles.js'

afterEach(() => {
  vi.restoreAllMocks()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('account profile', () => {
  it('keeps only expected string fields and HTTPS pictures', () => {
    expect(parseProfile(null)).toBeUndefined()
    expect(parseProfile({ name: 'x' })).toBeUndefined()
    expect(
      parseProfile({
        csrf: 'c',
        name: 'Ada Lovelace',
        username: '',
        email: 'ada@example.test',
        picture: 'http://id.example/a.png',
        groups: ['admin'],
      }),
    ).toEqual({ csrf: 'c', name: 'Ada Lovelace', email: 'ada@example.test' })
    expect(
      parseProfile({ csrf: 'c', picture: 'https://id.example/a.png', username: 'ada' }),
    ).toEqual({ csrf: 'c', picture: 'https://id.example/a.png', username: 'ada' })
  })

  it('labels by name, then username, then email', () => {
    expect(profileLabel(undefined)).toBeUndefined()
    expect(profileLabel({ csrf: 'c', email: 'e@example.test' })).toBe('e@example.test')
    expect(profileLabel({ csrf: 'c', username: 'u', email: 'e' })).toBe('u')
    expect(profileLabel({ csrf: 'c', name: 'N', username: 'u' })).toBe('N')
  })

  it('derives initials like DSH and address books do', () => {
    expect(initials(undefined)).toBe('')
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('ada')).toBe('A')
    expect(initials('grace.hopper@example.test')).toBe('GH')
    expect(initials('李 小龙')).toBe('李小')
    expect(initials('  ')).toBe('')
  })

  it('reads the session endpoint same-origin and treats failures as signed out', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ csrf: 'c', name: 'N' })))
    expect(await fetchProfile(ok as unknown as typeof fetch)).toEqual({ csrf: 'c', name: 'N' })
    expect(ok).toHaveBeenCalledWith(
      '/_dsh-oidc/session',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    )
    const denied = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    expect(await fetchProfile(denied as unknown as typeof fetch)).toBeUndefined()
    const broken = vi.fn(async () => {
      throw new TypeError('network')
    })
    expect(
      await fetchProfile(broken as unknown as typeof fetch, new AbortController().signal),
    ).toBeUndefined()
  })

  it('signs out with a hidden form POST carrying the CSRF value', () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    submitLogout('csrf-value')
    const form = document.querySelector('form')
    expect(form?.getAttribute('method')).toBe('post')
    expect(form?.getAttribute('action')).toBe('/auth/logout')
    expect(form?.querySelector<HTMLInputElement>('input[name="csrf"]')?.value).toBe('csrf-value')
    expect(submit).toHaveBeenCalledOnce()
  })
})

describe('styles and locales', () => {
  it('installs one stylesheet built on DSH theme tokens and removes it', () => {
    const dispose = installStyles()
    expect(installStyles()).toBeTypeOf('function')
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1)
    expect(CSS).toContain('var(--dsw-alias-interactive-bg-hover)')
    expect(CSS).toContain('var(--dsw-radius-md)')
    dispose()
    expect(document.getElementById(STYLE_ID)).toBeNull()
  })

  it('has the same keys in English and Chinese', () => {
    expect(NS).toBe('lumysia-oidc')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('client plugin', () => {
  it('registers the launcher ahead of the DeepSeek menu and cleans up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ csrf: 'c', name: 'N' }))),
    )
    const disposers: Array<() => void> = []
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const dictionaries: string[] = []
    const ctx = {
      effect(factory: () => () => void) {
        disposers.push(factory())
      },
      locale: {
        register(ns: string, locale: string) {
          dictionaries.push(`${ns}:${locale}`)
          return () => undefined
        },
      },
      slots: {
        inject(_name: string, register: () => () => void) {
          return register()
        },
        register(options: Record<string, unknown>, component: unknown) {
          registrations.push({ options, component })
          return () => undefined
        },
      },
    }
    expect(inject).toEqual(['slots', 'locale'])
    apply(ctx as never)
    expect(dictionaries).toEqual(['lumysia-oidc:en', 'lumysia-oidc:zh'])
    expect(registrations).toHaveLength(1)
    const [registration] = registrations
    expect(registration?.options).toMatchObject({
      name: 'settings.launcher',
      priority: LAUNCHER_PRIORITY,
      locale: NS,
    })
    expect(LAUNCHER_PRIORITY).toBeLessThan(0)
    const face = (
      registration?.options.inject as () => {
        profile: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }
        signOut(profile: { csrf: string }): void
      }
    )()
    const seen = vi.fn()
    const unsubscribe = face.profile.subscribe(seen)
    await vi.waitFor(() => {
      expect(face.profile.getSnapshot()).toEqual({ csrf: 'c', name: 'N' })
    })
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      expect(seen).toHaveBeenCalledTimes(2)
    })
    unsubscribe()
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    face.signOut({ csrf: 'c' })
    expect(submit).toHaveBeenCalledOnce()
    for (const dispose of disposers) dispose()
    expect(document.getElementById(STYLE_ID)).toBeNull()
    vi.unstubAllGlobals()
  })
})
