import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Principal } from './policy.js'

/**
 * Sender context: tell the model which signed-in person wrote each Web prompt.
 *
 * DSH admits every browser as one shared owner Peer, so nothing in a prompt
 * says who sent it. This plugin already knows: the browser's OIDC session
 * cookie names a verified principal. The pieces:
 *
 * 1. `connection/request` wraps every authenticated `/api` request. When the
 *    request carries a live OIDC session, the rest of that request runs inside
 *    an AsyncLocalStorage scope holding the principal. Nothing the client
 *    sends besides the session cookie is read.
 * 2. `agent/inbox/inserted` fires synchronously while the prompt RPC admits
 *    its message. A Web prompt message (source `user` with an `rpcId`) that
 *    enters an inbox inside an open scope is remembered by message id.
 * 3. `agent/pre-step` puts a one-line sender notice in front of each
 *    remembered message when it enters a step, so the notice is committed to
 *    the session log next to the message it describes.
 *
 * A scope closes when its request settles and after its first claim. Work the
 * request merely started (an agent turn, a subagent, a timer) inherits the
 * AsyncLocalStorage store but finds it closed, so Telegram, scheduled jobs and
 * agent-to-agent messages never get a Web sender.
 */

/** Source kind of the notice message this plugin adds. */
export const SENDER_SOURCE_KIND = 'oidc-sender'

const MAX_LABEL_LENGTH = 64
const MAX_SUBJECT_LENGTH = 255
const MAX_SUMMARY_LENGTH = 120
/** Remembered prompts waiting for their step; the oldest go first past this. */
export const MAX_PENDING_SENDERS = 1_024

interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** The parts of a DSH message this plugin reads or writes. */
export interface SenderMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly unknown[]
  readonly source: { readonly kind: string; readonly [key: string]: unknown }
}

/** DSH's pre-step decision, reduced to what this plugin touches. */
export type SenderStepDecision =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: readonly SenderMessage[] }

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/inbox/inserted'(payload: { message: SenderMessage }): void
    'agent/inbox/discarded'(payload: { message: SenderMessage }): void
    'agent/pre-step'(
      payload: { messages: readonly SenderMessage[]; signal: AbortSignal },
      next: () => Promise<SenderStepDecision>,
    ): Promise<SenderStepDecision>
  }
}

/** The event surface this plugin listens on; a Cordis context satisfies it. */
export interface SenderEvents {
  on(
    name: 'connection/request',
    listener: (
      request: IncomingMessage,
      response: ServerResponse,
      next: () => Promise<void>,
    ) => Promise<void>,
  ): unknown
  on(
    name: 'agent/inbox/inserted' | 'agent/inbox/discarded',
    listener: (payload: { message: SenderMessage }) => void,
  ): unknown
  on(
    name: 'agent/pre-step',
    listener: (
      payload: { messages: readonly SenderMessage[]; signal: AbortSignal },
      next: () => Promise<SenderStepDecision>,
    ) => Promise<SenderStepDecision>,
  ): unknown
}

/** What the notice says about one sender. */
export interface Sender {
  readonly issuer: string
  readonly subject: string
  readonly label: string
}

interface RequestScope {
  readonly sender: Sender
  open: boolean
}

/** Keep letters, digits, spaces and a few name characters; nothing that could close the tag. */
function cleanLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const cleaned = value
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} ._@'-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length === 0) return undefined
  const graphemes = Array.from(new Intl.Segmenter().segment(cleaned), ({ segment }) => segment)
  return graphemes.length > MAX_LABEL_LENGTH
    ? graphemes.slice(0, MAX_LABEL_LENGTH).join('').trim()
    : cleaned
}

/** The subject as printable ASCII without brackets; a provider's UUID passes unchanged. */
function cleanSubject(value: string): string {
  return value.replace(/[^\x21-\x7e]|[()[\]]/gu, '?').slice(0, MAX_SUBJECT_LENGTH)
}

/** Name the sender by preferred_username, then name, then email. */
export function senderOf(principal: Principal): Sender {
  return {
    issuer: principal.issuer,
    subject: cleanSubject(principal.subject),
    label:
      cleanLabel(principal.username) ??
      cleanLabel(principal.displayName) ??
      cleanLabel(principal.email) ??
      'unnamed user',
  }
}

/** The line the model reads, shaped like the Telegram bot's sender line. */
export function senderTag(sender: Sender): string {
  return `[Web message from ${sender.label} (oidc sub ${sender.subject})]`
}

/** A prompt typed into the Web UI: the session controller's user-rpc source (inbox messages are all user-role). */
export function isWebPrompt(message: SenderMessage): boolean {
  return message.source.kind === 'user' && typeof message.source.rpcId === 'string'
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** The notice message that goes in front of the sender's prompt. */
export function senderNotice(sender: Sender): SenderMessage {
  const text = senderTag(sender)
  const summary =
    text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text
  const content: readonly TextBlock[] = [{ type: 'text', text }]
  return deepFreeze({
    id: randomUUID(),
    role: 'user' as const,
    content,
    source: {
      kind: SENDER_SOURCE_KIND,
      form: 'notice',
      summary,
      issuer: sender.issuer,
      subject: sender.subject,
      label: sender.label,
    },
  })
}

/**
 * Register the three listeners. `principalOf` reads the request's own OIDC
 * session and returns undefined for anything else.
 */
export function applySenderContext(
  events: SenderEvents,
  principalOf: (request: IncomingMessage) => Principal | undefined,
): void {
  const requests = new AsyncLocalStorage<RequestScope>()
  const pending = new Map<string, Sender>()

  events.on('connection/request', async (request, _response, next) => {
    const principal = principalOf(request)
    if (principal === undefined) return next()
    const scope: RequestScope = { sender: senderOf(principal), open: true }
    try {
      await requests.run(scope, next)
    } finally {
      scope.open = false
    }
  })

  events.on('agent/inbox/inserted', ({ message }) => {
    const scope = requests.getStore()
    if (scope?.open !== true || !isWebPrompt(message)) return
    // One prompt per request: whatever this request goes on to start is not its prompt.
    scope.open = false
    pending.delete(message.id)
    pending.set(message.id, scope.sender)
    if (pending.size > MAX_PENDING_SENDERS) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
  })

  events.on('agent/inbox/discarded', ({ message }) => {
    pending.delete(message.id)
  })

  events.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || pending.size === 0) return decision
    if (!decision.messages.some((message) => pending.has(message.id))) return decision
    const messages: SenderMessage[] = []
    for (const message of decision.messages) {
      const sender = pending.get(message.id)
      if (sender !== undefined) {
        pending.delete(message.id)
        messages.push(senderNotice(sender))
      }
      messages.push(message)
    }
    return { ...decision, messages }
  })
}
