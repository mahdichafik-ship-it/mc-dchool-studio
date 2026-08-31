import { strict as assert } from 'node:assert'
import test from 'node:test'
import { extractStudentReference } from '../src/main/lib/photoFileNaming.ts'

const studentIds = ['001234', '00123', 'AB12', '7WCXGO8']

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

test('supports a numeric Smart Shooter frame counter after the student reference', () => {
  assert.equal(
    extractStudentReference('ZAKI_Dina_class_school_AB12_595.JPG', studentIds),
    'AB12',
  )
  assert.equal(
    extractStudentReference('ZAKI_Dina_class_school-001234-596.jpeg', studentIds),
    '001234',
  )
  assert.equal(
    extractStudentReference('ZAKI_Dina_ZAKI_Dina_7WCXGO8_595.JPG', studentIds),
    '7WCXGO8',
  )
})

test('matches case-insensitively while returning the roster ID', () => {
  assert.equal(
    extractStudentReference('Smith_John_class_school-ab12-595.JPG', studentIds),
    'AB12',
  )
})

test('does not match an ID embedded in the middle of a filename', () => {
  assert.equal(
    extractStudentReference('001234_backup_Smith.jpg', studentIds),
    null,
  )
})

test('does not accept arbitrary trailing text after a student reference', () => {
  assert.equal(
    extractStudentReference('001234_backup_Smith.jpg', studentIds),
    null,
  )
  assert.equal(
    extractStudentReference('Smith_John_001234_backup.jpg', studentIds),
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