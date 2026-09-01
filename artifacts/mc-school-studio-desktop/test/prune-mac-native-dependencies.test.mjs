import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(
  new URL('../scripts/prune-mac-native-dependencies.mjs', import.meta.url),
)

test('prunes incompatible Sharp packages from the pnpm virtual-store layout', (t) => {
  const packageRoot = mkdtempSync(path.join(tmpdir(), 'mc-prune-mac-native-'))
  t.after(() => rmSync(packageRoot, { force: true, recursive: true }))

  const virtualNodeModules = path.join(
    packageRoot,
    'node_modules',
    '.pnpm',
    'sharp@0.35.4',
    'node_modules',
  )
  const sharpDirectory = path.join(virtualNodeModules, 'sharp')
  const imgDirectory = path.join(virtualNodeModules, '@img')
  const packageNames = [
    'sharp-darwin-x64',
    'sharp-libvips-darwin-x64',
    'sharp-darwin-arm64',
    'sharp-libvips-darwin-arm64',
    'sharp-linux-x64',
  ]

  mkdirSync(sharpDirectory, { recursive: true })
  mkdirSync(imgDirectory, { recursive: true })
  for (const packageName of packageNames) {
    const storeEntry = path.join(
      packageRoot,
      'node_modules',
      '.pnpm',
      `@img+${packageName}@fixture`,
    )
    const storedPackage = path.join(storeEntry, 'node_modules', '@img', packageName)
    mkdirSync(storedPackage, { recursive: true })
    symlinkSync(
      storedPackage,
      path.join(imgDirectory, packageName),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }
  symlinkSync(
    sharpDirectory,
    path.join(packageRoot, 'node_modules', 'sharp'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  const output = execFileSync(process.execPath, [script, '--', 'x64'], {
    cwd: packageRoot,
    encoding: 'utf8',
  })

  assert.match(output, /Prepared Sharp native dependencies for macOS x64/)
  assert.equal(existsSync(path.join(imgDirectory, 'sharp-darwin-x64')), true)
  assert.equal(existsSync(path.join(imgDirectory, 'sharp-libvips-darwin-x64')), true)
  assert.equal(existsSync(path.join(imgDirectory, 'sharp-darwin-arm64')), false)
  assert.equal(existsSync(path.join(imgDirectory, 'sharp-libvips-darwin-arm64')), false)
  assert.equal(existsSync(path.join(imgDirectory, 'sharp-linux-x64')), false)
  assert.equal(
    existsSync(
      path.join(packageRoot, 'node_modules', '.pnpm', '@img+sharp-darwin-x64@fixture'),
    ),
    true,
  )
  assert.equal(
    existsSync(
      path.join(packageRoot, 'node_modules', '.pnpm', '@img+sharp-libvips-darwin-x64@fixture'),
    ),
    true,
  )
  assert.equal(
    existsSync(
      path.join(packageRoot, 'node_modules', '.pnpm', '@img+sharp-darwin-arm64@fixture'),
    ),
    false,
  )
  assert.equal(
    existsSync(
      path.join(packageRoot, 'node_modules', '.pnpm', '@img+sharp-libvips-darwin-arm64@fixture'),
    ),
    false,
  )
  assert.equal(
    existsSync(path.join(packageRoot, 'node_modules', '.pnpm', '@img+sharp-linux-x64@fixture')),
    false,
  )
})