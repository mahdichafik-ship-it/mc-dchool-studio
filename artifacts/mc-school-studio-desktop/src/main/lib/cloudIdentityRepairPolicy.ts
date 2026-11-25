export interface CloudIdentityRepairState {
  cloudId: number | null
  classSyncPending: boolean
}

/**
 * Reconcile only identities that are missing or have a local class change.
 * Clean cloud-backed roster rows do not need another full bundle lookup.
 */
export function requiresCloudIdentityRepair(
  student: CloudIdentityRepairState | null | undefined,
): boolean {
  return !student || student.cloudId === null || student.classSyncPending
}
