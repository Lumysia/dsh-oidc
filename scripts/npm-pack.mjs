import { execFileSync } from 'node:child_process'

/**
 * Run `npm pack --json` into `destination` and return its one result.
 * npm <=11 prints an array of results; npm 12 prints an object keyed by name.
 */
export function npmPack(destination, extraArgs = []) {
  const output = execFileSync(
    'npm',
    ['pack', '--json', ...extraArgs, '--pack-destination', destination],
    { encoding: 'utf8' },
  )
  const parsed = JSON.parse(output)
  const results = Array.isArray(parsed) ? parsed : Object.values(parsed)
  if (results.length !== 1 || typeof results[0]?.filename !== 'string')
    throw new Error('npm pack did not return exactly one tarball')
  // npm 12 reports the scoped name with its @ and / intact; the file on disk is flattened.
  const result = results[0]
  const filename = result.filename.replace(/^@/u, '').replace('/', '-')
  return { ...result, filename }
}
