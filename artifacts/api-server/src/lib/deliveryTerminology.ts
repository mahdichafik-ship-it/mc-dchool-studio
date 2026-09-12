export type DeliveryProjectType = "school" | "corporate";

export function normalizeDeliveryProjectType(value: unknown): DeliveryProjectType {
  return value === "corporate" ? "corporate" : "school";
}

export function deliveryTerminology(projectType: DeliveryProjectType) {
  return projectType === "corporate"
    ? { subjectLabel: "Employee", groupLabel: "Department" }
    : { subjectLabel: "Student", groupLabel: "Class" };
}