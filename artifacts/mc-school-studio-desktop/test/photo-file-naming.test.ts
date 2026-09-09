import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  extractStudentReference,
  formatGroupPhotoName,
  formatStudentPhotoName,
} from '../src/main/lib/photoFileNaming.ts'

const studentIds = ['001234', '00123', 'AB12', '7WCXGO8']

test('formats a destination photo name from the selected student and source extension', () => {
  assert.equal(
    formatStudentPhotoName('John', 'Smith', '001234', 'camera-frame.NEF'),
    'John_Smith_001234.NEF',
  )
})

test('tags default class-group captures with the class name and camera frame number', () => {
  const jpegName = formatGroupPhotoName('5ème A', '5ème A', 'DSC_00595.JPG', '/Spool/JPEG/DSC_00595.JPG')
  const rawName = formatGroupPhotoName('5ème A', '5ème A', 'DSC_00595.CR3', '/Spool/RAW/DSC_00595.CR3')
  assert.match(jpegName, /^5ème_A_00595_[a-f0-9]{10}\.JPG$/)
  assert.equal(rawName, jpegName.replace(/\.JPG$/, '.CR3'))
})

test('includes a custom group name without retaining the camera prefix', () => {
  const name = formatGroupPhotoName('5ème A', 'Teachers / Staff', 'IMG-0042.jpeg')
  assert.match(name, /^5ème_A_Teachers_Staff_0042_[a-f0-9]{10}\.jpeg$/)
  assert.doesNotMatch(name, /IMG/i)
})

test('uses a deterministic private token when a camera filename has no frame number', () => {
  const jpegName = formatGroupPhotoName('Class B', 'Class B', 'camera-alpha.jpg')
  const rawName = formatGroupPhotoName('Class B', 'Class B', 'camera-alpha.nef')
  assert.match(jpegName, /^Class_B_[a-f0-9]{10}\.jpg$/)
  assert.equal(rawName, jpegName.replace(/\.jpg$/, '.nef'))
  assert.doesNotMatch(jpegName, /camera|alpha/i)
})

test('does not collide when different cameras reuse the same frame number', () => {
  const dscName = formatGroupPhotoName('Class B', 'Class B', 'DSC_0001.JPG', '/shoot/DSC_0001.JPG')
  const imgName = formatGroupPhotoName('Class B', 'Class B', 'IMG_0001.JPG', '/shoot/IMG_0001.JPG')
  assert.notEqual(dscName, imgName)
})

test('does not collide when a frame counter is reused in a different source folder', () => {
  const firstSession = formatGroupPhotoName('Class B', 'Class B', 'DSC_0001.JPG', '/shoot-one/DSC_0001.JPG')
  const secondSession = formatGroupPhotoName('Class B', 'Class B', 'DSC_0001.JPG', '/shoot-two/DSC_0001.JPG')
  assert.notEqual(firstSession, secondSession)
})

test('bounds long multibyte class and group names below filesystem component limits', () => {
  const name = formatGroupPhotoName(
    `Classe ${'é'.repeat(100)}`,
    `Groupe ${'人'.repeat(100)}`,
    'DSC_0001.JPG',
    '/shoot/DSC_0001.JPG',
  )
  assert.ok(Buffer.byteLength(name) < 255)
})

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