import type { Student } from '../../../shared/types'

export interface EmployeeCaptureContextItem {
  label: 'Appointment time' | 'Job title' | 'Office / location' | 'Capture notes'
  value: string
  emphasized?: boolean
}

export function getEmployeeCaptureContext(
  student: Pick<Student, 'photoSession' | 'jobTitle' | 'officeLocation' | 'captureNotes'>,
  isCorporate: boolean,
): EmployeeCaptureContextItem[] {
  if (!isCorporate) return []

  const items: EmployeeCaptureContextItem[] = []
  if (student.photoSession) items.push({ label: 'Appointment time', value: student.photoSession })
  if (student.jobTitle) items.push({ label: 'Job title', value: student.jobTitle })
  if (student.officeLocation) items.push({ label: 'Office / location', value: student.officeLocation })
  if (student.captureNotes) {
    items.push({ label: 'Capture notes', value: student.captureNotes, emphasized: true })
  }
  return items
}