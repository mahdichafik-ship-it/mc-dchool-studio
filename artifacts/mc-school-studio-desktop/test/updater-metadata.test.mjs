import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  indexReleaseAssets,
  validateLatestMacMetadata,
} from '../scripts/validate-updater-metadata.mjs'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureDirectory = join(testDirectory, 'fixtures')
const fixtureVersion = '1.0.11'
const fixture = await readFile(join(fixtureDirectory, 'latest-mac.yml'), 'utf8')
const fixtureAssets = await indexReleaseAssets(fixtureDirectory)

test('accepts electron-builder metadata with both architectures and blockmaps', () => {
  assert.doesNotThrow(() => {
    validateLatestMacMetadata(fixture, fixtureVersion, fixtureAssets)
  })
})

test('accepts metadata that also lists both signed DMG payloads', () => {
  const arm64DmgChecksum = fixtureAssets.get(
    'mc-school-studio-1.0.11-arm64.dmg',
  )
  const x64DmgChecksum = fixtureAssets.get('mc-school-studio-1.0.11-x64.dmg')
  const withDmgPayloads = fixture.replace(
    'files:\n',
    [
      'files:',
      '  - url: mc-school-studio-1.0.11-arm64.dmg',
      `    sha512: ${arm64DmgChecksum}`,
      '  - url: mc-school-studio-1.0.11-x64.dmg',
      `    sha512: ${x64DmgChecksum}`,
      '',
    ].join('\n'),
  )

  assert.doesNotThrow(() => {
    validateLatestMacMetadata(withDmgPayloads, fixtureVersion, fixtureAssets)
  })
})
test('rejects metadata with a missing payload', () => {
  const withoutArm64Zip = fixture.replace(
    /^  - url: mc-school-studio-1\.0\.11-arm64\.zip\n(?:    .+\n)+/m,
    '',
  )

  assert.throws(
    () => validateLatestMacMetadata(withoutArm64Zip, fixtureVersion, fixtureAssets),
    /missing payloads: mc-school-studio-1\.0\.11-arm64\.zip/,
  )
})

test('rejects metadata with a missing blockmap', () => {
  const withoutX64ZipBlockmap = new Map(fixtureAssets)
  withoutX64ZipBlockmap.delete('mc-school-studio-1.0.11-x64.zip.blockmap')

  assert.throws(
    () =>
      validateLatestMacMetadata(
        fixture,
        fixtureVersion,
        withoutX64ZipBlockmap,
      ),
    /missing release assets: mc-school-studio-1\.0\.11-x64\.zip\.blockmap/,
  )
})

test('rejects metadata whose checksum does not match the release ZIP', () => {
  const withStaleChecksum = fixture.replace(
    /^    sha512: .+$/m,
    '    sha512: stale-checksum',
  )

  assert.throws(
    () => validateLatestMacMetadata(withStaleChecksum, fixtureVersion, fixtureAssets),
    /checksum for mc-school-studio-1\.0\.11-arm64\.zip does not match the release asset/,
  )
})

test('rejects metadata with a payload at the wrong path', () => {
  const withWrongPath = fixture.replace(
    'url: mc-school-studio-1.0.11-x64.zip\n',
    'url: releases/mc-school-studio-1.0.11-x64.zip\n',
  )

  assert.throws(
    () => validateLatestMacMetadata(withWrongPath, fixtureVersion, fixtureAssets),
    /unexpected payloads: releases\/mc-school-studio-1\.0\.11-x64\.zip/,
  )
})

test('rejects metadata with a mismatched version', () => {
  const withWrongVersion = fixture.replace('version: 1.0.11', 'version: 1.0.10')

  assert.throws(
    () => validateLatestMacMetadata(withWrongVersion, fixtureVersion, fixtureAssets),
    /latest-mac\.yml version 1\.0\.10 does not match 1\.0\.11/,
  )
})

test('rejects metadata whose preferred path is not a release ZIP', () => {
  const withWrongMetadataPath = fixture.replace(
    'path: mc-school-studio-1.0.11-arm64.zip',
    'path: releases/mc-school-studio-1.0.11-arm64.zip',
  )

  assert.throws(
    () =>
      validateLatestMacMetadata(
        withWrongMetadataPath,
        fixtureVersion,
        fixtureAssets,
      ),
    /latest-mac\.yml path releases\/mc-school-studio-1\.0\.11-arm64\.zip is not a release ZIP/,
  )
})