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

function resendApiBaseUrl(): string {
  if (process.env.NODE_ENV === "test" && process.env.RESEND_API_BASE_URL) {
    return process.env.RESEND_API_BASE_URL.replace(/\/+$/, "");
  }
  return "https://api.resend.com";
}

export function resendConfiguration() {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = process.env.RESEND_FROM_EMAIL?.trim() ?? "";
  return {
    configured: Boolean(apiKey && from),
    apiKey,
    from,
    replyTo: process.env.RESEND_REPLY_TO?.trim() || undefined,
  };
}

export async function sendResendEmails(
  messages: Omit<ResendEmail, "from" | "reply_to">[],
): Promise<number> {
  const config = resendConfiguration();
  if (!config.apiKey) throw new Error("RESEND_API_KEY is not configured");
  if (!config.from) throw new Error("RESEND_FROM_EMAIL is not configured");

  let sent = 0;
  for (let index = 0; index < messages.length; index += RESEND_BATCH_SIZE) {
    const batch = messages.slice(index, index + RESEND_BATCH_SIZE).map((message) => ({
      ...message,
      from: config.from,
      ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    }));
    const response = await fetch(`${resendApiBaseUrl()}/emails/batch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Resend rejected the batch (${response.status}): ${detail || response.statusText}`);
    }
    sent += batch.length;
  }
  return sent;
}