/** Locale namespace for the sidebar account launcher. */
export const NS = 'soffits-oidc'

export const en = {
  menu: 'Account',
  settings: 'Settings',
  signOut: 'Sign out',
  signedIn: 'Signed in',
} as const

export type AccountKey = keyof typeof en

export const zh: Record<AccountKey, string> = {
  menu: '账户',
  settings: '设置',
  signOut: '退出登录',
  signedIn: '已登录',
}
