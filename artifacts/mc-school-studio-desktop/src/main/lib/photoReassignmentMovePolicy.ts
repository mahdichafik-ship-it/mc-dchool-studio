export interface PhotoReassignmentFileState {
  uploadStatus?: string | null
  fileUrl?: string | null
  galleryReady?: boolean
}

export function photoReassignmentMoveBlockReason(input: {
  projectFinished: boolean
  files: PhotoReassignmentFileState[]
}): string | null {
  if (input.projectFinished) {
    return 'This project is finished and its captures can no longer be changed.'
  }

  if (input.files.some((file) => file.uploadStatus === 'pending')) {
    return 'This photo or paired capture has a failed upload waiting for retry. Let it resolve before reassigning.'
  }

  if (input.files.some((file) =>
    file.uploadStatus === 'uploading'
    || file.uploadStatus === 'done'
    || Boolean(file.fileUrl)
    || file.galleryReady === true
  )) {
    return 'This photo or paired capture is uploading or already uploaded. Reassign it before uploading to the cloud.'
  }

  return null
}
