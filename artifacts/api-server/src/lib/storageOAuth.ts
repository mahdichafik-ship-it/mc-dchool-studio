import { createHash, randomBytes } from "node:crypto";

export type ExternalStorageProvider = "google_drive" | "dropbox";

export type OAuthCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
};

export type ProviderIdentity = {
  id: string;
  email: string;
};

type ProviderConfig = {
  clientId: string;
  clientSecret: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function config(provider: ExternalStorageProvider): ProviderConfig {
  return provider === "google_drive"
    ? {
      clientId: required("GOOGLE_STORAGE_OAUTH_CLIENT_ID"),
      clientSecret: required("GOOGLE_STORAGE_OAUTH_CLIENT_SECRET"),
    }
    : {
      clientId: required("DROPBOX_STORAGE_OAUTH_APP_KEY"),
      clientSecret: required("DROPBOX_STORAGE_OAUTH_APP_SECRET"),
    };
}

export function createPkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function authorizationUrl(
  provider: ExternalStorageProvider,
  state: string,
  challenge: string,
  redirectUri: string,
): string {
  const { clientId } = config(provider);
  if (provider === "google_drive") {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      scope: "openid email https://www.googleapis.com/auth/drive.file",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`;
  }
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    token_access_type: "offline",
    scope: "account_info.read files.content.read files.content.write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://www.dropbox.com/oauth2/authorize?${query.toString()}`;
}

async function tokenRequest(provider: ExternalStorageProvider, body: URLSearchParams) {
  const { clientId, clientSecret } = config(provider);
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  const endpoint = provider === "google_drive"
    ? "https://oauth2.googleapis.com/token"
    : "https://api.dropboxapi.com/oauth2/token";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${provider} token exchange failed`);
  return payload;
}

export async function exchangeAuthorizationCode(
  provider: ExternalStorageProvider,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthCredentials> {
  const payload = await tokenRequest(provider, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  }));
  const accessToken = String(payload.access_token ?? "");
  const refreshToken = String(payload.refresh_token ?? "");
  if (!accessToken || !refreshToken) throw new Error(`${provider} did not return durable authorization`);
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : undefined,
  };
}

export async function refreshAccessToken(
  provider: ExternalStorageProvider,
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const payload = await tokenRequest(provider, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  }));
  const accessToken = String(payload.access_token ?? "");
  if (!accessToken) throw new Error(`${provider} did not refresh the access token`);
  return {
    ...credentials,
    accessToken,
    expiresAt: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
    scope: typeof payload.scope === "string" ? payload.scope : credentials.scope,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : credentials.tokenType,
  };
}

export async function providerIdentity(
  provider: ExternalStorageProvider,
  accessToken: string,
): Promise<ProviderIdentity> {
  const response = await fetch(
    provider === "google_drive"
      ? "https://openidconnect.googleapis.com/v1/userinfo"
      : "https://api.dropboxapi.com/2/users/get_current_account",
    {
      method: provider === "google_drive" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  const payload = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`${provider} account verification failed`);
  const id = provider === "google_drive" ? String(payload.sub ?? "") : String(payload.account_id ?? "");
  const email = String(payload.email ?? "");
  if (!id || !email) throw new Error(`${provider} did not return an account identity`);
  return { id, email };
}