import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  ensurePhotoSystemLayout,
  ensureProjectStorageLayout,
  getPhotoSystemLayout,
  getProjectStorageLayout,
} from '../src/main/lib/storageLayout.ts'

test('creates the MC_PhotoSystem root and spool directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-storage-'))

  try {
    const layout = ensurePhotoSystemLayout(getPhotoSystemLayout(root))
    assert.equal(layout.root, join(root, 'MC_PhotoSystem'))
    assert.equal(existsSync(layout.spoolJpeg), true)
    assert.equal(existsSync(layout.spoolRaw), true)
    assert.equal(existsSync(layout.cache), true)
    assert.equal(existsSync(layout.settings), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('creates a project layout with separate JPEG and RAW originals', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-project-'))

  try {
    const system = ensurePhotoSystemLayout(getPhotoSystemLayout(root))
    const project = ensureProjectStorageLayout(
      getProjectStorageLayout(system, 42, 'School / North'),
    )

    assert.match(project.root, /School _ North-42$/)
    assert.equal(existsSync(project.jpegOriginals), true)
    assert.equal(existsSync(project.jpegPreviews), true)
    assert.equal(existsSync(project.jpegThumbnails), true)
    assert.equal(existsSync(project.rawOriginals), true)
    assert.equal(existsSync(project.exports), true)
    assert.equal(existsSync(project.logs), true)
    assert.equal(project.database.endsWith('database.sqlite'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})