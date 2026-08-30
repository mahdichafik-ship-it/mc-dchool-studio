import { extname, parse } from 'node:path'

export type CaptureFileRole = 'JPEG' | 'RAW'
export type CapturePairingStatus = 'pending' | 'jpeg_only' | 'raw_only' | 'complete' | 'unpaired'

export interface CaptureAssignment {
  projectId: number
  studentId: number | null
  classId: number | null
  groupId?: string | null
  shootSessionId?: string | null
  cameraSerial?: string | null
}

export interface IncomingCaptureFile extends CaptureAssignment {
  filePath: string
  fileName: string
  capturedAt: string
  fileSize?: number | null
  checksum?: string | null
  role?: CaptureFileRole
}

export interface PairedCaptureFile {
  role: CaptureFileRole
  fileFormat: string
  filePath: string
  fileName: string
  capturedAt: string
  fileSize: number | null
  checksum: string | null
}

export interface PairedCapture {
  captureKey: string
  projectId: number
  studentId: number | null
  classId: number | null
  groupId: string | null
  baseFilename: string
  capturedAt: string
  shootSessionId: string | null
  cameraSerial: string | null
  assignmentLocked: boolean
  status: CapturePairingStatus
  files: PairedCaptureFile[]
}

export interface PairingResult {
  kind: 'created' | 'paired' | 'duplicate'
  capture: PairedCapture
}

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg'])
const RAW_EXTENSIONS = new Set(['.nef', '.nrw', '.cr2', '.cr3', '.arw', '.raf', '.orf', '.rw2', '.dng'])
const PAIR_TIMESTAMP_TOLERANCE_MS = 120_000

export function getCaptureFileRole(fileName: string): CaptureFileRole | null {
  const extension = extname(fileName).toLowerCase()
  if (JPEG_EXTENSIONS.has(extension)) return 'JPEG'
  if (RAW_EXTENSIONS.has(extension)) return 'RAW'
  return null
}

export function getCaptureFileFormat(fileName: string): string {
  return extname(fileName).replace(/^\./, '').toUpperCase() || 'UNKNOWN'
}

export function normalizeBaseFilename(fileName: string): string {
  return parse(fileName).name.trim().normalize('NFKC').toLocaleLowerCase()
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function statusFor(files: PairedCaptureFile[]): CapturePairingStatus {
  const hasJpeg = files.some((file) => file.role === 'JPEG')
  const hasRaw = files.some((file) => file.role === 'RAW')
  if (hasJpeg && hasRaw) return 'complete'
  if (hasJpeg) return 'jpeg_only'
  if (hasRaw) return 'raw_only'
  return 'pending'
}

function sameAssignmentScope(a: PairedCapture, b: IncomingCaptureFile): boolean {
  return a.projectId === b.projectId
    && (a.shootSessionId ?? null) === (b.shootSessionId ?? null)
    && (a.cameraSerial ?? null) === (b.cameraSerial ?? null)
    && a.baseFilename === normalizeBaseFilename(b.fileName)
}

/**
 * In-memory pairing domain service used by the database/watcher adapters.
 *
 * Assignment is copied from the first arriving file and never recalculated
 * from the current active subject when the second file arrives.
 */
export class CapturePairingEngine {
  private readonly captures: PairedCapture[] = []

  ingest(file: IncomingCaptureFile): PairingResult {
    const role = file.role ?? getCaptureFileRole(file.fileName)
    if (!role) throw new Error(`Unsupported capture file type: ${file.fileName}`)

    const baseFilename = normalizeBaseFilename(file.fileName)
    const existingDuplicate = this.captures.find((capture) =>
      sameAssignmentScope(capture, file)
      && capture.files.some((candidate) =>
        candidate.role === role
        && ((file.checksum && candidate.checksum === file.checksum) || candidate.filePath === file.filePath),
      ),
    )
    if (existingDuplicate) return { kind: 'duplicate', capture: existingDuplicate }

    const fileTime = timestampMs(file.capturedAt)
    const candidate = this.captures
      .filter((capture) =>
        sameAssignmentScope(capture, file)
        && !capture.files.some((candidateFile) => candidateFile.role === role)
        && (fileTime === 0 || timestampMs(capture.capturedAt) === 0
          || Math.abs(timestampMs(capture.capturedAt) - fileTime) <= PAIR_TIMESTAMP_TOLERANCE_MS),
      )
      .sort((a, b) => timestampMs(b.capturedAt) - timestampMs(a.capturedAt))[0]

    const pairedFile: PairedCaptureFile = {
      role,
      fileFormat: getCaptureFileFormat(file.fileName),
      filePath: file.filePath,
      fileName: file.fileName,
      capturedAt: file.capturedAt,
      fileSize: file.fileSize ?? null,
      checksum: file.checksum ?? null,
    }

    if (candidate) {
      candidate.files.push(pairedFile)
      candidate.status = statusFor(candidate.files)
      return { kind: 'paired', capture: candidate }
    }

    const capture: PairedCapture = {
      captureKey: [
        file.projectId,
        file.shootSessionId ?? 'default',
        file.cameraSerial ?? 'unknown',
        baseFilename,
        file.capturedAt,
      ].map((part) => encodeURIComponent(part)).join(':'),
      projectId: file.projectId,
      studentId: file.studentId,
      classId: file.classId,
      groupId: file.groupId ?? null,
      baseFilename,
      capturedAt: file.capturedAt,
      shootSessionId: file.shootSessionId ?? null,
      cameraSerial: file.cameraSerial ?? null,
      assignmentLocked: true,
      status: role === 'JPEG' ? 'jpeg_only' : 'raw_only',
      files: [pairedFile],
    }
    this.captures.push(capture)
    return { kind: 'created', capture }
  }

  list(): PairedCapture[] {
    return this.captures.map((capture) => ({
      ...capture,
      files: [...capture.files],
    }))
  }
}