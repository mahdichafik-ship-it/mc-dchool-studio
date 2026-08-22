import { strict as assert } from 'node:assert'
import test from 'node:test'
import { extractStudentReference } from '../src/main/lib/photoFileNaming.ts'

const studentIds = ['001234', '00123', 'AB12']

test('extracts the Smart Shooter student reference from a renamed JPEG', () => {
  assert.equal(
    extractStudentReference('Smith_John_class_school-001234.jpg', studentIds),
    '001234',
  )
})

test('supports underscore-delimited references and other image extensions', () => {
  assert.equal(
    extractStudentReference('Doe_Sarah_class_school_001234.jpeg', studentIds),
    '001234',
  )
})

test('does not match an ID embedded in the middle of a filename', () => {
  assert.equal(
    extractStudentReference('001234_backup_Smith.jpg', studentIds),
    null,
  )
})

test('returns the longest matching ID when IDs share a prefix', () => {
  assert.equal(
    extractStudentReference('Student-001234.jpg', studentIds),
    '001234',
  )
})

test('returns null for an unknown or unsupported filename reference', () => {
  assert.equal(
    extractStudentReference('Smith_John_class_school-999999.jpg', studentIds),
    null,
  )
})