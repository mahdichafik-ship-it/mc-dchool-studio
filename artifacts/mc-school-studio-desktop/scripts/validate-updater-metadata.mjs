import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const architectures = ['arm64', 'x64']

function scalar(value) {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1)
    return unquoted || null
  }
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) return null
  return trimmed
}

function validSha512(value) {
  if (/^[a-f\d]{128}$/i.test(value)) return true
  if (!/^[A-Za-z\d+/]{86}==$/.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

function expectedPayloads(version) {
  return architectures.map(
    (architecture) => `mc-school-studio-${version}-${architecture}.zip`,
  )
}

function expectedInstallerAssets(version) {
  return architectures.flatMap((architecture) => {
    const base = `mc-school-studio-${version}-${architecture}`
    return [`${base}.dmg`, `${base}.dmg.blockmap`, `${base}.zip`, `${base}.zip.blockmap`]
  })
}

function parseMetadata(metadata) {
  const lines = metadata
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let version
  let path
  let topLevelSha512
  let filesStarted = false
  const files = []
  const topKeys = new Set()
  let current = null

  const finishFile = () => {
    if (
      !current ||
      !current.url ||
      !validSha512(current.sha512) ||
      files.some((file) => file.url === current.url)
    ) {
      return false
    }
    files.push(current)
    current = null
    return true
  }

  for (const line of lines) {
    if (!line.trim()) continue
    if (line.includes('\t')) return null

    const itemMatch = /^  - url:\s*(.*)$/.exec(line)
    if (itemMatch) {
      if (!filesStarted || (current && !finishFile())) return null
      const url = scalar(itemMatch[1])
      if (!url) return null
      current = { url, sha512: '' }
      continue
    }

    const filePropertyMatch =
      /^    ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line)
    if (filePropertyMatch && current) {
      const key = filePropertyMatch[1]
      const value = scalar(filePropertyMatch[2] ?? '')
      if (!value || (key !== 'sha512' && key !== 'size')) return null
      if (key === 'sha512') {
        if (current.sha512) return null
        current.sha512 = value
      } else {
        if (current.size !== undefined || !/^[1-9]\d*$/.test(value)) return null
        current.size = Number(value)
        if (!Number.isSafeInteger(current.size)) return null
      }
      continue
    }

    const topMatch = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line)
    if (!topMatch) return null
    const key = topMatch[1]
    if (topKeys.has(key)) return null
    topKeys.add(key)
    if (key === 'files') {
      if (topMatch[2]?.trim()) return null
      filesStarted = true
    } else if (key === 'version' || key === 'path' || key === 'sha512') {
      const value = scalar(topMatch[2] ?? '')
      if (!value) return null
      if (key === 'version') version = value
      else if (key === 'path') path = value
      else topLevelSha512 = value
    } else if (key !== 'releaseDate') {
      return null
    }
  }
  if (current && !finishFile()) return null

  return {
    files,
    path,
    topLevelSha512,
    version,
    hasDuplicateTopLevelFields: false,
    hasRequiredFields:
      Boolean(version && filesStarted && topLevelSha512 && files.length > 0),
  }
}

export async function indexReleaseAssets(assetDirectory) {
  const entries = await readdir(assetDirectory, { withFileTypes: true })
  const assets = new Map()

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        if (!entry.name.endsWith('.zip') && !entry.name.endsWith('.dmg')) {
          assets.set(entry.name, null)
          return
        }

        const hash = createHash('sha512')
        for await (const chunk of createReadStream(resolve(assetDirectory, entry.name))) {
          hash.update(chunk)
        }
        assets.set(entry.name, hash.digest('base64'))
      }),
  )

  return assets
}

export function validateLatestMacMetadata(
  metadata,
  expectedVersion,
  releaseAssets,
) {
  const parsed = parseMetadata(metadata)
  if (!parsed) {
    throw new Error('latest-mac.yml has malformed updater metadata')
  }
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error(`expected desktop version must be stable semver: ${expectedVersion}`)
  }
  if (parsed.hasDuplicateTopLevelFields) {
    throw new Error('latest-mac.yml has duplicate or malformed top-level metadata fields')
  }
  if (!parsed.hasRequiredFields) {
    throw new Error('latest-mac.yml is missing required updater metadata fields')
  }
  if (parsed.version !== expectedVersion) {
    throw new Error(
      `latest-mac.yml version ${parsed.version ?? '<missing>'} does not match ${expectedVersion}`,
    )
  }

  const expected = expectedPayloads(expectedVersion)
  const expectedSet = new Set([
    ...expected,
    ...architectures.map(
      (architecture) => `mc-school-studio-${expectedVersion}-${architecture}.dmg`,
    ),
  ])
  const actual = parsed.files.map(({ url }) => url)
  const missing = expected.filter((payload) => !actual.includes(payload))
  const unexpected = actual.filter((payload) => !expectedSet.has(payload))

  if (
    missing.length > 0 ||
    unexpected.length > 0 ||
    actual.length < expected.length ||
    actual.length > expectedSet.size
  ) {
    throw new Error(
      [
        missing.length > 0 ? `missing payloads: ${missing.join(', ')}` : '',
        unexpected.length > 0 ? `unexpected payloads: ${unexpected.join(', ')}` : '',
        actual.length !== new Set(actual).size ? 'duplicate payload entries' : '',
      ]
        .filter(Boolean)
        .join('; '),
    )
  }

  for (const file of parsed.files) {
    if (!file.sha512) {
      throw new Error(`latest-mac.yml payload ${file.url} has no sha512 checksum`)
    }
    if (releaseAssets.get(file.url) !== file.sha512) {
      throw new Error(
        `latest-mac.yml checksum for ${file.url} does not match the release asset`,
      )
    }
  }

  const preferredFile = parsed.files.find(({ url }) => url === parsed.path)
  if (!parsed.path || !preferredFile || !parsed.path.endsWith('.zip')) {
    throw new Error(
      `latest-mac.yml path ${parsed.path ?? '<missing>'} is not a release ZIP`,
    )
  }
  if (parsed.topLevelSha512 !== preferredFile.sha512) {
    throw new Error('latest-mac.yml path checksum does not match its file entry')
  }

  const missingAssets = expectedInstallerAssets(expectedVersion).filter(
    (asset) => !releaseAssets.has(asset),
  )
  if (missingAssets.length > 0) {
    throw new Error(`missing release assets: ${missingAssets.join(', ')}`)
  }

  const allowedAssets = new Set([
    'latest-mac.yml',
    ...expectedInstallerAssets(expectedVersion),
  ])
  const unexpectedAssets = [...releaseAssets.keys()].filter(
    (asset) => !allowedAssets.has(asset),
  )
  if (unexpectedAssets.length > 0) {
    throw new Error(`unexpected release assets: ${unexpectedAssets.join(', ')}`)
  }
}

async function main() {
  const [metadataPath, expectedVersion] = process.argv.slice(2)
  if (!metadataPath || !expectedVersion) {
    throw new Error(
      'Usage: validate-updater-metadata.mjs <latest-mac.yml> <expected-version>',
    )
  }

  const resolvedMetadataPath = resolve(metadataPath)
  const metadata = await readFile(resolvedMetadataPath, 'utf8')
  const assetDirectory = dirname(resolvedMetadataPath)
  const releaseAssets = await indexReleaseAssets(assetDirectory)
  validateLatestMacMetadata(metadata, expectedVersion, releaseAssets)
  console.log(
    `Validated ${basename(resolvedMetadataPath)} for desktop version ${expectedVersion}.`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}