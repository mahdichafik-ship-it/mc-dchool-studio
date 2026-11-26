export interface UploadAvailabilityInput {
  actionRunning: boolean
  cloudReady: boolean
  projectFinished: boolean
  missingFavoritePortraitCount: number
}

/**
 * Upload requires operational readiness and one selected five-star portrait
 * for every photographed individual.
 */
export function canStartUploadNow(input: UploadAvailabilityInput): boolean {
  return !input.actionRunning
    && input.cloudReady
    && !input.projectFinished
    && input.missingFavoritePortraitCount === 0
}
