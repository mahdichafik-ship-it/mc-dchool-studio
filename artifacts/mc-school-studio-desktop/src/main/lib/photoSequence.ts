export interface CaptureFile {
  filePath: string
  fileName: string
  capturedAtMs: number
}

export interface SequenceState {
  activeStudentId: number | null
}

export type SequenceCapture =
  | { kind: 'marker'; studentId: number | null; reference: string }
  | { kind: 'portrait' }

export type SequenceDecision =
  | { kind: 'marker'; studentId: number }
  | { kind: 'matched'; studentId: number }
  | { kind: 'review'; reason: string }

export function createSequenceState(): SequenceState {
  return { activeStudentId: null }
}

export function registerCapturePath(seenPaths: Set<string>, filePath: string): boolean {
  if (seenPaths.has(filePath)) return false
  seenPaths.add(filePath)
  return true
}

export function sortCaptureFiles(files: CaptureFile[]): CaptureFile[] {
  return [...files].sort((a, b) => {
    const timestampDifference = a.capturedAtMs - b.capturedAtMs
    if (timestampDifference !== 0) return timestampDifference

    const fileNameDifference = a.fileName.localeCompare(b.fileName, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
    if (fileNameDifference !== 0) return fileNameDifference
    return a.filePath.localeCompare(b.filePath, undefined, { sensitivity: 'base' })
  })
}

export function advanceSequence(
  state: SequenceState,
  capture: SequenceCapture,
): SequenceDecision {
  if (capture.kind === 'marker') {
    state.activeStudentId = capture.studentId
    if (capture.studentId === null) {
      return {
        kind: 'review',
        reason: `QR marker "${capture.reference}" does not match a student in this project`,
      }
    }
    return { kind: 'marker', studentId: capture.studentId }
  }

  if (state.activeStudentId === null) {
    return {
      kind: 'review',
      reason: 'Portrait was captured before a valid student QR marker',
    }
  }

  return { kind: 'matched', studentId: state.activeStudentId }
}