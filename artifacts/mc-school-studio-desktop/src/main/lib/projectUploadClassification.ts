export type ProjectUploadFileRole = 'JPEG' | 'RAW'
export type ProjectUploadStatus = 'pending' | 'uploading' | 'done' | 'error' | null | undefined
export type ProjectUploadKind = 'personal' | 'legacy' | 'group'
export type ProjectUploadClassification = 'ready' | 'blocked' | 'excluded'

export interface ProjectUploadFileClassificationInput {
  kind: ProjectUploadKind
  associationResolved: boolean
  status: ProjectUploadStatus
  fileRole?: ProjectUploadFileRole
  galleryReady?: boolean
}

export function groupCaptureCompatibilityKey(groupId: number | string, captureKey: string): string {
  return `${String(groupId)}\u0000${captureKey}`
}

export function isGroupCaptureCompatibilityMirror(
  capture: { groupId: string | null; captureKey: string },
  groupCaptureKeys: ReadonlySet<string>,
): boolean {
  return capture.groupId !== null
    && groupCaptureKeys.has(groupCaptureCompatibilityKey(capture.groupId, capture.captureKey))
}

/**
 * Classify a durable local file before building upload jobs and progress
 * accounting. An association that points at another project is unresolved,
 * just like a null association. Completed unresolved files are intentionally
 * excluded because they cannot create another upload, while every other
 * unresolved file remains a blocker until the photographer fixes the match.
 */
export function classifyProjectUploadFile(
  input: ProjectUploadFileClassificationInput,
): ProjectUploadClassification {
  const groupComplete = input.kind === 'group'
    && input.status === 'done'
    && (input.fileRole !== 'JPEG' || input.galleryReady === true)
  if (!input.associationResolved) {
    return input.status === 'done' && (input.kind !== 'group' || groupComplete)
      ? 'excluded'
      : 'blocked'
  }
  if (input.kind === 'group' && groupComplete) return 'excluded'
  if (input.kind === 'group' && input.status === 'done') return 'ready'
  return input.status === 'done' ? 'excluded' : 'ready'
}