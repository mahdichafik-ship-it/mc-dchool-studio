const RESEND_BATCH_SIZE = 100;

type ResendEmail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  reply_to?: string;
};

export class ResendSendError extends Error {
  constructor(
    public readonly outcome: "rejected" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "ResendSendError";
  }
}

function resendApiBaseUrl(): string {
  if (process.env.NODE_ENV === "test" && process.env.RESEND_API_BASE_URL) {
    return process.env.RESEND_API_BASE_URL.replace(/\/+$/, "");
  }
  return "https://api.resend.com";
}

function isAllowedTestApiOverride(): boolean {
  if (process.env.NODE_ENV !== "test" || !process.env.RESEND_API_BASE_URL) return false;
  try {
    const url = new URL(process.env.RESEND_API_BASE_URL);
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === "http:" || url.protocol === "https:")
      && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]");
  } catch {
    return false;
  }
}

export function resendConfiguration() {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = process.env.RESEND_FROM_EMAIL?.trim() ?? "";
  const publicAppUrl = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "") ?? "";
  return {
    configured: Boolean(apiKey && from && /^https?:\/\//.test(publicAppUrl)),
    apiKey,
    from,
    publicAppUrl,
    replyTo: process.env.RESEND_REPLY_TO?.trim() || undefined,
  };
}

export function resendConfigurationStatus() {
  const config = resendConfiguration();
  const senderAddress = config.from.match(/<([^>]+)>/)?.[1] ?? config.from;
  const senderValid = /^[^@\s]+@[^@\s]+$/.test(senderAddress)
    && !senderAddress.toLowerCase().endsWith("@resend.dev");
  const appUrlValid = process.env.NODE_ENV === "production"
    ? /^https:\/\//.test(config.publicAppUrl)
    : /^https?:\/\//.test(config.publicAppUrl);
  const testOverrideAllowed = isAllowedTestApiOverride();
  const canDispatch = process.env.NODE_ENV === "production"
    ? Boolean(config.apiKey && senderValid && appUrlValid)
    : testOverrideAllowed && Boolean(config.apiKey && senderValid && appUrlValid);
  return {
    configured: Boolean(config.apiKey && senderValid && appUrlValid),
    canDispatch,
    environment: process.env.NODE_ENV ?? "development",
    reason: canDispatch
      ? null
      : process.env.NODE_ENV !== "production" && !testOverrideAllowed
        ? "Email dispatch is disabled outside production (except the test API override)"
        : !config.apiKey
          ? "RESEND_API_KEY is not configured"
          : !senderValid
            ? "RESEND_FROM_EMAIL must be a verified custom sender (onboarding@resend.dev is not allowed)"
            : !appUrlValid
              ? "PUBLIC_APP_URL must be an absolute HTTPS URL in production"
              : "Email provider configuration is incomplete",
    fromEmail: config.from || null,
    publicAppUrl: config.publicAppUrl || null,
  };
}

export async function sendResendEmailBatch(
  messages: Omit<ResendEmail, "from" | "reply_to">[],
  idempotencyKey: string,
): Promise<string[]> {
  const status = resendConfigurationStatus();
  if (!status.canDispatch) throw new Error(status.reason ?? "Resend dispatch is disabled");
  const config = resendConfiguration();
  if (messages.length < 1 || messages.length > RESEND_BATCH_SIZE) {
    throw new Error(`Resend batches must contain 1-${RESEND_BATCH_SIZE} messages`);
  }

  const batch = messages.map((message) => ({
    ...message,
    from: config.from,
    ...(config.replyTo ? { reply_to: config.replyTo } : {}),
  }));
  let response: Response;
  try {
    response = await fetch(`${resendApiBaseUrl()}/emails/batch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    throw new ResendSendError("unknown", `Resend delivery outcome is unknown: ${detail}`);
  }
  if (!response.ok) {
    await response.text();
    const outcome = response.status >= 400 && response.status < 500 ? "rejected" : "unknown";
    throw new ResendSendError(outcome, `Resend rejected the batch (${response.status})`);
  }
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  const ids = payload.data?.map((item) => typeof item.id === "string" ? item.id : "") ?? [];
  if (ids.length !== batch.length || ids.some((id) => !id)) {
    throw new ResendSendError("unknown", "Resend returned an incomplete batch result");
  }
  return ids;
}