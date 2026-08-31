export interface CaptureFile {
  filePath: string
  fileName: string
  capturedAtMs: number
}

export interface SequenceState {
  activeStudentId: number | null
  manualStudentId: number | null
}

export type SequenceCapture =
  | { kind: 'marker'; studentId: number | null; reference: string }
  | { kind: 'portrait' }

export type SequenceDecision =
  | { kind: 'marker'; studentId: number }
  | { kind: 'matched'; studentId: number }
  | { kind: 'review'; reason: string }

export function createSequenceState(manualStudentId: number | null = null): SequenceState {
  return {
    activeStudentId: manualStudentId,
    manualStudentId,
  }
}

export function setManualStudent(state: SequenceState, studentId: number): void {
  state.manualStudentId = studentId
  state.activeStudentId = studentId
}

export function clearManualStudent(state: SequenceState): void {
  state.manualStudentId = null
  state.activeStudentId = null
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
    if (
      state.manualStudentId !== null
      && capture.studentId !== null
      && capture.studentId !== state.manualStudentId
    ) {
      return {
        kind: 'review',
        reason: `QR marker "${capture.reference}" conflicts with the selected student`,
      }
    }
    if (state.manualStudentId !== null && capture.studentId === null) {
      return {
        kind: 'review',
        reason: `QR marker "${capture.reference}" does not match the selected student`,
      }
    }
    if (state.manualStudentId !== null) {
      return { kind: 'marker', studentId: state.manualStudentId }
    }
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