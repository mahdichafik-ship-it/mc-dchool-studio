export function defaultGroupExclusionChanges(
  mode: "replace" | "add" | "remove",
  requestedStudentIds: number[],
  classStudentIds: number[],
): { exclude: number[]; clear: number[] } {
  const requested = new Set(requestedStudentIds);
  const classStudents = new Set(classStudentIds);

  if (mode === "add") {
    return {
      exclude: [],
      clear: [...requested].filter((id) => classStudents.has(id)),
    };
  }
  if (mode === "remove") {
    return {
      exclude: [...requested].filter((id) => classStudents.has(id)),
      clear: [],
    };
  }
  return {
    exclude: [...classStudents].filter((id) => !requested.has(id)),
    clear: [...requested].filter((id) => classStudents.has(id)),
  };
}