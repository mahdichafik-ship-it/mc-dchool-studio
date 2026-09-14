import { execFileSync, spawnSync } from 'node:child_process'

const argumentsList = process.argv.slice(2)

function readOption(name, fallback) {
  const index = argumentsList.indexOf(name)
  if (index === -1) return fallback

  const value = argumentsList[index + 1]
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

function resolveCommit(ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
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

if (ancestry.status !== 0) {
  console.error(
    [
      `Release commit ${releaseCommit} (${releaseRef}) is not reachable from`,
      `main ${mainCommit} (${mainRef}).`,
      'Merge the release source into main through the normal review flow before tagging.',
    ].join(' '),
  )
  process.exit(1)
}

console.log(
  `Release commit ${releaseCommit} (${releaseRef}) is reachable from main ${mainCommit} (${mainRef}).`,
)