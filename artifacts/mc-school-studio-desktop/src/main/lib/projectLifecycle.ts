export interface ProjectRemoteSyncProof {
  syncStatus: string
  finishedAt: string | null
  syncCompletedFiles: number
  syncTotalFiles: number
  syncFailedFiles: number
}

export function hasVerifiedRemoteProjectCopy(project: ProjectRemoteSyncProof | null | undefined): boolean {
  return Boolean(
    project &&
    project.syncStatus === 'synced' &&
    project.finishedAt &&
    project.syncFailedFiles === 0 &&
    project.syncCompletedFiles === project.syncTotalFiles,
  )
}
