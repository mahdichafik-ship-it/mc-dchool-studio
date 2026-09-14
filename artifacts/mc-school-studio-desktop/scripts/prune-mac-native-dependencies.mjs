import { readdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const architecture = process.argv.slice(2).find((argument) => argument !== '--')

if (architecture !== 'x64' && architecture !== 'arm64') {
  throw new Error('Expected a macOS package architecture of x64 or arm64')
}

const packageRoot = process.cwd()
const sharpDirectory = await realpath(path.join(packageRoot, 'node_modules', 'sharp')).catch(
  () => null,
)
if (!sharpDirectory) {
  throw new Error('Unable to resolve the real Sharp package from node_modules/sharp')
}

// pnpm links Sharp's optional dependencies beside the real Sharp package:
//   .pnpm/sharp@.../node_modules/sharp
//   .pnpm/sharp@.../node_modules/@img
// They are not under sharp/node_modules/@img.
const sharpImgDirectory = path.join(path.dirname(sharpDirectory), '@img')
let virtualStoreDirectory = path.dirname(sharpDirectory)
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

const sharpImgStats = await stat(sharpImgDirectory).catch(() => null)
if (!sharpImgStats?.isDirectory()) {
  throw new Error(`Sharp optional dependency directory is missing: ${sharpImgDirectory}`)
}
if (!virtualStoreDirectory) {
  throw new Error(`Unable to locate the pnpm virtual store from ${sharpDirectory}`)
}

const installedPackages = new Set()
for (const packageName of await readdir(sharpImgDirectory)) {
  installedPackages.add(packageName)
}

for (const packageName of expectedPackages) {
  if (!installedPackages.has(packageName)) {
    throw new Error(`Required native package @img/${packageName} is missing`)
  }
}

let removedCount = 0

const removablePackages = (await readdir(sharpImgDirectory)).filter(
  (packageName) => packageName.startsWith('sharp-') && !expectedPackages.has(packageName),
)

await Promise.all(
  removablePackages.map((packageName) =>
    rm(path.join(sharpImgDirectory, packageName), { force: true, recursive: true }),
  ),
)
removedCount += removablePackages.length

const unexpectedPackages = (await readdir(sharpImgDirectory)).filter(
  (packageName) => packageName.startsWith('sharp-') && !expectedPackages.has(packageName),
)

if (unexpectedPackages.length > 0) {
  throw new Error(
    `Unexpected Sharp native packages remain for ${architecture} in ${sharpImgDirectory}: ${unexpectedPackages.join(', ')}`,
  )
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
  `Prepared Sharp native dependencies for macOS ${architecture}; checked ${sharpImgDirectory}, removed ${removedCount} incompatible link(s), and removed ${removableStoreEntries.length} incompatible virtual-store package(s)`,
)
