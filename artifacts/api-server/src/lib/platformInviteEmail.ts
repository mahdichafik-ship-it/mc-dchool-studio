import { ReplitConnectors } from "@replit/connectors-sdk";

export type PlatformInviteEmail = {
  to: string;
  invitationUrl: string;
  expiresAt: Date;
};

const defaultFrom = "MC School Studio <onboarding@resend.dev>";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatExpiry(expiresAt: Date): string {
  return expiresAt.toLocaleDateString("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  });
}

export async function sendPlatformInviteEmail({
  to,
  invitationUrl,
  expiresAt,
}: PlatformInviteEmail): Promise<void> {
  const expiresOn = formatExpiry(expiresAt);
  const safeUrl = escapeHtml(invitationUrl);
  const safeExpiry = escapeHtml(expiresOn);
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy("resend", "/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL?.trim() || defaultFrom,
      to: [to],
      subject: "You’re invited to create your MC School Studio",
      html: [
        "<div style=\"font-family:Arial,sans-serif;line-height:1.5;color:#0f172a\">",
        "<h1 style=\"font-size:22px\">Create your MC School Studio</h1>",
        "<p>You’ve been invited to set up a studio owner account.</p>",
        `<p><a href="${safeUrl}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Start studio setup</a></p>`,
        `<p>This is a one-time link. It expires on <strong>${safeExpiry} UTC</strong>.</p>`,
        "<p>If you did not expect this invitation, you can ignore this email.</p>",
        "</div>",
      ].join(""),
      text: [
        "You’re invited to create your MC School Studio.",
        "",
        `Start studio setup: ${invitationUrl}`,
        "",
        `This is a one-time link. It expires on ${expiresOn} UTC.`,
        "If you did not expect this invitation, you can ignore this email.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    throw new Error(`Email provider returned HTTP ${response.status}`);
  }
}