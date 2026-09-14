export interface RosterFilterStudent {
  firstName: string
  lastName: string
  generatedStudentId: string
}

export function filterRosterStudents<T extends RosterFilterStudent>(
  students: T[],
  search: string,
): T[] {
  if (!search) return students
  const query = search.toLowerCase()
  return students.filter((student) => (
    student.firstName.toLowerCase().includes(query)
    || student.lastName.toLowerCase().includes(query)
    || student.generatedStudentId.toLowerCase().includes(query)
  ))
}