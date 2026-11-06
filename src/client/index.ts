/**
 * Browser half of @lumysia/dsh-oidc: the sidebar account button.
 *
 * It occupies `settings.launcher`, the seat at the sidebar foot that DSH's own
 * DeepSeek account menu fills, so it inherits that seat's geometry, the
 * Settings shortcut and focus return. It registers at a lower priority number
 * than the shipped account menu, so it is the one shown even when that menu is
 * enabled; DeepSeek sign-in stays reachable in Settings → Account.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AccountMenu, type ProfileSource } from './AccountMenu.js'
import { NS, en, zh } from './locales.js'
import { fetchProfile, submitLogout, type AccountProfile } from './profile.js'
import { installStyles } from './styles.js'

/** The slice of DSH's browser services this plugin calls. */
interface ClientServices {
  locale: {
    register(ns: string, locale: string, dict: Record<string, string>): () => void
  }
  slots: {
    inject(name: string, register: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

export const inject = ['slots', 'locale']

/** Registration priority in `settings.launcher`; lower renders, the shipped menu uses 0. */
export const LAUNCHER_PRIORITY = -1

function profileStore(): ProfileSource & {
  refresh(): Promise<void>
  dispose(): void
} {
  let current: AccountProfile | undefined
  const listeners = new Set<() => void>()
  let controller: AbortController | undefined
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async refresh() {
      controller?.abort()
      const own = new AbortController()
      controller = own
      const next = await fetchProfile(fetch, own.signal)
      if (own.signal.aborted) return
      current = next
      for (const listener of listeners) listener()
    },
    dispose() {
      controller?.abort()
      listeners.clear()
    },
  }
}

/** @param ctx - the browser plugin context. */
export function apply(ctx: Context): void {
  const services = ctx as unknown as Context & ClientServices
  ctx.effect(() => installStyles(), 'dsh-oidc: account styles')
  ctx.effect(() => {
    const disposers = [
      services.locale.register(NS, 'en', { ...en }),
      services.locale.register(NS, 'zh', { ...zh }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-oidc: dictionaries')
  const store = profileStore()
  ctx.effect(() => {
    void store.refresh()
    // A session that expired while the tab slept shows up on the next focus.
    const onFocus = () => {
      void store.refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      store.dispose()
    }
  }, 'dsh-oidc: profile')
  ctx.effect(
    () =>
      services.slots.inject('settings.launcher', () =>
        services.slots.register(
          {
            name: 'settings.launcher',
            priority: LAUNCHER_PRIORITY,
            locale: NS,
            inject: () => ({
              profile: store,
              signOut: (profile: AccountProfile) => {
                submitLogout(profile.csrf)
              },
            }),
          },
          AccountMenu,
        ),
      ),
    'dsh-oidc: sidebar account launcher',
  )
}
