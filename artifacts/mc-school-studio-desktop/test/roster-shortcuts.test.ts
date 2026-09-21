import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  isRosterShortcutEditingTarget,
  resolveRosterShortcut,
} from '../src/renderer/src/lib/rosterShortcuts.ts'
import { ratingFromShortcut } from '../src/renderer/src/lib/reviewShortcuts.ts'

const students = [
  { id: 11, photoCount: 2, name: 'First visible' },
  { id: 22, photoCount: 0, name: 'Second visible' },
  { id: 33, photoCount: 0, name: 'Third visible' },
]

function shortcut(overrides: Partial<Parameters<typeof resolveRosterShortcut<typeof students[number]>>[0]> = {}) {
  return resolveRosterShortcut({
    key: '/',
    students,
    selectedStudentId: null,
    activeStudentId: null,
    hasSearch: false,
    hasActiveTarget: false,
    blocked: false,
    ...overrides,
  })
}

test('slash focuses roster search', () => {
  assert.deepEqual(shortcut(), { type: 'focus-search' })
})

test('arrow keys select the expected visible subject', () => {
  assert.deepEqual(shortcut({ key: 'ArrowDown', selectedStudentId: 11 }), {
    type: 'select-student',
    student: students[1],
  })
  assert.deepEqual(shortcut({ key: 'ArrowUp', selectedStudentId: 33 }), {
    type: 'select-student',
    student: students[1],
  })
  assert.deepEqual(shortcut({ key: 'ArrowDown', activeStudentId: 22 }), {
    type: 'select-student',
    student: students[2],
  })
})

test('N selects the next visible subject without captures and wraps', () => {
  assert.deepEqual(shortcut({ key: 'n', selectedStudentId: 11 }), {
    type: 'select-student',
    student: students[1],
  })
  assert.deepEqual(shortcut({ key: 'N', selectedStudentId: 33 }), {
    type: 'select-student',
    student: students[1],
  })
})

test('Escape clears search before clearing the active target', () => {
  assert.deepEqual(shortcut({
    key: 'Escape',
    hasSearch: true,
    hasActiveTarget: true,
  }), { type: 'clear-search' })
  assert.deepEqual(shortcut({
    key: 'Escape',
    hasSearch: false,
    hasActiveTarget: true,
  }), { type: 'clear-target' })
})

test('editing targets include inputs, textareas, selects, and contenteditable regions', () => {
  for (const tagName of ['INPUT', 'textarea', 'Select']) {
    assert.equal(isRosterShortcutEditingTarget({ tagName }), true)
  }
  assert.equal(isRosterShortcutEditingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isRosterShortcutEditingTarget({ tagName: 'BUTTON' }), false)
})

test('open dialogs and finished projects block every roster shortcut', () => {
  for (const key of ['/', 'ArrowUp', 'ArrowDown', 'n', 'N', 'Escape']) {
    assert.deepEqual(shortcut({
      key,
      selectedStudentId: 11,
      hasSearch: true,
      hasActiveTarget: true,
      blocked: true,
    }), { type: 'none' })
  }
})

test('student actions carry the same subject used for selection and active capture', () => {
  const action = shortcut({ key: 'ArrowDown', selectedStudentId: 11 })
  assert.equal(action.type, 'select-student')
  if (action.type === 'select-student') {
    assert.equal(action.student.id, 22)
    assert.strictEqual(action.student, students[1])
  }
})

test('ProjectView routes shortcut selection through the synchronized capture-target action', async () => {
  const source = await readFile(
    new URL('../src/renderer/src/pages/ProjectView.tsx', import.meta.url),
    'utf8',
  )

  assert.match(source, /if \(isRosterShortcutEditingTarget\(target\)\)/)
  assert.match(source, /blocked: anyDialogOpen \|\| Boolean\(project\?\.finishedAt\)/)
  assert.match(
    source,
    /if \(action\.type === 'select-student'\)[\s\S]*handleSelectCaptureStudent\(action\.student\)/,
  )
  assert.match(
    source,
    /async function handleSelectCaptureStudent\(student: Student\)[\s\S]*await setActiveCaptureTarget\(student\.id\)[\s\S]*setSelectedStudent\(student\)/,
  )
})

test('number keys map to one through five star ratings only', () => {
  assert.deepEqual(
    ['1', '2', '3', '4', '5'].map(ratingFromShortcut),
    [1, 2, 3, 4, 5],
  )
  for (const key of ['0', '6', 'a', 'ArrowLeft']) {
    assert.equal(ratingFromShortcut(key), null)
  }
})

test('ProjectView routes number shortcuts through the selected capture review action', async () => {
  const source = await readFile(
    new URL('../src/renderer/src/pages/ProjectView.tsx', import.meta.url),
    'utf8',
  )

  assert.match(source, /const rating = ratingFromShortcut\(event\.key\)/)
  assert.match(source, /if \(rating !== null && selectedCapture\)[\s\S]*handleUpdateCaptureReview\(selectedCapture\.id/)
  assert.match(source, /press 1–5 to rate the selected capture/)
})
