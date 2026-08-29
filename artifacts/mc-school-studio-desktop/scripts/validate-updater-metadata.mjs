import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const architectures = ['arm64', 'x64']

function expectedPayloads(version) {
  return architectures.map(
    (architecture) => `mc-school-studio-${version}-${architecture}.zip`,
  )
}

function parseMetadata(metadata) {
  const version = metadata.match(/^version:\s*([^\s#]+)\s*$/m)?.[1]
  const path = metadata.match(/^path:\s*([^\s#]+)\s*$/m)?.[1]
  const topLevelSha512 = metadata.match(/^sha512:\s*([^\s#]+)\s*$/m)?.[1]
  const files = []
  const lines = metadata.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const url = lines[index].match(/^\s*-\s+url:\s*([^\s#]+)\s*$/)?.[1]
    if (!url) continue

    const sha512 = lines[index + 1]?.match(/^\s+sha512:\s*([^\s#]+)\s*$/)?.[1]
    files.push({ url, sha512 })
  }

  return { files, path, topLevelSha512, version }
}

export async function indexReleaseAssets(assetDirectory) {
  const entries = await readdir(assetDirectory, { withFileTypes: true })
  const assets = new Map()

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        if (!entry.name.endsWith('.zip')) {
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
  if (parsed.version !== expectedVersion) {
    throw new Error(
      `latest-mac.yml version ${parsed.version ?? '<missing>'} does not match ${expectedVersion}`,
    )
  }

  const expected = expectedPayloads(expectedVersion)
  const expectedSet = new Set(expected)
  const actual = parsed.files.map(({ url }) => url)
  const missing = expected.filter((payload) => !actual.includes(payload))
  const unexpected = actual.filter((payload) => !expectedSet.has(payload))

  if (missing.length > 0 || unexpected.length > 0 || actual.length !== expected.length) {
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
        `latest-mac.yml checksum for ${file.url} does not match the release ZIP`,
      )
    }
  }

  const preferredFile = parsed.files.find(({ url }) => url === parsed.path)
  if (!preferredFile || !parsed.path.endsWith('.zip')) {
    throw new Error(
      `latest-mac.yml path ${parsed.path ?? '<missing>'} is not a release ZIP`,
    )
  }
  if (parsed.topLevelSha512 !== preferredFile.sha512) {
    throw new Error('latest-mac.yml path checksum does not match its file entry')
  }

  const missingAssets = expected
    .flatMap((payload) => [payload, `${payload}.blockmap`])
    .filter((asset) => !releaseAssets.has(asset))
  if (missingAssets.length > 0) {
    throw new Error(`missing release assets: ${missingAssets.join(', ')}`)
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