import { strict as assert } from 'node:assert'
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  copyManagedCaptureFile,
  getManagedCaptureTempPath,
} from '../src/main/lib/managedCaptureCopy.ts'

test('reconciles an identical managed file left by an interrupted persistence step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volume-capture-managed-copy-'))
  try {
    const source = join(root, 'source.jpg')
    const destination = join(root, 'managed.jpg')
    await writeFile(source, 'same image bytes')
    assert.equal(await copyManagedCaptureFile(source, destination), 'copied')
    assert.equal(await copyManagedCaptureFile(source, destination), 'reconciled')
    assert.equal(await readFile(destination, 'utf8'), 'same image bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('never overwrites different image bytes at an existing managed path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volume-capture-managed-copy-'))
  try {
    const source = join(root, 'source.jpg')
    const destination = join(root, 'managed.jpg')
    await writeFile(source, 'new image bytes')
    await writeFile(destination, 'existing image bytes')
    await assert.rejects(
      copyManagedCaptureFile(source, destination),
      /already contains different image data/,
    )
    assert.equal(await readFile(destination, 'utf8'), 'existing image bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('replaces its own partial copy and publishes complete bytes after a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volume-capture-managed-copy-'))
  try {
    const source = join(root, 'source.raw')
    const destination = join(root, 'managed.raw')
    const completeBytes = Buffer.alloc(1024 * 1024, 17)
    await writeFile(source, completeBytes)
    await writeFile(
      getManagedCaptureTempPath(source, destination),
      completeBytes.subarray(0, 4096),
    )
    assert.equal(await copyManagedCaptureFile(source, destination), 'copied')
    assert.deepEqual(await readFile(destination), completeBytes)
    await assert.rejects(
      readFile(getManagedCaptureTempPath(source, destination)),
      { code: 'ENOENT' },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('never changes a published final when a stale temp name shares its inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volume-capture-managed-copy-'))
  try {
    const source = join(root, 'source.raw')
    const destination = join(root, 'managed.raw')
    const temporary = getManagedCaptureTempPath(source, destination)
    await writeFile(source, 'new image bytes')
    await writeFile(destination, 'published image bytes')
    await link(destination, temporary)
    await assert.rejects(
      copyManagedCaptureFile(source, destination),
      /already contains different image data/,
    )
    assert.equal(await readFile(destination, 'utf8'), 'published image bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reconciles identical bytes when a stale temp name shares the final inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volume-capture-managed-copy-'))
  try {
    const source = join(root, 'source.raw')
    const destination = join(root, 'managed.raw')
    const temporary = getManagedCaptureTempPath(source, destination)
    await writeFile(source, 'published image bytes')
    await writeFile(destination, 'published image bytes')
    await link(destination, temporary)
    assert.equal(await copyManagedCaptureFile(source, destination), 'reconciled')
    assert.equal(await readFile(destination, 'utf8'), 'published image bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('publishes by atomic rename when the destination filesystem rejects hard links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volume-capture-managed-copy-'))
  try {
    const source = join(root, 'source.raw')
    const destination = join(root, 'managed.raw')
    await writeFile(source, 'complete image bytes')
    assert.equal(
      await copyManagedCaptureFile(source, destination, {
        linkFile: async () => {
          throw Object.assign(new Error('Hard links are unsupported'), { code: 'ENOTSUP' })
        },
      }),
      'copied',
    )
    assert.equal(await readFile(destination, 'utf8'), 'complete image bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('portable fallback never replaces an existing destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volume-capture-managed-copy-'))
  try {
    const source = join(root, 'source.raw')
    const destination = join(root, 'managed.raw')
    await writeFile(source, 'new image bytes')
    await writeFile(destination, 'published image bytes')
    await assert.rejects(
      copyManagedCaptureFile(source, destination, {
        linkFile: async () => {
          throw Object.assign(new Error('Hard links are unsupported'), { code: 'EPERM' })
        },
      }),
      /already contains different image data/,
    )
    assert.equal(await readFile(destination, 'utf8'), 'published image bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})