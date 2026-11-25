const groupCaptureTransferTypes = [
  'application/x-volume-capture-group-capture',
  'application/x-volume-capture-group-captures',
]

const photoTransferType = 'application/x-volume-capture-photo'
const studentTransferType = 'application/x-volume-capture-student'

export function canDropOnStudent(transferTypes: readonly string[]): boolean {
  return transferTypes.includes('Files') || transferTypes.includes(photoTransferType)
}

export function canDropOnGroup(
  transferTypes: readonly string[],
  isClassPhotoTarget: boolean,
): boolean {
  if (groupCaptureTransferTypes.some((type) => transferTypes.includes(type))) {
    return isClassPhotoTarget
  }

  return transferTypes.includes('Files')
    || transferTypes.includes(photoTransferType)
    || transferTypes.includes(studentTransferType)
}
