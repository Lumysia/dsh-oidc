// Real-stack acceptance: pack this plugin, install a published DSH release in a
// throwaway directory, add the tarball through `dsh plugin add`, and run the
// browser scenarios in tests/real-stack.acceptance.ts behind Caddy and a
// synthetic OIDC issuer. Nothing outside the temporary run root is touched.
//
// DSH_OIDC_CADDY_BIN    Caddy binary (required)
// DSH_OIDC_DSH_VERSION  DSH version or dist-tag to test (default: latest)
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { npmPack } from './npm-pack.mjs'

const caddy = process.env.DSH_OIDC_CADDY_BIN
if (caddy === undefined || caddy === '') {
  throw new Error(
    'ACCEPTANCE_BLOCKED: set DSH_OIDC_CADDY_BIN to a Caddy v2 binary; skip is not pass',
  )
}
const caddyVersion = execFileSync(caddy, ['version'], { encoding: 'utf8' }).trim()
execFileSync(caddy, ['adapt', '--config', 'examples/Caddyfile', '--adapter', 'caddyfile'], {
  stdio: ['ignore', 'ignore', 'inherit'],
})

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const requested = process.env.DSH_OIDC_DSH_VERSION || 'latest'
// npm prints a bare string or a one-element array depending on its version.
const viewed = [
  JSON.parse(
    execFileSync('npm', ['view', `@deepseek-ai/dsh@${requested}`, 'version', '--json'], {
      encoding: 'utf8',
    }),
  ),
].flat()
const dshVersion = viewed[0]
if (viewed.length !== 1 || typeof dshVersion !== 'string') {
  throw new Error(`DSH_OIDC_DSH_VERSION=${requested} must resolve to exactly one release`)
}

const runRoot = mkdtempSync(join(tmpdir(), 'dsh-oidc-acceptance-'))
chmodSync(runRoot, 0o700)
const runtime = join(runRoot, 'runtime')
const artifacts = join(runRoot, 'artifacts')
const dshHome = join(runRoot, 'home')
mkdirSync(runtime, { mode: 0o700 })
mkdirSync(artifacts, { mode: 0o700 })

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  })
}

function vitest(environment, expectFailure = false) {
  const result = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/vitest.acceptance.config.ts'],
    { cwd: process.cwd(), encoding: 'utf8', env: environment, maxBuffer: 32 * 1024 * 1024 },
  )
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (expectFailure) {
    if (result.status === 0 || !output.includes('CONTROLLED_SETUP_FAILURE')) {
      throw new Error('controlled setup failure did not fail with its expected diagnostic')
    }
    if (output.includes('?token='))
      throw new Error('controlled failure output exposed a native token')
    return
  }
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) throw new Error(`acceptance failed with exit ${String(result.status)}`)
}

/** Every DSH package in the runtime must come from the one release under test. */
function assertSingleDshRelease() {
  const scope = join(runtime, 'node_modules/@deepseek-ai')
  const mixed = []
  let count = 0
  for (const child of readdirSync(scope)) {
    if (child !== 'dsh' && !child.startsWith('dsh-')) continue
    const { version } = JSON.parse(readFileSync(join(scope, child, 'package.json'), 'utf8'))
    count += 1
    if (version !== dshVersion) mixed.push(`${child}@${version}`)
  }
  if (count === 0) throw new Error('no DSH packages were installed')
  if (mixed.length > 0) throw new Error(`mixed DSH release in runtime: ${mixed.join(', ')}`)
  return count
}

try {
  run('npm', ['run', 'build'])
  const packed = npmPack(artifacts, ['--ignore-scripts'])
  const candidateTarball = join(artifacts, basename(packed.filename))

  // DSH's plugin manager shells out to pnpm, so the runtime provides one.
  writeFileSync(join(runtime, 'package.json'), '{ "private": true }\n')
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `@deepseek-ai/dsh@${dshVersion}`,
      'pnpm@latest',
    ],
    { cwd: runtime },
  )
  const dshPackages = assertSingleDshRelease()
  const environment = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    PATH: `${join(runtime, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
  }
  const dsh = join(runtime, 'node_modules/.bin/dsh')
  run(dsh, ['--profile', 'web', '--dump-config'], { env: environment, capture: true })
  // Install the way an operator does: the public plugin command, no peer pins.
  run(dsh, ['plugin', '--profile', 'web', 'add', `file:${candidateTarball}`], { env: environment })
  const profile = JSON.parse(readFileSync(join(dshHome, 'profiles/web/package.json'), 'utf8'))
  if (!String(profile.dependencies?.[manifest.name]).startsWith('file:')) {
    throw new Error('plugin was not recorded in the profile from the local tarball')
  }

  const testEnvironment = {
    ...environment,
    DSH_OIDC_CADDY_BIN: caddy,
    DSH_OIDC_RUN_ROOT: runRoot,
    DSH_OIDC_RUNTIME: runtime,
    DSH_OIDC_DSH_VERSION: dshVersion,
  }
  vitest(testEnvironment)
  vitest({ ...testEnvironment, DSH_OIDC_CONTROLLED_SETUP_FAILURE: '1' }, true)
  const residue = ['stack', 'failure-stack'].filter((name) => existsSync(join(runRoot, name)))
  if (residue.length !== 0)
    throw new Error(`acceptance stack residue remained: ${residue.join(', ')}`)
  console.log(
    `acceptance passed: DSH ${dshVersion} (${String(dshPackages)} packages, one release); ${manifest.name} via dsh plugin add; Node ${process.version}; Caddy ${caddyVersion}`,
  )
} finally {
  rmSync(runRoot, { recursive: true, force: true })
  if (existsSync(runRoot)) throw new Error('acceptance run root cleanup failed')
}
