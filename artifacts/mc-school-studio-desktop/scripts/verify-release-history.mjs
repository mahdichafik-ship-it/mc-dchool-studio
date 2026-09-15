import { execFileSync, spawnSync } from 'node:child_process'

const argumentsList = process.argv.slice(2)

function readOption(name, fallback) {
  const indexes = argumentsList
    .map((argument, index) => (argument === name ? index : -1))
    .filter((index) => index !== -1)
  if (indexes.length === 0) return fallback
  if (indexes.length > 1) {
    throw new Error(`${name} may only be provided once`)
  }

  const value = argumentsList[indexes[0] + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a ref`)
  }
  return value
}

const releaseRef =
  readOption('--release-ref', process.env.RELEASE_REF || process.env.GITHUB_SHA || 'HEAD')
const mainRef = readOption(
  '--main-ref',
  process.env.MAIN_REF || 'refs/remotes/origin/main',
)

const trustedMainRefs = new Set(['origin/main', 'refs/remotes/origin/main'])
if (!trustedMainRefs.has(mainRef)) {
  throw new Error(
    `--main-ref must identify the fetched origin/main remote-tracking ref (received ${mainRef})`,
  )
}

function resolveCommit(ref) {
  try {
    return execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim()
  } catch {
    throw new Error(`Could not resolve ${ref} to a commit`)
  }
}

const releaseCommit = resolveCommit(releaseRef)
const mainCommit = resolveCommit(mainRef)
const ancestry = spawnSync(
  'git',
  ['merge-base', '--is-ancestor', releaseCommit, mainCommit],
  { stdio: 'ignore' },
)

if (ancestry.error) {
  throw ancestry.error
}

if (ancestry.status === 1) {
  console.error(
    [
      `Release commit ${releaseCommit} (${releaseRef}) is not reachable from`,
      `main ${mainCommit} (${mainRef}).`,
      'Merge the release source into main through the normal review flow before tagging.',
    ].join(' '),
  )
  process.exit(1)
}
if (ancestry.status !== 0) {
  throw new Error(`Could not determine ancestry between ${releaseRef} and ${mainRef}`)
}

console.log(
  `Release commit ${releaseCommit} (${releaseRef}) is reachable from main ${mainCommit} (${mainRef}).`,
)