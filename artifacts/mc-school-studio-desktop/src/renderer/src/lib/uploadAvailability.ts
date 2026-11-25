export interface UploadAvailabilityInput {
  actionRunning: boolean
  cloudReady: boolean
  projectFinished: boolean
}

/**
 * Photo review controls gallery visibility, not whether matched files can be
 * backed up. Keep manual upload gated only by operational prerequisites.
 */
export function canStartUploadNow(input: UploadAvailabilityInput): boolean {
  return !input.actionRunning && input.cloudReady && !input.projectFinished
}
