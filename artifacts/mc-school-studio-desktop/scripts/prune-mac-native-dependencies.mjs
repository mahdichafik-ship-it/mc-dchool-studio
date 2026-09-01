import { readdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const architecture = process.argv.slice(2).find((argument) => argument !== '--')

if (architecture !== 'x64' && architecture !== 'arm64') {
  throw new Error('Expected a macOS package architecture of x64 or arm64')
}

const packageRoot = process.cwd()
const packageImgDirectory = path.join(packageRoot, 'node_modules', '@img')
const sharpDirectory = await realpath(path.join(packageRoot, 'node_modules', 'sharp')).catch(
  () => null,
)
const sharpImgDirectory = sharpDirectory
  ? path.join(path.dirname(sharpDirectory), '@img')
  : null
let virtualStoreDirectory = sharpDirectory
  ? path.dirname(sharpDirectory)
  : null
while (virtualStoreDirectory && path.basename(virtualStoreDirectory) !== '.pnpm') {
  const parentDirectory = path.dirname(virtualStoreDirectory)
  virtualStoreDirectory =
    parentDirectory === virtualStoreDirectory ? null : parentDirectory
}
const expectedPackages = new Set([
  `sharp-darwin-${architecture}`,
  `sharp-libvips-darwin-${architecture}`,
])
const expectedStorePrefixes = [...expectedPackages].map(
  (packageName) => `@img+${packageName}@`,
)

const candidateDirectories = [...new Set([packageImgDirectory, sharpImgDirectory].filter(Boolean))]
const imgDirectories = []

for (const directory of candidateDirectories) {
  const directoryStats = await stat(directory).catch(() => null)
  if (directoryStats?.isDirectory()) {
    imgDirectories.push(directory)
  }
}

if (imgDirectories.length === 0) {
  throw new Error(
    `Sharp optional dependency directories are missing: ${candidateDirectories.join(', ')}`,
  )
}
if (!virtualStoreDirectory) {
  throw new Error(`Unable to locate the pnpm virtual store from ${sharpDirectory}`)
}

const installedPackages = new Set()
for (const directory of imgDirectories) {
  for (const packageName of await readdir(directory)) {
    installedPackages.add(packageName)
  }
}

for (const packageName of expectedPackages) {
  if (!installedPackages.has(packageName)) {
    throw new Error(`Required native package @img/${packageName} is missing`)
  }
}

let removedCount = 0

for (const directory of imgDirectories) {
  const removablePackages = (await readdir(directory)).filter(
    (packageName) => packageName.startsWith('sharp-') && !expectedPackages.has(packageName),
  )

  await Promise.all(
    removablePackages.map((packageName) =>
      rm(path.join(directory, packageName), { force: true, recursive: true }),
    ),
  )
  removedCount += removablePackages.length

  const unexpectedPackages = (await readdir(directory)).filter(
    (packageName) => packageName.startsWith('sharp-') && !expectedPackages.has(packageName),
  )

  if (unexpectedPackages.length > 0) {
    throw new Error(
      `Unexpected Sharp native packages remain for ${architecture} in ${directory}: ${unexpectedPackages.join(', ')}`,
    )
  }
}

const storeEntries = await readdir(virtualStoreDirectory)
const nativeStoreEntries = storeEntries.filter((entry) => entry.startsWith('@img+sharp-'))
for (const expectedPrefix of expectedStorePrefixes) {
  if (!nativeStoreEntries.some((entry) => entry.startsWith(expectedPrefix))) {
    throw new Error(`Required pnpm virtual-store package ${expectedPrefix}* is missing`)
  }
}

const removableStoreEntries = nativeStoreEntries.filter(
  (entry) => !expectedStorePrefixes.some((prefix) => entry.startsWith(prefix)),
)
await Promise.all(
  removableStoreEntries.map((entry) =>
    rm(path.join(virtualStoreDirectory, entry), { force: true, recursive: true }),
  ),
)

const unexpectedStoreEntries = (await readdir(virtualStoreDirectory)).filter(
  (entry) =>
    entry.startsWith('@img+sharp-') &&
    !expectedStorePrefixes.some((prefix) => entry.startsWith(prefix)),
)
if (unexpectedStoreEntries.length > 0) {
  throw new Error(
    `Unexpected Sharp native packages remain in the pnpm virtual store for ${architecture}: ${unexpectedStoreEntries.join(', ')}`,
  )
}

console.log(
  `Prepared Sharp native dependencies for macOS ${architecture}; checked ${imgDirectories.length} link director${imgDirectories.length === 1 ? 'y' : 'ies'}, removed ${removedCount} incompatible link(s), and removed ${removableStoreEntries.length} incompatible virtual-store package(s)`,
)