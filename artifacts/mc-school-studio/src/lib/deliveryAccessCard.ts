export type DeliveryAccessCardProjectType = "school" | "corporate";

export function deliveryAccessCardTerminology(projectType: DeliveryAccessCardProjectType) {
  return projectType === "corporate"
    ? { subjectLabel: "Employee", groupLabel: "Department" }
    : { subjectLabel: "Student", groupLabel: "Class" };
}

export function parseDeliveryAccessCode(href: string): string | null {
  const url = new URL(href, "http://localhost");
  const fragmentCode = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : "").get("code");
  return fragmentCode || url.searchParams.get("code");
}

export function printableDeliveryAccessUrl(host: string, accessUrl: string): string {
  const withoutCredentials = accessUrl.split(/[?#]/)[0];
  let galleryPath = withoutCredentials;
  let absoluteOrigin = "";
  try {
    const parsed = new URL(accessUrl);
    absoluteOrigin = parsed.origin;
    galleryPath = parsed.pathname;
  } catch {
    // Legacy relative card URLs are still accepted.
  }
  if (!galleryPath.startsWith("/delivery/") || galleryPath === "/delivery/") {
    throw new Error("A gallery-specific delivery URL is required");
  }
  return `${absoluteOrigin || host.replace(/\/+$/, "")}${galleryPath}`;
}