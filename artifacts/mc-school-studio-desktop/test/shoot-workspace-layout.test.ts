import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  captureUploadLabel,
  shootWorkspaceLayoutContract,
  shootWorkspaceViewports,
} from '../src/renderer/src/lib/shootWorkspace.ts'

const projectViewPath = new URL('../src/renderer/src/pages/ProjectView.tsx', import.meta.url)
const appLayoutPath = new URL('../src/renderer/src/components/layout/AppLayout.tsx', import.meta.url)
const stylesheetPath = new URL('../src/renderer/src/index.css', import.meta.url)

test('active student and group keep critical shoot regions in the compact renderer contract', async () => {
  assert.deepEqual(shootWorkspaceViewports, [
    { width: 1024, height: 700 },
    { width: 1280, height: 800 },
  ])

  const [view, css] = await Promise.all([
    readFile(projectViewPath, 'utf8'),
    readFile(stylesheetPath, 'utf8'),
  ])

  for (const className of Object.values(shootWorkspaceLayoutContract)) {
    assert.match(view, new RegExp(className), `${className} must identify its renderer region`)
  }
  assert.match(css, /@media \(max-width: 1500px\), \(max-height: 800px\)/)
  assert.match(css, /@media \(max-height: 720px\)/)
  assert.match(css, /\.shoot-group-body[\s\S]*grid-template-columns:/)
  assert.match(view, /hidden xl:flex/, 'wide health detail must not displace controls at laptop widths')
})

test('long active subject names wrap while controls remain native keyboard targets', async () => {
  const view = await readFile(projectViewPath, 'utf8')
  const css = await readFile(stylesheetPath, 'utf8')

  assert.match(view, /shoot-subject-name[^"]*break-words/)
  assert.match(css, /\.shoot-subject-name[\s\S]*overflow-wrap: anywhere/)
  assert.match(view, /data-testid="shoot-watch-status"/)
  assert.match(view, /data-testid="shoot-primary-action"/)
  assert.match(view, /data-testid="shoot-completeness"/)
  assert.match(view, /<button[\s\S]*handleToggleWatcher/)
  assert.match(view, /<Button[\s\S]*openFinishDialog/)
})

test('project classes live in the expandable app rail instead of duplicating the roster column', async () => {
  const [view, layout] = await Promise.all([
    readFile(projectViewPath, 'utf8'),
    readFile(appLayoutPath, 'utf8'),
  ])

  assert.match(layout, /id="project-class-navigation"/)
  assert.match(layout, /aria-expanded=\{projectNavOpen\}/)
  assert.match(layout, /onSelectClass\?\.\(projectClass\.id\)/)
  assert.match(layout, /role="tooltip"/)
  assert.match(layout, /group-hover\/sidebar-hint:opacity-100/)
  assert.match(view, /onSelectedClassIdChange/)
  assert.doesNotMatch(view, /Class tabs/)
})

test('JPEG-only and paired captures report truthful aggregate upload state', () => {
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'pending', galleryReady: false },
  ]), 'Queued')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: null, galleryReady: false },
  ]), 'Queued')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'done', galleryReady: false },
  ]), 'Preparing gallery')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'done', galleryReady: true },
  ]), 'Uploaded')

  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'done', galleryReady: true },
    { fileRole: 'RAW', uploadStatus: 'pending' },
  ]), 'Queued')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'done', galleryReady: true },
    { fileRole: 'RAW', uploadStatus: 'done' },
  ]), 'Uploaded')
})