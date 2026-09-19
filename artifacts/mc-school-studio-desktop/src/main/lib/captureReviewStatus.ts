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
  const ratedPortraitStudentIds = input.portraitCaptures
    .filter((capture) =>
      capture.studentId !== null
      && input.portraitJpegCaptureIds.has(capture.captureId)
      && capture.rating > 0
      && !capture.rejected,
    )
    .map((capture) => capture.studentId!)

  const ratedGroupIds = input.groupCaptures
    .filter((capture) =>
      input.groupJpegCaptureIds.has(capture.captureId)
      && capture.rating > 0,
    )
    .map((capture) => capture.groupId)

  const ratedGroupStudentIds = input.groupMembers
    .filter((member) => ratedGroupIds.includes(member.groupId))
    .map((member) => member.studentId)

  return {
    ratedPortraitStudentIds: [...new Set(ratedPortraitStudentIds)],
    ratedGroupStudentIds: [...new Set(ratedGroupStudentIds)],
    ratedGroupIds: [...new Set(ratedGroupIds)],
  }
}