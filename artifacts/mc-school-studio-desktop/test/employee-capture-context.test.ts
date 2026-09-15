import assert from 'node:assert/strict'
import test from 'node:test'
import { getEmployeeCaptureContext } from '../src/renderer/src/lib/employeeCaptureContext.ts'

test('presents the corporate details a photographer needs during capture', () => {
  assert.deepEqual(getEmployeeCaptureContext({
    photoSession: '09:30',
    jobTitle: 'Engineer',
    officeLocation: 'North office',
    captureNotes: 'Glasses off',
  }, true), [
    { label: 'Appointment time', value: '09:30' },
    { label: 'Job title', value: 'Engineer' },
    { label: 'Office / location', value: 'North office' },
    { label: 'Capture notes', value: 'Glasses off', emphasized: true },
  ])
})

test('keeps school and legacy records free of corporate-only presentation', () => {
  const empty = {
    photoSession: null,
    jobTitle: null,
    officeLocation: null,
    captureNotes: null,
  }
  assert.deepEqual(getEmployeeCaptureContext(empty, true), [])
  assert.deepEqual(getEmployeeCaptureContext({
    ...empty,
    captureNotes: 'Must not appear in school mode',
  }, false), [])
})