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
const uploadPath = new URL('../src/main/ipc/upload.ts', import.meta.url)
const projectSyncPath = new URL('../src/main/ipc/projectSync.ts', import.meta.url)

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
  assert.match(css, /\.shoot-group-body\[data-roster-expanded="true"\][\s\S]*grid-template-columns:/)
  assert.match(view, /data-testid="group-photo-roster"/, 'class and group photo targets must remain visible in the roster column')
  assert.match(view, /Photo targets/, 'the roster must expose the capture targets')
  assert.match(view, /— Class Photo/, 'the selected class must have a direct class-photo target')
  assert.doesNotMatch(view, /Class &amp; group photos/, 'the separate top-level selector must be removed')
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

test('class-photo review selects an active capture from the camera roll', async () => {
  const view = await readFile(projectViewPath, 'utf8')

  assert.match(view, /Unrated photos stay private/)
  assert.match(view, /Unrated photos stay private and are not shared with families/)
  assert.match(view, /Choose a five-star portrait for each person/)
  assert.match(view, /Camera roll/)
  assert.match(view, /role="listbox"[\s\S]*aria-label="Class photo captures"/)
  assert.match(view, /role="option"[\s\S]*aria-selected=\{isSelected\}/)
  assert.match(view, /onClick=\{\(event\) => selectFilmstripCapture\(capture\.id, event\.shiftKey\)\}/)
  assert.match(view, /onContextMenu=\{\(event\) => openMoveMenu\(event, capture\.id\)\}/)
  assert.match(view, /draggable[\s\S]*onDragStart=\{\(event\) => \{[\s\S]*application\/x-volume-capture-group-captures/)
  assert.match(view, /Shift-click range · right-click to move/)
  assert.match(view, /aria-expanded=\{memberListExpanded\}/)
  assert.match(view, /id="group-member-roster"[\s\S]*hidden=\{!memberListExpanded\}/)
  assert.match(view, /groupCaptures:moveMany/)
  assert.match(view, /if \(rating === null \|\| !activeCapture\) return/)
  assert.match(view, /activeCapture\.id,[\s\S]*activeCapture\.rating === rating/)
  assert.match(view, /moveFilmstripSelection\('previous'\)/)
  assert.match(view, /moveFilmstripSelection\('next'\)/)
  assert.match(view, /shouldReturnToLatestOnNewCapture\(previousLatest\.captureId, latestCaptureId\)/)
  assert.match(view, /maxEdge=\{1440\}/, 'the selected group photo should upgrade to the full local preview')
  assert.match(view, /const thumbnailEdge = Math\.min\(320, maxEdge\)/, 'filmstrip thumbnails should keep their fast small size')
})

test('accepted student and class-photo drop targets are visibly highlighted', async () => {
  const view = await readFile(projectViewPath, 'utf8')

  assert.match(view, /data-drop-target="student"[\s\S]*data-drop-active=\{isDropActive \? 'true' : 'false'\}/)
  assert.match(view, /data-drop-target="class-photo"[\s\S]*data-drop-active=\{draggedGroupId === group\.id \? 'true' : 'false'\}/)
  assert.match(view, /draggedGroupId === group\.id[\s\S]*border-teal-500 bg-teal-100/)
  assert.match(view, /isDropActive && \([\s\S]*Drop here/)
})

test('five-star review lists the exact people and blocks every cloud-upload entry point', async () => {
  const [view, upload, projectSync] = await Promise.all([
    readFile(projectViewPath, 'utf8'),
    readFile(uploadPath, 'utf8'),
    readFile(projectSyncPath, 'utf8'),
  ])

  assert.match(view, /studentsMissingFiveStarPortraitIds/)
  assert.match(view, /data-testid="missing-favorite-portrait-list"/)
  assert.match(view, /aria-label=\{`Review portrait for \$\{entry\.fullName\}, \$\{entry\.className\}`\}/)
  assert.match(view, /startMissingFavoriteReview\(studentId, 'upload'\)/)
  assert.match(view, /startMissingFavoriteReview\(studentId, 'finish'\)/)
  assert.match(view, /focusMissingFavoritePortrait\(nextEntry\.studentId, favoriteReviewReturnTo\)/)
  assert.match(view, /Return to validation/)
  assert.match(view, /missingFavoritePortraitCount > 0/)
  assert.match(view, /hasRatedGroupCapture=\{captureReviewStatus\.ratedGroupStudentIds\.includes\(s\.id\)\}/)
  assert.match(view, /hasRatedGroupCapture && \([\s\S]*aria-label="Rated class\/group photo"/)
  assert.match(view, /hasFiveStarPortrait && \([\s\S]*aria-label="Five-star portrait favorite"/)
  assert.match(view, /captureReviewStatus\.fiveStarPortraitStudentIds\.includes\(s\.id\)/)
  assert.match(view, /capture\.rating === 5[\s\S]*5-star favorite/)
  assert.match(upload, /if \(getMissingFavoritePortraitStudentIds\(projectId\)\.length > 0\) return/)
  assert.match(upload, /enabled && getMissingFavoritePortraitStudentIds\(projectId\)\.length > 0/)
  assert.match(projectSync, /missingFavoriteStudentIds\.length > 0 && deps\.isCloudSessionVerified\(\)/)
  assert.match(view, /You are offline\. You can finish this shoot locally/)
})

test('JPEG-only and paired captures report truthful aggregate upload state', () => {
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'pending', galleryReady: false },
  ]), 'Retry scheduled')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: null, galleryReady: false },
]), 'Ready to upload')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: null, galleryReady: false },
  ], true), 'Queued')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'done', galleryReady: false },
  ]), 'Preparing gallery')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'done', galleryReady: true },
  ]), 'Uploaded')

  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'done', galleryReady: true },
    { fileRole: 'RAW', uploadStatus: 'pending' },
  ]), 'Retry scheduled')
  assert.equal(captureUploadLabel([
    { fileRole: 'JPEG', uploadStatus: 'done', galleryReady: true },
    { fileRole: 'RAW', uploadStatus: 'done' },
  ]), 'Uploaded')
})