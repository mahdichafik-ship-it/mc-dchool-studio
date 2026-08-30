import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const targetTag = process.argv[2]
const releasesPath = process.argv[3]

assert(targetTag, 'target release tag is required')
assert(releasesPath, 'release-list JSON path is required')

function parseStableTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  if (!match) return null
  return match.slice(1).map(Number)
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

const targetVersion = parseStableTag(targetTag)
assert(targetVersion, `target tag must be a stable semantic version: ${targetTag}`)

const releases = JSON.parse(readFileSync(releasesPath, 'utf8'))
const previous = releases
  .filter((release) => !release.isDraft && !release.isPrerelease)
  .map((release) => ({
    tag: release.tagName,
    version: parseStableTag(release.tagName),
  }))
  .filter((release) =>
    release.version && compareVersions(release.version, targetVersion) < 0)
  .sort((left, right) => compareVersions(right.version, left.version))[0]

assert(previous, `no stable release precedes ${targetTag}`)
process.stdout.write(previous.tag)