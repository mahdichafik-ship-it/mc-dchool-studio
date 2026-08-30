import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  RETIREMENT_LIMITATION,
  desktopConnectionStatus,
} from '../../mc-school-studio/src/lib/desktopConnectionStatus.ts'

test('Team explains the never-reconnect limitation', () => {
  assert.match(RETIREMENT_LIMITATION, /never reconnects/)
  assert.match(RETIREMENT_LIMITATION, /cannot be erased remotely/)
})

test('Team distinguishes pending and acknowledged retirement', () => {
  assert.equal(
    desktopConnectionStatus({
      status: 'retired',
      lastUsedAt: null,
      retirementAcknowledgedAt: null,
    }),
    'Retirement pending — waiting for this computer to reconnect',
  )
  assert.match(
    desktopConnectionStatus({
      status: 'retired',
      lastUsedAt: null,
      retirementAcknowledgedAt: '2026-08-29T12:00:00.000Z',
    }),
    /^Retirement acknowledged /,
  )
})