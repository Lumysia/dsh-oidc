/**
 * Sidebar account launcher geometry and colours. Adapted from DeepSeek
 * Harness's `@deepseek-ai/dsh-client-ui-settings-account` AccountMenu and
 * AccountAvatar stylesheets (MIT, see THIRD_PARTY_NOTICES.md) so the button
 * matches the launcher it replaces: the same sidebar row tokens, 44px signed-in
 * row, 24px avatar, 36px collapsed rail button and hover fill.
 */
export const STYLE_ID = 'soffits-dsh-oidc-account'

export const CLASS = {
  root: 'soffits-oidc-account',
  anchor: 'soffits-oidc-account-anchor',
  trigger: 'soffits-oidc-account-trigger',
  avatar: 'soffits-oidc-account-avatar',
  image: 'soffits-oidc-account-image',
  initials: 'soffits-oidc-account-initials',
  label: 'soffits-oidc-account-label',
} as const

export const CSS = `
.${CLASS.root} { flex: 1; min-width: 0; }
.${CLASS.root}[data-inset='true'] { margin-inline: 2px; }
.${CLASS.anchor} { width: 100%; }
.${CLASS.trigger} { user-select: none; display: flex; align-items: center; width: 100%; height: 44px; gap: 8px;
  padding: 6px; border: 0; box-sizing: border-box; border-radius: var(--dsw-radius-md); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; cursor: pointer; }
.${CLASS.trigger}[data-collapsed='true'] { width: 36px; height: 36px; justify-content: center; gap: 0; padding: 0; }
@media (hover: hover) { .${CLASS.trigger}:hover { background-color: var(--dsw-alias-interactive-bg-hover); } }
.${CLASS.trigger}:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.${CLASS.avatar} { display: flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px;
  border-radius: 50%; corner-shape: round; overflow: hidden; background: var(--dsw-alias-bg-skeleton);
  color: var(--dsw-alias-label-tertiary); }
.${CLASS.image} { display: block; width: 100%; height: 100%; border-radius: 50%; corner-shape: round; object-fit: cover; }
.${CLASS.initials} { font-size: 11px; font-weight: 500; line-height: 1; color: var(--dsw-alias-label-secondary); }
.${CLASS.label} { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`

/**
 * Add the stylesheet once.
 * @returns disposer removing it again.
 */
export function installStyles(doc: Document = document): () => void {
  if (doc.getElementById(STYLE_ID) !== null) return () => undefined
  const tag = doc.createElement('style')
  tag.id = STYLE_ID
  tag.dataset.plugin = '@soffits/dsh-oidc'
  tag.textContent = CSS
  doc.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}
