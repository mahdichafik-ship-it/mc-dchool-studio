export function publicAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PUBLIC_APP_URL?.trim();
  const isProduction = env.NODE_ENV === "production";
  const raw = configured || (
    !isProduction && env.REPLIT_DEV_DOMAIN?.trim()
      ? `https://${env.REPLIT_DEV_DOMAIN.trim().replace(/^https?:\/\//i, "")}`
      : !isProduction && env.NODE_ENV === "test"
        ? "http://localhost:3000"
        : ""
  );
  if (!raw) {
    throw new Error("PUBLIC_APP_URL must be configured with a valid HTTPS URL in production");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PUBLIC_APP_URL must be a valid absolute URL");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_APP_URL must be an absolute URL without credentials, query, or fragment");
  }
  if (isProduction && parsed.protocol !== "https:") {
    throw new Error("PUBLIC_APP_URL must use HTTPS in production");
  }
  if (!isProduction && !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("PUBLIC_APP_URL must use HTTP or HTTPS outside production");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}