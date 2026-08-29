import { strict as assert } from 'node:assert'
import test from 'node:test'
import { getOfflineDesktopSession, parseCachedDesktopMember } from '../src/main/lib/offlineSession.ts'

test('accepts a valid cached desktop member for offline startup', () => {
  const member = parseCachedDesktopMember(JSON.stringify({
    email: 'photographer@example.com',
    role: 'photographer',
  }))

  assert.deepEqual(
    getOfflineDesktopSession({
      hasConnectionToken: true,
      isRetired: false,
      cachedMember: member,
    }),
    {
      signedIn: true,
      member,
      offline: true,
    },
  )
})

test('does not allow offline startup without a cached identity or after retirement', () => {
  assert.equal(parseCachedDesktopMember('{bad json'), null)
  assert.equal(parseCachedDesktopMember(JSON.stringify({ email: 'viewer@example.com', role: 'viewer' })), null)
  assert.equal(
    getOfflineDesktopSession({
      hasConnectionToken: true,
      isRetired: true,
      cachedMember: { email: 'photographer@example.com', role: 'photographer' },
    }),
    null,
  )
  assert.equal(
    getOfflineDesktopSession({
      hasConnectionToken: false,
      isRetired: false,
      cachedMember: { email: 'photographer@example.com', role: 'photographer' },
    }),
    null,
  )
})