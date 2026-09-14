export type DeliveryAccessCardProjectType = "school" | "corporate";

export function deliveryAccessCardTerminology(projectType: DeliveryAccessCardProjectType) {
  return projectType === "corporate"
    ? { subjectLabel: "Employee", groupLabel: "Department" }
    : { subjectLabel: "Student", groupLabel: "Class" };
}

export function printableDeliveryAccessUrl(host: string, accessUrl: string): string {
  const galleryPath = accessUrl.split("?")[0];
  if (!galleryPath.startsWith("/delivery/") || galleryPath === "/delivery/") {
    throw new Error("A gallery-specific delivery URL is required");
  }
  return `${host.replace(/\/+$/, "")}${galleryPath}`;
}