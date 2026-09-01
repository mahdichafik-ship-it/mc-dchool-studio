import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const [releaseDirectoryArgument, version] = process.argv.slice(2)
if (!releaseDirectoryArgument || !version) {
  throw new Error(
    'Usage: merge-mac-updater-metadata.mjs <release-directory> <version>',
  )
}

const releaseDirectory = resolve(releaseDirectoryArgument)
const expectedFiles = ['x64', 'arm64'].map(
  (architecture) => `mc-school-studio-${version}-${architecture}.zip`,
)
const entries = new Set(await readdir(releaseDirectory))

for (const file of expectedFiles) {
  if (!entries.has(file)) {
    throw new Error(`Missing macOS updater payload: ${file}`)
  }
}

async function sha512(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(resolve(releaseDirectory, file))) {
    hash.update(chunk)
  }
  return hash.digest('base64')
}

const files = await Promise.all(
  expectedFiles.map(async (url) => ({ url, sha512: await sha512(url) })),
)
const preferred =
  files.find(({ url }) => url.endsWith('-arm64.zip')) ?? files[0]
const metadata = [
  `version: ${version}`,
  'files:',
  ...files.flatMap(({ url, sha512: checksum }) => [
    `  - url: ${url}`,
    `    sha512: ${checksum}`,
  ]),
  `path: ${preferred.url}`,
  `sha512: ${preferred.sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n')

const outputPath = resolve(releaseDirectory, 'latest-mac.yml')
await writeFile(outputPath, metadata)
console.log(`Merged macOS updater metadata at ${basename(outputPath)}.`)
