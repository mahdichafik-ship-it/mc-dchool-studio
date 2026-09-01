import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const architecture = process.argv.slice(2).find((argument) => argument !== '--')

if (architecture !== 'x64' && architecture !== 'arm64') {
  throw new Error('Expected a macOS package architecture of x64 or arm64')
}

const imgDirectory = path.join(process.cwd(), 'node_modules', '@img')
const expectedPackages = new Set([
  `sharp-darwin-${architecture}`,
  `sharp-libvips-darwin-${architecture}`,
])

const imgDirectoryStats = await stat(imgDirectory).catch(() => null)
if (!imgDirectoryStats?.isDirectory()) {
  throw new Error(`Sharp optional dependency directory is missing: ${imgDirectory}`)
}

const installedPackages = await readdir(imgDirectory)
for (const packageName of expectedPackages) {
  if (!installedPackages.includes(packageName)) {
    throw new Error(`Required native package @img/${packageName} is missing`)
  }
}

const removablePackages = installedPackages.filter(
  (packageName) => packageName.startsWith('sharp-') && !expectedPackages.has(packageName),
)

await Promise.all(
  removablePackages.map((packageName) =>
    rm(path.join(imgDirectory, packageName), { force: true, recursive: true }),
  ),
)

const remainingNativePackages = (await readdir(imgDirectory)).filter((packageName) =>
  packageName.startsWith('sharp-'),
)
const unexpectedPackages = remainingNativePackages.filter(
  (packageName) => !expectedPackages.has(packageName),
)

if (unexpectedPackages.length > 0) {
  throw new Error(
    `Unexpected Sharp native packages remain for ${architecture}: ${unexpectedPackages.join(', ')}`,
  )
}

console.log(
  `Prepared Sharp native dependencies for macOS ${architecture}; removed ${removablePackages.length} incompatible package(s)`,
)