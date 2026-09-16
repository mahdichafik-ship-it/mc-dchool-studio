export interface CaptureFile {
  filePath: string
  fileName: string
  capturedAtMs: number
  /**
   * JPEG bytes captured after the source passed file-stability checks. Image
   * decoders and preview generation must use this snapshot, never filePath.
   */
  sourceBuffer?: Buffer
  diagnosticId?: string
  /**
   * Monotonic filesystem-event order within a watcher session. Captures in a
   * burst must be processed in this order so a marker that arrived before a
   * portrait can govern it, while a later marker cannot claim an older file.
   */
  arrivalOrder?: number
  /**
   * The effective student target at the moment the watcher saw the file,
   * whether it came from manual selection or a QR sequence.
   * `undefined` is kept for callers that do not participate in the watcher
   * queue; `null` means there was no active target.
   */
  selectedStudentId?: number | null
  /**
   * Identity authority observed when the filesystem event was received. This
   * must travel with the queued file because QR/RAW processing can be delayed
   * until after the photographer changes the active target.
   */
  assignmentSource?: CaptureAssignmentSource
  selectedGroupId?: number | null
  /**
   * Set only for explicit renderer drops. Ordinary watcher captures retain
   * legacy basename/timestamp pairing unless this is true.
   */
  strictStudentOwnership?: boolean
}

export type CaptureAssignmentSource = 'manual' | 'qr' | 'none'

type OrderedCaptureSlot<T> =
  | { kind: 'pending' }
  | { kind: 'ready'; value: T }
  | { kind: 'failed' }

/**
 * Keeps independently stabilizing filesystem events in arrival order. A
 * later file may become ready first, but it cannot be drained until every
 * earlier slot is ready or explicitly failed.
 */
export class OrderedCaptureQueue<T> {
  private readonly slots = new Map<number, OrderedCaptureSlot<T>>()
  private nextOrder = 0
  private activeDrain: Promise<void> | null = null

  register(order: number): void {
    this.slots.set(order, { kind: 'pending' })
  }

  ready(order: number, value: T): void {
    if (!this.slots.has(order)) return
    this.slots.set(order, { kind: 'ready', value })
  }

  fail(order: number): void {
    if (!this.slots.has(order)) return
    this.slots.set(order, { kind: 'failed' })
  }

  async drain(process: (value: T) => Promise<void>): Promise<void> {
    if (this.activeDrain) return this.activeDrain
    const run = async () => {
      while (true) {
        const slot = this.slots.get(this.nextOrder)
        if (!slot || slot.kind === 'pending') return
        this.slots.delete(this.nextOrder)
        this.nextOrder++
        if (slot.kind === 'ready') {
          try {
            await process(slot.value)
          } catch {
            // Processing failures must not deadlock every later filesystem
            // event behind one unavailable or malformed capture.
          }
        }
      }
    }
    const drainPromise = run()
    this.activeDrain = drainPromise
    try {
      await drainPromise
    } finally {
      if (this.activeDrain === drainPromise) this.activeDrain = null
    }
  }
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

/**
 * Snapshot the active identity at filesystem-event time. Do not derive this
 * from SequenceState again after waiting for file stability: that would let a
 * later roster click reassign an already-captured file.
 */
export function snapshotCaptureTarget(
  state: SequenceState,
  authoritativeManualStudentId?: number,
): {
  studentId: number | null
  source: CaptureAssignmentSource
} {
  if (authoritativeManualStudentId !== undefined) {
    return { studentId: authoritativeManualStudentId, source: 'manual' }
  }
  if (state.manualStudentId !== null) {
    return { studentId: state.manualStudentId, source: 'manual' }
  }
  if (state.activeStudentId !== null) {
    return { studentId: state.activeStudentId, source: 'qr' }
  }
  return { studentId: null, source: 'none' }
}

export function registerCapturePath(seenPaths: Set<string>, filePath: string): boolean {
  if (seenPaths.has(filePath)) return false
  seenPaths.add(filePath)
  return true
}

export function sortCaptureFiles(files: CaptureFile[]): CaptureFile[] {
  return [...files].sort((a, b) => {
    if (a.arrivalOrder !== undefined && b.arrivalOrder !== undefined) {
      const arrivalDifference = a.arrivalOrder - b.arrivalOrder
      if (arrivalDifference !== 0) return arrivalDifference
    }
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

/**
 * Resolve a portrait that had no identity when its filesystem event arrived.
 * A QR marker processed earlier in the same ordered burst may establish the
 * target; a later manual selection or later QR marker must not retroactively
 * claim the portrait.
 */
export function resolveQueuedPortraitTarget(
  state: SequenceState,
  capturedStudentId: number | null,
  assignmentSource: CaptureAssignmentSource,
): number | null {
  if (assignmentSource !== 'none') return capturedStudentId
  if (state.manualStudentId !== null) return null
  return state.activeStudentId
}

export function advanceSequence(
  state: SequenceState,
  capture: SequenceCapture,
): SequenceDecision {
  if (capture.kind === 'marker') {
    if (state.manualStudentId !== null && capture.studentId === null) {
      return {
        kind: 'review',
        reason: `QR marker "${capture.reference}" was not accepted while a student is manually selected`,
      }
    }
    if (state.manualStudentId !== null) {
      // Manual authority is sticky. Even a valid QR is only a warning/review
      // signal until the photographer clears or changes the roster target.
      return {
        kind: 'review',
        reason: capture.studentId === state.manualStudentId
          ? `QR marker "${capture.reference}" was ignored because the selected student is manual`
          : `QR marker "${capture.reference}" does not match the selected student`,
      }
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