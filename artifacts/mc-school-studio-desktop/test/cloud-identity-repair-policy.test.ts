import assert from 'node:assert/strict'
import test from 'node:test'
import { requiresCloudIdentityRepair } from '../src/main/lib/cloudIdentityRepairPolicy.ts'

test('skips clean student identities already linked to the cloud', () => {
  assert.equal(requiresCloudIdentityRepair({
    cloudId: 42,
    classSyncPending: false,
  }), false)
})

test('repairs identities that are missing or have a pending class change', () => {
  assert.equal(requiresCloudIdentityRepair(null), true)
  assert.equal(requiresCloudIdentityRepair({
    cloudId: null,
    classSyncPending: false,
  }), true)
  assert.equal(requiresCloudIdentityRepair({
    cloudId: 42,
    classSyncPending: true,
  }), true)
})
