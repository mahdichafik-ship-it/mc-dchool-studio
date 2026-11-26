import type { CaptureReviewStatus } from '../../shared/types'

export interface ReviewStatusPortraitCapture {
  captureId: number
  studentId: number | null
  rating: number
  rejected: boolean
}

export interface ReviewStatusGroupCapture {
  captureId: number
  groupId: number
  rating: number
}

export interface ReviewStatusGroupMember {
  groupId: number
  studentId: number
}

export function buildCaptureReviewStatus(input: {
  portraitCaptures: ReviewStatusPortraitCapture[]
  portraitJpegCaptureIds: ReadonlySet<number>
  groupCaptures: ReviewStatusGroupCapture[]
  groupJpegCaptureIds: ReadonlySet<number>
  groupMembers: ReviewStatusGroupMember[]
}): CaptureReviewStatus {
  const reviewablePortraits = input.portraitCaptures
    .filter((capture) =>
      capture.studentId !== null
      && input.portraitJpegCaptureIds.has(capture.captureId)
    )
  const portraitStudentIds = new Set(reviewablePortraits.map((capture) => capture.studentId!))
  const ratedPortraitStudentIds = reviewablePortraits
    .filter((capture) =>
      capture.rating > 0
      && !capture.rejected,
    )
    .map((capture) => capture.studentId!)
  const fiveStarPortraitStudentIds = new Set(
    reviewablePortraits
      .filter((capture) => capture.rating === 5)
      .map((capture) => capture.studentId!),
  )

  const ratedGroupIds = input.groupCaptures
    .filter((capture) =>
      input.groupJpegCaptureIds.has(capture.captureId)
      && capture.rating > 0,
    )
    .map((capture) => capture.groupId)
  const fiveStarGroupIds = input.groupCaptures
    .filter((capture) =>
      input.groupJpegCaptureIds.has(capture.captureId)
      && capture.rating === 5,
    )
    .map((capture) => capture.groupId)

  const ratedGroupStudentIds = input.groupMembers
    .filter((member) => ratedGroupIds.includes(member.groupId))
    .map((member) => member.studentId)
  return {
    ratedPortraitStudentIds: [...new Set(ratedPortraitStudentIds)],
    ratedGroupStudentIds: [...new Set(ratedGroupStudentIds)],
    ratedGroupIds: [...new Set(ratedGroupIds)],
    fiveStarPortraitStudentIds: [...fiveStarPortraitStudentIds],
    studentsMissingFiveStarPortraitIds: [...portraitStudentIds]
      .filter((studentId) => !fiveStarPortraitStudentIds.has(studentId)),
    fiveStarGroupIds: [...new Set(fiveStarGroupIds)],
  }
}