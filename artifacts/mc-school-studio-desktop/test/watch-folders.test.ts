import { strict as assert } from 'node:assert'
import test from 'node:test'
import { resolveWatchFolders } from '../src/main/lib/watchFolders.ts'

test('resolves a Spool folder to sibling JPEG and RAW watchers', () => {
  const result = resolveWatchFolders('/Users/photographer/MC_PhotoSystem/Spool')

  assert.equal(result.mode, 'dual')
  assert.deepEqual(result.paths, [
    '/Users/photographer/MC_PhotoSystem/Spool/JPEG',
    '/Users/photographer/MC_PhotoSystem/Spool/RAW',
  ])
})

test('resolves a selected JPEG or RAW child back to both spool folders', () => {
  const jpegResult = resolveWatchFolders('/shoot/Spool/JPEG')
  const rawResult = resolveWatchFolders('/shoot/Spool/RAW')

  assert.equal(jpegResult.mode, 'dual')
  assert.deepEqual(jpegResult.paths, ['/shoot/Spool/JPEG', '/shoot/Spool/RAW'])
  assert.equal(rawResult.mode, 'dual')
  assert.deepEqual(rawResult.paths, ['/shoot/Spool/JPEG', '/shoot/Spool/RAW'])
})

test('keeps a legacy flat Smart Shooter folder as a single watcher', () => {
  const result = resolveWatchFolders('/shoot/Smart Shooter')

  assert.equal(result.mode, 'legacy')
  assert.deepEqual(result.paths, ['/shoot/Smart Shooter'])
})

test('detects an existing JPEG or RAW sibling under a custom spool root', () => {
  const result = resolveWatchFolders(
    '/shoot/camera-output',
    (path) => path === '/shoot/camera-output/RAW',
  )

  assert.equal(result.mode, 'dual')
  assert.deepEqual(result.paths, ['/shoot/camera-output/JPEG', '/shoot/camera-output/RAW'])
})