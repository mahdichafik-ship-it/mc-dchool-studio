import assert from 'node:assert/strict'
import test from 'node:test'
import { generateStudentQrCodes } from '../src/main/lib/studentQr.ts'

test('generates saved simple and structured QR images for a single employee', async () => {
  const qr = await generateStudentQrCodes({
    projectName: 'Watéc',
    className: 'Unassigned',
    firstName: 'Noor',
    lastName: 'Amine',
    studentId: '4AVAX9T',
  })

  assert.match(qr.simpleQr, /^data:image\/png;base64,/)
  assert.match(qr.jsonQr, /^data:image\/png;base64,/)
  assert.ok(Buffer.from(qr.simpleQr.split(',')[1], 'base64').length > 100)
  assert.ok(Buffer.from(qr.jsonQr.split(',')[1], 'base64').length > 100)
})
