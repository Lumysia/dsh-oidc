import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect } from 'node:net'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { exportJWK, importPKCS8, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface HttpResult {
  readonly status: number
  readonly headers: string
  readonly body: string
}

interface BrowserModule {
  readonly chromium: {
    executablePath(): string
    launch(options: Record<string, unknown>): Promise<Browser>
  }
}

interface Browser {
  newContext(options?: Record<string, unknown>): Promise<BrowserContext>
  close(): Promise<void>
}

interface BrowserContext {
  newPage(): Promise<Page>
  cookies(urls?: string | readonly string[]): Promise<Cookie[]>
  addCookies(cookies: readonly Cookie[]): Promise<void>
  close(): Promise<void>
  request: {
    post(url: string, options: Record<string, unknown>): Promise<{ status(): number }>
  }
}

interface Cookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly expires: number
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite: 'Strict' | 'Lax' | 'None'
}

interface Locator {
  getAttribute(name: string): Promise<string | null>
  inputValue(): Promise<string>
  click(options?: Record<string, unknown>): Promise<void>
  textContent(): Promise<string | null>
  waitFor(options?: Record<string, unknown>): Promise<void>
  screenshot(options?: Record<string, unknown>): Promise<Buffer>
  first(): Locator
  count(): Promise<number>
}

interface Page {
  goto(url: string, options?: Record<string, unknown>): Promise<{ status(): number } | null>
  title(): Promise<string>
  url(): string
  locator(selector: string): Locator
  getByRole(role: string, options?: Record<string, unknown>): Locator
  emulateMedia(options: Record<string, unknown>): Promise<void>
  waitForFunction<A>(
    callback: (argument: A) => unknown,
    argument: A,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  screenshot(options?: Record<string, unknown>): Promise<Buffer>
  keyboard: { press(key: string): Promise<void> }
  mouse: { click(x: number, y: number): Promise<void> }
  waitForNavigation(options?: Record<string, unknown>): Promise<{ status(): number } | null>
  waitForURL(url: string, options?: Record<string, unknown>): Promise<void>
  waitForResponse(
    predicate: (response: { url(): string }) => boolean,
  ): Promise<{ status(): number }>
  reload(options?: Record<string, unknown>): Promise<{ status(): number } | null>
  evaluate<R, A>(callback: (argument: A) => R | Promise<R>, argument: A): Promise<R>
}

const execFileAsync = promisify(execFile)
const caddyBinary = required('DSH_OIDC_CADDY_BIN')
const runRoot = required('DSH_OIDC_RUN_ROOT')
const runtime = required('DSH_OIDC_RUNTIME')
const dshHome = required('DSH_HOME')
const controlledFailure = process.env.DSH_OIDC_CONTROLLED_SETUP_FAILURE === '1'
const stackRoot = join(runRoot, controlledFailure ? 'failure-stack' : 'stack')
const profilePatch = join(dshHome, 'profiles/web/cordis.patch.yml')
const credentialReference = 'DSH_OIDC_TEST_CLIENT_SECRET'
const screenshotDirectory = process.env.DSH_OIDC_SCREENSHOT_DIR
const AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#4f7cd8"/><circle cx="32" cy="25" r="11" fill="#fff"/><path d="M12 58c3-12 11-18 20-18s17 6 20 18z" fill="#fff"/></svg>'

let provider: Server | undefined
let caddy: ChildProcess | undefined
let dsh: ChildProcess | undefined
let browser: Browser | undefined
let context: BrowserContext | undefined
let page: Page | undefined
let providerPort = 0
let publicPort = 0
let adminPort = 0
let dshPort = 0
let issuer = ''
let publicOrigin = ''
let caPath = ''
let caddyStderr = ''
let dshOutput = ''
let clientSecret = ''
let clientSecretUsed = false
let providerSubject = 'synthetic-operator'
let realAssetPath = ''
let nativeCookieHeader = ''
const issuedCodes = new Map<string, { challenge: string; nonce: string }>()

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '')
    throw new Error(`FULL_PROFILE_BLOCKED: ${name} is required`)
  return value
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no TCP port'))
      const port = address.port
      server.close((error) => (error === undefined ? resolve(port) : reject(error)))
    })
  })
}

function findDshPackage(name: string): string {
  const manifest = join(runtime, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(manifest)) throw new Error(`installed package was not found: ${name}`)
  return manifest
}

async function curl(host: string, url: string, extra: readonly string[] = []): Promise<HttpResult> {
  const headerPath = join(stackRoot, `headers-${randomUUID()}`)
  const bodyPath = join(stackRoot, `body-${randomUUID()}`)
  try {
    await execFileAsync(
      'curl',
      [
        '--silent',
        '--show-error',
        '--connect-timeout',
        '2',
        '--max-time',
        '8',
        '--cacert',
        caPath,
        '--resolve',
        `${host}:${String(publicPort)}:127.0.0.1`,
        '--dump-header',
        headerPath,
        '--output',
        bodyPath,
        ...extra,
        url,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    )
    const headers = readFileSync(headerPath, 'utf8')
    return {
      status: Number(/^HTTP\/\S+ (\d{3})/mu.exec(headers)?.[1]),
      headers,
      body: readFileSync(bodyPath, 'utf8'),
    }
  } finally {
    rmSync(headerPath, { force: true })
    rmSync(bodyPath, { force: true })
  }
}

function caddyfile(upstreamPort?: number): string {
  const providerSite = `https://127.0.0.1:${String(publicPort)} {
  tls internal
  reverse_proxy 127.0.0.1:${String(providerPort)}
}\n`
  if (upstreamPort === undefined)
    return `{
  admin 127.0.0.1:${String(adminPort)}
  auto_https disable_redirects
  default_bind 127.0.0.1
  skip_install_trust
}
${providerSite}https://dsh.test:${String(publicPort)} {
  tls internal
  respond "DSH starting" 503
}\n`
  // Exercise the distributable proxy recipe itself, not a second hand-maintained
  // copy that can silently diverge from public installation instructions.
  const published = readFileSync(new URL('../examples/Caddyfile', import.meta.url), 'utf8')
    .replace('{\n\tauto_https disable_redirects\n}\n', '')
    .replace('https://dsh.example {', `https://dsh.test:${String(publicPort)} {\n\ttls internal`)
    .replaceAll('127.0.0.1:3080', `127.0.0.1:${String(upstreamPort)}`)
    .replaceAll('header_up Host {host}', `header_up Host dsh.test:${String(publicPort)}`)
  if (
    published.includes('https://dsh.example') ||
    published.includes('127.0.0.1:3080') ||
    published.includes('header_up Host {host}') ||
    !published.includes('tls internal') ||
    !published.includes('header_up -Upgrade')
  )
    throw new Error('published Caddy recipe no longer matches acceptance topology')
  return `{\n  admin 127.0.0.1:${String(adminPort)}\n  auto_https disable_redirects\n  default_bind 127.0.0.1\n  skip_install_trust\n}\n${providerSite}${published}`
}

async function waitForCaddy(): Promise<void> {
  const deadline = Date.now() + 15_000
  let last = 'not ready'
  while (Date.now() < deadline) {
    if (caddy?.exitCode !== null) throw new Error(`Caddy exited early\n${caddyStderr}`)
    if (existsSync(caPath)) {
      try {
        const discovery = await curl(
          '127.0.0.1',
          new URL('.well-known/openid-configuration', issuer).href,
        )
        if (discovery.status === 200) return
        last = `HTTP ${String(discovery.status)}`
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
    }
    await delay(50)
  }
  throw new Error(`Caddy readiness deadline exceeded: ${last}\n${caddyStderr}`)
}

async function reloadCaddy(upstreamPort: number): Promise<void> {
  const config = join(stackRoot, 'Caddyfile')
  const replacement = join(stackRoot, 'Caddyfile.next')
  writeFileSync(replacement, caddyfile(upstreamPort), { mode: 0o600 })
  renameSync(replacement, config)
  await execFileAsync(caddyBinary, ['reload', '--config', config, '--adapter', 'caddyfile'], {
    env: caddyEnvironment(),
    encoding: 'utf8',
    timeout: 10_000,
  })
}

function caddyEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_DATA_HOME: join(stackRoot, 'caddy-data'),
    XDG_CONFIG_HOME: join(stackRoot, 'caddy-config'),
  }
}

// The bundle's own patch supplies the row and the environment supplies every
// site value, so the profile patch holds nothing of this plugin.
function writeProfilePatch(): void {
  writeFileSync(profilePatch, '[]\n', { mode: 0o600 })
}

function oidcEnvironment(): NodeJS.ProcessEnv {
  return {
    DSH_OIDC_ISSUER: issuer,
    DSH_OIDC_CLIENT_ID: 'synthetic-client',
    DSH_OIDC_CLIENT_SECRET_REF: credentialReference,
    DSH_OIDC_PUBLIC_ORIGIN: `${publicOrigin}/`,
    DSH_OIDC_ALLOWED_SUBJECTS: JSON.stringify([{ issuer, subject: 'synthetic-operator' }]),
    // Caddy reaches DSH over loopback in this stack.
    DSH_OIDC_TRUSTED_PROXIES: JSON.stringify(['127.0.0.0/8']),
  }
}

function writeCredentials(): void {
  clientSecret = randomBytes(32).toString('base64url')
  const credentials = join(dshHome, '.credentials.yaml')
  writeFileSync(credentials, `version: 1\nrefs:\n  ${credentialReference}: '${clientSecret}'\n`, {
    mode: 0o600,
  })
  chmodSync(credentials, 0o600)
}

async function startProvider(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const signingKey = await importPKCS8(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    'RS256',
  )
  const jwk = await exportJWK(publicKey)
  jwk.kid = 'synthetic-key'
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  provider = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', issuer)
      if (url.pathname === '/.well-known/openid-configuration') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: new URL('authorize', issuer).href,
            token_endpoint: new URL('token', issuer).href,
            jwks_uri: new URL('jwks', issuer).href,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          }),
        )
        return
      }
      if (url.pathname === '/avatar.svg') {
        response.writeHead(200, { 'content-type': 'image/svg+xml' })
        response.end(AVATAR_SVG)
        return
      }
      if (url.pathname === '/jwks') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ keys: [jwk] }))
        return
      }
      if (url.pathname === '/authorize') {
        const state = url.searchParams.get('state')
        const nonce = url.searchParams.get('nonce')
        const challenge = url.searchParams.get('code_challenge')
        const redirectUri = url.searchParams.get('redirect_uri')
        if (state === null || nonce === null || challenge === null || redirectUri === null) {
          response.writeHead(400).end()
          return
        }
        const code = randomUUID()
        issuedCodes.set(code, { challenge, nonce })
        const callback = new URL(redirectUri)
        callback.searchParams.set('code', code)
        callback.searchParams.set('state', state)
        // Like a real provider's consent page: the browser leaves the provider's
        // site through a document navigation, so the callback is cross-site.
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          `<!doctype html><meta http-equiv="refresh" content="0;url=${callback.href.replaceAll('&', '&amp;')}">`,
        )
        return
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        const code = body.get('code')
        const verifier = body.get('code_verifier')
        const secretValid = body.get('client_secret') === clientSecret
        const clientValid = body.get('client_id') === 'synthetic-client'
        const grant = code === null ? undefined : issuedCodes.get(code)
        if (code !== null) issuedCodes.delete(code)
        const challenge =
          verifier === null ? '' : createHash('sha256').update(verifier).digest('base64url')
        if (!secretValid || !clientValid || grant === undefined || grant.challenge !== challenge) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid_client' }))
          return
        }
        clientSecretUsed = true
        const now = Math.floor(Date.now() / 1000)
        const idToken = await new SignJWT({
          iss: issuer,
          sub: providerSubject,
          name: 'Synthetic Operator',
          preferred_username: 'synthetic',
          email: 'operator@example.test',
          picture: new URL('avatar.svg', issuer).href,
          aud: 'synthetic-client',
          nonce: grant.nonce,
          iat: now,
          exp: now + 300,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
          .sign(signingKey)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            access_token: 'synthetic-access',
            token_type: 'Bearer',
            id_token: idToken,
          }),
        )
        return
      }
      response.writeHead(404).end()
    })().catch(() => response.writeHead(500).end())
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const address = provider.address()
  if (address === null || typeof address === 'string') throw new Error('provider bind failed')
  providerPort = address.port
}

async function startDsh(): Promise<void> {
  const binary = join(runtime, 'node_modules/.bin/dsh')
  const hmrOverlay = join(stackRoot, 'hmr.patch.yml')
  writeFileSync(hmrOverlay, "- id: hmr\n  disabled: false\n  config:\n    root: ['.']\n", {
    mode: 0o600,
  })
  const child = spawn(
    binary,
    [
      '--profile',
      'web',
      '--patch',
      hmrOverlay,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(dshPort),
      '--trusted-host',
      `dsh.test:${String(publicPort)}`,
    ],
    {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        HOME: join(stackRoot, 'user-home'),
        XDG_CONFIG_HOME: join(stackRoot, 'user-config'),
        XDG_DATA_HOME: join(stackRoot, 'user-data'),
        DSH_TELEMETRY_DISABLED: '1',
        NODE_EXTRA_CA_CERTS: caPath,
        ...oidcEnvironment(),
        PATH: `${join(runtime, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  dsh = child
  const consume = (chunk: Buffer | string): void => {
    const text = String(chunk).replace(/([?&]token=)[^\s&]+/gu, '$1<redacted>')
    dshOutput = (dshOutput + text).slice(-16_384)
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
}

async function waitForOidcRoute(): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (dsh?.exitCode !== null) throw new Error(`DSH exited before readiness\n${dshOutput}`)
    try {
      if ((await directDsh('/auth/check')).status === 401) return
    } catch {
      // The listener opens once the profile has composed.
    }
    await delay(50)
  }
  throw new Error(`OIDC route readiness deadline exceeded\n${dshOutput}`)
}

function directDsh(path: string, cookie = ''): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: dshPort,
        path,
        headers: {
          Host: `dsh.test:${String(publicPort)}`,
          'X-Dsh-Oidc-Client-Ip': '127.0.0.1',
          ...(cookie === '' ? {} : { Cookie: cookie }),
        },
        signal: AbortSignal.timeout(2_000),
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.once('error', reject)
    request.end()
  })
}

function logoutThroughProxy(cookie: string, csrf: string): Promise<number> {
  const body = new URLSearchParams({ csrf }).toString()
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port: publicPort,
        path: '/auth/logout',
        method: 'POST',
        servername: 'dsh.test',
        rejectUnauthorized: false,
        headers: {
          Host: `dsh.test:${String(publicPort)}`,
          Origin: publicOrigin,
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        signal: AbortSignal.timeout(3_000),
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      },
    )
    request.once('error', reject)
    request.end(body)
  })
}

async function waitForClosed(port: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
      socket.setTimeout(250, () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (!open) return
    await delay(50)
  }
  throw new Error(`listener remained open on 127.0.0.1:${String(port)}`)
}

async function stopChild(label: string, child: ChildProcess | undefined, requireClean = false) {
  if (child === undefined || child.exitCode !== null) return
  const exit = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  child.kill('SIGTERM')
  const result = await Promise.race([exit, delay(6_000).then(() => undefined)])
  if (result === undefined) {
    child.kill('SIGKILL')
    const killed = await Promise.race([exit, delay(2_000).then(() => undefined)])
    if (killed === undefined) throw new Error(`${label} did not exit after SIGKILL`)
    if (requireClean) throw new Error(`${label} required kill fallback`)
    return
  }
  if (requireClean && result[0] !== 0) {
    throw new Error(`${label} exited with ${String(result[0])}/${String(result[1])}`)
  }
}

async function setupStack(): Promise<void> {
  rmSync(stackRoot, { recursive: true, force: true })
  mkdirSync(stackRoot, { recursive: true, mode: 0o700 })
  chmodSync(stackRoot, 0o700)
  mkdirSync(join(stackRoot, 'user-home'), { mode: 0o700 })
  mkdirSync(join(stackRoot, 'workspace'), { mode: 0o700 })
  const frontendManifest = findDshPackage('@deepseek-ai/dsh-web-frontend')
  const frontendIndex = readFileSync(join(dirname(frontendManifest), 'dist/index.html'), 'utf8')
  const asset = /<script[^>]+src="([^"?]+\.js)"/u.exec(frontendIndex)?.[1]
  if (asset === undefined || !asset.includes('-'))
    throw new Error('real hashed frontend asset not found')
  realAssetPath = new URL(asset, 'https://dsh.test/').pathname

  publicPort = await freePort()
  adminPort = await freePort()
  dshPort = await freePort()
  publicOrigin = `https://dsh.test:${String(publicPort)}`
  issuer = `https://127.0.0.1:${String(publicPort)}/`
  writeCredentials()
  writeProfilePatch()
  await startProvider()

  const config = join(stackRoot, 'Caddyfile')
  writeFileSync(config, caddyfile(), { mode: 0o600 })
  caddy = spawn(caddyBinary, ['run', '--config', config, '--adapter', 'caddyfile'], {
    env: caddyEnvironment(),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  caddy.stderr?.setEncoding('utf8')
  caddy.stderr?.on('data', (chunk: string) => {
    caddyStderr = (caddyStderr + chunk)
      .replace(/([?&]token=)[^\s&]+/gu, '$1<redacted>')
      .slice(-8192)
  })
  caPath = join(stackRoot, 'caddy-data/caddy/pki/authorities/local/root.crt')
  await waitForCaddy()

  await startDsh()
  await waitForOidcRoute()
  await reloadCaddy(dshPort)
  const playwright = (await import('playwright')) as BrowserModule
  const executable = playwright.chromium.executablePath()
  if (!existsSync(executable)) {
    throw new Error('ACCEPTANCE_BLOCKED: run `npx playwright install chromium` first')
  }
  browser = await playwright.chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP dsh.test 127.0.0.1'],
  })
  context = await browser.newContext({ ignoreHTTPSErrors: true })
  page = await context.newPage()
  if (controlledFailure) throw new Error('CONTROLLED_SETUP_FAILURE')
}

async function cleanupStack(): Promise<void> {
  const failures: Error[] = []
  const clean = async (label: string, action: () => void | Promise<void>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      failures.push(new Error(`cleanup failed for ${label}`, { cause: error }))
    }
  }
  await clean('browser context', async () => context?.close())
  context = undefined
  page = undefined
  await clean('browser', async () => browser?.close())
  browser = undefined
  await clean('DSH', async () => stopChild('DSH', dsh, true))
  dsh = undefined
  await clean('Caddy', async () => stopChild('Caddy', caddy))
  caddy = undefined
  await clean('provider', async () => {
    const server = provider
    provider = undefined
    if (server === undefined || !server.listening) return
    server.closeAllConnections()
    await Promise.race([
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
      delay(2_000).then(() => {
        throw new Error('provider close deadline exceeded')
      }),
    ])
  })
  for (const port of [dshPort, publicPort, providerPort, adminPort].filter((value) => value > 0)) {
    await clean(`listener ${String(port)}`, async () => waitForClosed(port))
  }
  clientSecret = ''
  issuedCodes.clear()
  await clean('private stack root', () => rmSync(stackRoot, { recursive: true, force: true }))
  if (existsSync(stackRoot)) failures.push(new Error('private stack root remained'))
  if (failures.length > 0) throw new AggregateError(failures, 'full-profile cleanup failed')
}

beforeAll(async () => {
  try {
    await setupStack()
  } catch (setupError) {
    try {
      await cleanupStack()
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], 'setup and cleanup failed', {
        cause: cleanupError,
      })
    }
    throw setupError
  }
}, 150_000)

afterAll(cleanupStack, 20_000)

describe(
  `published DSH ${process.env.DSH_OIDC_DSH_VERSION ?? ''} Web profile`,
  { concurrent: false },
  () => {
    it('starts as an enabled bundle without printing or opening the bearer URL', () => {
      const profile = JSON.parse(
        readFileSync(join(dshHome, 'profiles/web/package.json'), 'utf8'),
      ) as { dsh?: { profile?: { bundles?: string[] } } }
      expect(profile.dsh?.profile?.bundles).toContain('@lumysia/dsh-oidc')
      expect(readFileSync(profilePatch, 'utf8')).not.toContain('lumysia')
      expect(dshOutput).not.toContain('?token=')
      expect(dshOutput).not.toContain('opening the default browser')
      expect(dshOutput).not.toContain('synthetic-operator')
    })

    it('denies every application owner before outer login', async () => {
      if (page === undefined) throw new Error('browser page absent')
      for (const path of [
        '/',
        realAssetPath,
        '/api/__acceptance_missing__',
        '/events',
        '/api/remote.mux',
        '/_dsh-oidc/session',
      ]) {
        // Browser navigations are redirected to the bundled sign-in page; the
        // plain 401 contract is covered by the API-client assertions below.
        const response = await page.goto(publicOrigin + path, { waitUntil: 'domcontentloaded' })
        expect(response?.status(), path).toBe(200)
        expect(new URL(page.url()).pathname, path).toBe('/auth/signin')
      }
      // Only the four registered OIDC paths may bypass the outer admission gate.
      expect((await page.goto(publicOrigin + '/auth/not-registered'))?.status()).toBe(404)
      const upload = await curl(
        'dsh.test',
        `${publicOrigin}/api/session/uploadFileBinary?sessionId=x`,
        [
          '--request',
          'POST',
          '--header',
          'Content-Type: application/octet-stream',
          '--data-binary',
          'x',
        ],
      )
      expect(upload.status).toBe(401)
      // The profile endpoint sits behind forward_auth like the application.
      expect((await curl('dsh.test', `${publicOrigin}/_dsh-oidc/session`)).status).toBe(401)
      const opened = await page.evaluate(
        (url) =>
          new Promise<boolean>((resolve) => {
            const socket = new WebSocket(url)
            socket.addEventListener('open', () => {
              socket.close()
              resolve(true)
            })
            socket.addEventListener('error', () => resolve(false))
            setTimeout(() => resolve(false), 2_000)
          }),
        `wss://dsh.test:${String(publicPort)}/api/remote.mux`,
      )
      expect(opened).toBe(false)
    })

    it('denies a signed but unallowlisted identity without bootstrapping a native session', async () => {
      if (browser === undefined) throw new Error('browser absent')
      const deniedContext = await browser.newContext({ ignoreHTTPSErrors: true })
      providerSubject = 'synthetic-denied'
      try {
        const deniedPage = await deniedContext.newPage()
        // The provider leaves through a document refresh (see /authorize), so
        // wait for the callback's own response instead of the first document.
        const deniedCallback = deniedPage.waitForResponse((r) =>
          r.url().startsWith(`${publicOrigin}/auth/callback`),
        )
        await deniedPage.goto(`${publicOrigin}/auth/login`)
        expect((await deniedCallback).status()).toBe(403)
        await deniedPage.waitForURL(`${publicOrigin}/auth/callback**`, { waitUntil: 'load' })
        const cookies = await deniedContext.cookies(publicOrigin)
        expect(cookies.some((cookie) => cookie.name.startsWith('dsh-auth-'))).toBe(false)
        expect(cookies.some((cookie) => cookie.name === '__Host-dsh-oidc-session')).toBe(false)
        // Navigations reach the bundled sign-in page instead of a plain 401.
        expect((await deniedPage.goto(`${publicOrigin}/`))?.status()).toBe(200)
        expect(new URL(deniedPage.url()).pathname).toBe('/auth/signin')
      } finally {
        providerSubject = 'synthetic-operator'
        await deniedContext.close()
      }
    })

    it('uses the real browser for OIDC, native bootstrap, root, API, upload, and WebSocket', async () => {
      if (page === undefined || context === undefined) throw new Error('browser context absent')
      // Provider page -> callback page -> native token exchange -> clean root.
      // Every hop after the provider is a same-site navigation, which is what
      // lets the browser send DSH's SameSite=Strict cookie on the last one.
      await page.goto(`${publicOrigin}/auth/login`)
      await page.waitForURL(`${publicOrigin}/`, { waitUntil: 'domcontentloaded' })
      const root = await page.reload({ waitUntil: 'domcontentloaded' })
      expect(root?.status()).toBe(200)
      expect(page.url()).toBe(`${publicOrigin}/`)
      expect(await page.title()).toBe('DeepSeek Harness')
      const cookies = await context.cookies(publicOrigin)
      expect(cookies.some((cookie) => cookie.name === '__Host-dsh-oidc-session')).toBe(true)
      const nativeCookies = cookies.filter((cookie) => cookie.name.startsWith('dsh-auth-'))
      expect(nativeCookies.length).toBeGreaterThan(0)
      expect(
        nativeCookies.every(
          (cookie) =>
            cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/',
        ),
      ).toBe(true)
      const outer = cookies.find((cookie) => cookie.name === '__Host-dsh-oidc-session')
      expect(outer).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' })
      expect(clientSecretUsed).toBe(true)

      const ownerResults = await page.evaluate(
        async ({ assetPath, workspacePath }) => {
          async function rpc(method: string, request: Record<string, string>) {
            const response = await fetch(`/api/${method}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                type: 'client-request',
                rpcId: `acceptance-${method}`,
                method,
                payload: { args: { request } },
              }),
            })
            const envelope = (await response.json()) as {
              result: { ok: boolean; value: { workspace: { workspaceId: string; path: string } } }
            }
            if (!envelope.result.ok)
              throw new Error(`synthetic workspace RPC failed: ${JSON.stringify(envelope)}`)
            return envelope.result
          }
          const workspace = await rpc('workspace/create', { path: workspacePath })
          const renamed = await rpc('workspace/rename', {
            workspaceId: workspace.value.workspace.workspaceId,
            title: 'OIDC synthetic acceptance',
          })
          const asset = await fetch(assetPath)
          const missing = await fetch('/api/__acceptance_missing__')
          const upload = await fetch(
            '/api/session/uploadFileBinary?sessionId=synthetic-missing-session',
            {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: new Uint8Array([1, 2, 3]),
            },
          )
          return {
            workspace,
            renamed,
            assetStatus: asset.status,
            missingStatus: missing.status,
            missingType: missing.headers.get('content-type'),
            missingBody: await missing.text(),
            uploadStatus: upload.status,
            uploadType: upload.headers.get('content-type'),
            uploadBody: (await upload.json()) as unknown,
          }
        },
        { assetPath: realAssetPath, workspacePath: join(stackRoot, 'workspace') },
      )
      expect(ownerResults.workspace).toMatchObject({
        ok: true,
        value: { workspace: { path: join(stackRoot, 'workspace') } },
      })
      expect(ownerResults.renamed).toMatchObject({
        ok: true,
        value: { workspace: { title: 'OIDC synthetic acceptance' } },
      })
      expect(ownerResults.assetStatus).toBe(200)
      expect(ownerResults.missingStatus).toBe(404)
      expect(ownerResults.missingType).not.toContain('text/html')
      expect(ownerResults.missingBody).toBe('not found')
      expect(ownerResults.uploadStatus).toBe(200)
      expect(ownerResults.uploadType).toContain('application/json')
      expect(ownerResults.uploadBody).toMatchObject({
        ok: false,
        error: { code: 'session/not-found' },
      })

      const websocketOpened = await page.evaluate(
        (url) =>
          new Promise<boolean>((resolve) => {
            const socket = new WebSocket(url)
            const timeout = setTimeout(() => resolve(false), 5_000)
            socket.addEventListener('open', () => {
              clearTimeout(timeout)
              socket.close()
              resolve(true)
            })
            socket.addEventListener('error', () => {
              clearTimeout(timeout)
              resolve(false)
            })
          }),
        `wss://dsh.test:${String(publicPort)}/api/remote.mux`,
      )
      expect(websocketOpened).toBe(true)
    })

    it('denies a stale native cookie after CSRF-protected outer logout', async () => {
      if (page === undefined || context === undefined || browser === undefined) {
        throw new Error('browser context absent')
      }
      const allCookies = await context.cookies(publicOrigin)
      const nativeCookies = allCookies.filter((cookie) => cookie.name.startsWith('dsh-auth-'))
      expect(nativeCookies.length).toBeGreaterThan(0)
      nativeCookieHeader = nativeCookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ')
      expect((await directDsh('/', nativeCookieHeader)).status).toBe(200)
      await page.goto(`${publicOrigin}/auth/logout`, { waitUntil: 'domcontentloaded' })
      const csrf = await page.locator('input[name="csrf"]').inputValue()
      expect(csrf.length).toBeGreaterThan(20)
      const fullCookieHeader = allCookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ')
      expect(await logoutThroughProxy(fullCookieHeader, csrf)).toBe(303)

      const staleContext = await browser.newContext({ ignoreHTTPSErrors: true })
      try {
        // Replay both the native cookie and the revoked outer session, not just a missing session.
        await staleContext.addCookies(allCookies)
        const stalePage = await staleContext.newPage()
        const denied = await stalePage.goto(`${publicOrigin}/`, { waitUntil: 'domcontentloaded' })
        // Navigations reach the bundled sign-in page instead of a plain 401.
        expect(denied?.status()).toBe(200)
        expect(new URL(stalePage.url()).pathname).toBe('/auth/signin')
        for (const path of ['/api/__acceptance_missing__', '/api/remote.mux', realAssetPath]) {
          expect((await stalePage.goto(publicOrigin + path))?.status(), path).toBe(200)
          expect(new URL(stalePage.url()).pathname, path).toBe('/auth/signin')
        }
        const opened = await stalePage.evaluate(
          (url) =>
            new Promise<boolean>((resolve) => {
              const socket = new WebSocket(url)
              socket.addEventListener('open', () => {
                socket.close()
                resolve(true)
              })
              socket.addEventListener('error', () => resolve(false))
              setTimeout(() => {
                socket.close()
                resolve(false)
              }, 2000)
            }),
          `wss://dsh.test:${String(publicPort)}/api/remote.mux`,
        )
        expect(opened).toBe(false)
      } finally {
        await staleContext.close()
      }
    })

    it(
      'shows the OIDC account button with Settings and sign-out in the sidebar',
      { timeout: 120_000 },
      async () => {
        if (page === undefined || context === undefined) throw new Error('browser context absent')
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.goto(`${publicOrigin}/auth/login`)
        await page.waitForURL(`${publicOrigin}/`, { waitUntil: 'domcontentloaded' })
        await page.reload({ waitUntil: 'load' })

        const profile = await page.evaluate(async () => {
          const response = await fetch('/_dsh-oidc/session')
          return {
            status: response.status,
            body: (await response.json()) as Record<string, string>,
          }
        }, undefined)
        expect(profile.status).toBe(200)
        expect(Object.keys(profile.body).sort()).toEqual([
          'csrf',
          'email',
          'name',
          'picture',
          'username',
        ])
        expect(JSON.stringify(profile.body)).not.toMatch(/synthetic-operator|synthetic-access|eyJ/u)

        // The Plugins page lists the package as a bundle with its locale metadata.
        const bundles = await page.evaluate(async () => {
          const response = await fetch('/api/pluginManager/listBundles', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: 'acceptance-listBundles',
              method: 'pluginManager/listBundles',
              payload: { args: {} },
            }),
          })
          return (await response.json()) as {
            result: {
              ok: boolean
              value: Array<{
                name: string
                enabled: boolean
                meta?: Record<string, { title?: string; description?: string }>
                rows?: Array<{ rowId?: string; id?: string }>
              }>
            }
          }
        }, undefined)
        expect(bundles.result.ok, JSON.stringify(bundles).slice(0, 2000)).toBe(true)
        const bundle = bundles.result.value.find((entry) => entry.name === '@lumysia/dsh-oidc')
        expect(
          bundle,
          JSON.stringify(bundles.result.value.map((entry) => entry.name)),
        ).toBeDefined()
        expect(bundle?.enabled).toBe(true)
        expect(JSON.stringify(bundle?.meta)).toContain('OpenID Connect sign-in')
        expect(JSON.stringify(bundle?.meta)).toContain('OpenID Connect 登录')
        expect(JSON.stringify(bundle?.rows)).toContain('lumysia-oidc')

        const trigger = page.locator('[data-dsh-oidc-account] button[aria-haspopup="menu"]')
        await trigger.waitFor({ state: 'visible', timeout: 30_000 })
        expect(await trigger.textContent()).toContain('Synthetic Operator')
        await page.locator('[data-dsh-oidc-account] img').waitFor({ state: 'visible' })
        // DSH's own DeepSeek launcher is shadowed, not shown beside it.
        expect(
          await page.evaluate(
            () => document.querySelectorAll('[data-dsh-oidc-account]').length,
            undefined,
          ),
        ).toBe(1)

        // DSH's first-run steps (the welcome notice, then the model onboarding with
        // its "Get started" sign-in dialog) each open a modal dialog that masks the
        // page. A step renders nothing while it loads its data, so the page can look
        // idle for a moment between two dialogs; only a quiet spell with no dialog
        // and no inert root counts as settled, and a dialog that still arrives late
        // and takes the click sends the menu opening back to settling.
        // Closures below lose the narrowing of `page`.
        const view = page
        const menu = page.getByRole('menu')
        const dismissed: string[] = []
        const settleDialogs = async (deadline: number) => {
          let quietSince = Date.now()
          for (;;) {
            const state = await view.evaluate(() => {
              const button = document.querySelector('[data-dsh-oidc-account] button')
              const dialog = document.querySelector('[role="dialog"],[aria-modal="true"]')
              return {
                dialog: dialog?.getAttribute('aria-label') ?? (dialog === null ? null : ''),
                inert: button === null || button.closest('[inert]') !== null,
              }
            }, undefined)
            if (state.dialog === null && !state.inert) {
              if (Date.now() - quietSince >= 2_000) return
            } else {
              quietSince = Date.now()
            }
            if (Date.now() > deadline) {
              const detail = await view.evaluate(
                () => ({
                  dialogs: Array.from(
                    document.querySelectorAll('[role="dialog"],[aria-modal="true"]'),
                  ).map((node) => (node as HTMLElement).outerHTML.slice(0, 600)),
                  inert: Array.from(document.querySelectorAll('[inert]')).map((node) =>
                    (node as HTMLElement).outerHTML.slice(0, 200),
                  ),
                }),
                undefined,
              )
              throw new Error(
                `DSH dialogs did not settle: ${JSON.stringify({ state, dismissed, detail })}`,
              )
            }
            if (state.dialog !== null) {
              const dismiss = view.locator(
                '[role="dialog"] button[aria-label="Close"], [role="dialog"] button:text-is("Continue")',
              )
              if ((await dismiss.count()) > 0) {
                await dismiss.first().click()
                dismissed.push(state.dialog)
              }
            }
            await delay(250)
          }
        }
        const openMenu = async () => {
          const deadline = Date.now() + 45_000
          for (;;) {
            await settleDialogs(deadline)
            try {
              await trigger.click({ timeout: 5_000 })
              await menu.waitFor({ state: 'visible', timeout: 5_000 })
              return
            } catch (error) {
              if (Date.now() > deadline) throw error
            }
          }
        }
        await openMenu()
        expect(await menu.textContent()).toContain('Settings')
        expect(await menu.textContent()).toContain('Sign out')
        // An open menu masks the page, as DSH's own menus do; a click outside closes it.
        const toggleMenu = async (state: 'visible' | 'hidden') => {
          if (state === 'hidden') {
            await view.mouse.click(900, 300)
            await menu.waitFor({ state })
          } else {
            await openMenu()
          }
        }
        if (screenshotDirectory !== undefined) {
          mkdirSync(screenshotDirectory, { recursive: true })
          await page.screenshot({ path: join(screenshotDirectory, 'sidebar-menu-light.png') })
          await toggleMenu('hidden')
          await page.emulateMedia({ colorScheme: 'dark' })
          await page
            .waitForFunction(
              () =>
                getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)' ||
                document.documentElement.dataset.theme === 'dark',
              undefined,
              { timeout: 5_000 },
            )
            .catch(() => undefined)
          await toggleMenu('visible')
          await page.screenshot({ path: join(screenshotDirectory, 'sidebar-menu-dark.png') })
          await toggleMenu('hidden')
          await page.emulateMedia({ colorScheme: 'light' })
          await toggleMenu('visible')
        }

        // Settings stays reachable from the seat this button took over.
        await page.getByRole('menuitem', { name: 'Settings' }).click()
        await page.getByRole('dialog').first().waitFor({ state: 'visible' })
        await page.keyboard.press('Escape')

        await openMenu()
        const loggedOut = page.waitForResponse((response) =>
          response.url().startsWith(`${publicOrigin}/auth/logout`),
        )
        await page.getByRole('menuitem', { name: 'Sign out' }).click()
        expect((await loggedOut).status()).toBe(303)
        await page.waitForURL(`${publicOrigin}/auth/signin`, { waitUntil: 'domcontentloaded' })
        const cookies = await context.cookies(publicOrigin)
        const outer = cookies.find((cookie) => cookie.name === '__Host-dsh-oidc-session')
        expect(outer?.value ?? '').toBe('')
        expect(
          (
            await curl('dsh.test', `${publicOrigin}/_dsh-oidc/session`, [
              '--cookie',
              cookies.map((c) => `${c.name}=${c.value}`).join('; '),
            ])
          ).status,
        ).toBe(401)
      },
    )

    it('fails closed through the proxy when the bundle row is switched off', async () => {
      expect((await directDsh('/auth/check', nativeCookieHeader)).status).toBe(401)
      // The Plugins page's row toggle writes exactly this override.
      const replacement = `${profilePatch}.next`
      writeFileSync(replacement, '- id: lumysia-oidc\n  disabled: true\n', { mode: 0o600 })
      renameSync(replacement, profilePatch)
      const deadline = Date.now() + 15_000
      let status = 401
      let body = ''
      while (Date.now() < deadline) {
        if (dsh?.exitCode !== null) throw new Error(`DSH exited during live unload\n${dshOutput}`)
        const response = await directDsh('/auth/check', nativeCookieHeader)
        status = response.status
        body = response.body
        if (status === 404) break
        await delay(50)
      }
      expect(status, body).toBe(404)
      // forward_auth treats the missing check route as a denial: nothing reaches the app,
      // not even with the stale native cookie.
      for (const path of ['/', '/api/__acceptance_missing__', realAssetPath]) {
        const proxied = await curl('dsh.test', publicOrigin + path, [
          '--cookie',
          nativeCookieHeader,
        ])
        expect(proxied.status, path).toBe(404)
        expect(proxied.body, path).not.toContain('<html')
      }
    })

    it('binds the real DSH listener only to loopback', async () => {
      const external = Object.values(networkInterfaces())
        .flat()
        .filter(
          (address): address is NonNullable<typeof address> =>
            address !== undefined && !address.internal && address.family === 'IPv4',
        )
      for (const address of external) {
        await expect(
          fetch(`http://${address.address}:${String(dshPort)}/`, {
            signal: AbortSignal.timeout(500),
          }),
        ).rejects.toThrow()
      }
    })
  },
)
