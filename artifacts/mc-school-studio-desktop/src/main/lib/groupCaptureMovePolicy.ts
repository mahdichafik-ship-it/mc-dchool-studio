export interface GroupCaptureMoveFileState {
  uploadStatus?: string | null
  fileUrl?: string | null
  galleryReady?: boolean
}

export interface GroupCaptureBatchMoveItem {
  rating: number
  files: GroupCaptureMoveFileState[]
}

export function groupCaptureMoveBlockReason(input: {
  projectFinished: boolean
  sourceGroupId: number
  targetGroupId: number
  sourceIsClassGroup: boolean
  targetIsClassGroup: boolean
  sourceFiles: GroupCaptureMoveFileState[]
  sourceRating: number
  destinationFiveStarFiles: GroupCaptureMoveFileState[][]
}): string | null {
  if (input.projectFinished) {
    return 'This project is finished and its captures can no longer be changed.'
  }
  if (!input.sourceIsClassGroup || !input.targetIsClassGroup) {
    return 'Only class-group photos can be moved between classes.'
  }
  if (input.sourceGroupId === input.targetGroupId) {
    return 'This class photo is already assigned to that class.'
  }
  if (input.sourceFiles.length === 0 || input.sourceFiles.some(isLockedForMove)) {
    return 'This class photo has an active upload, a completed upload, or a failed attempt waiting for retry. Let it finish before moving it.'
  }
  if (
    input.sourceRating === 5
    && input.destinationFiveStarFiles.some((files) => files.some(isLockedForMove))
  ) {
    return 'The destination class already has a five-star photo with an upload in progress, already completed, or waiting for retry. Let it resolve before replacing it.'
  }
  return null
}

export function groupCaptureBatchMoveBlockReason(input: {
  projectFinished: boolean
  sourceGroupId: number
  targetGroupId: number
  sourceIsClassGroup: boolean
  targetIsClassGroup: boolean
  sourceCaptures: GroupCaptureBatchMoveItem[]
  destinationFiveStarFiles: GroupCaptureMoveFileState[][]
}): string | null {
  if (input.sourceCaptures.length === 0) {
    return 'Select at least one class photo to move.'
  }

  for (const capture of input.sourceCaptures) {
    const reason = groupCaptureMoveBlockReason({
      projectFinished: input.projectFinished,
      sourceGroupId: input.sourceGroupId,
      targetGroupId: input.targetGroupId,
      sourceIsClassGroup: input.sourceIsClassGroup,
      targetIsClassGroup: input.targetIsClassGroup,
      sourceFiles: capture.files,
      sourceRating: capture.rating,
      destinationFiveStarFiles: input.destinationFiveStarFiles,
    })
    if (reason) return reason
  }

  return null
}

function isLockedForMove(file: GroupCaptureMoveFileState): boolean {
  return file.uploadStatus === 'uploading'
    || file.uploadStatus === 'pending'
    || file.uploadStatus === 'done'
    || Boolean(file.fileUrl)
    || file.galleryReady === true
}
