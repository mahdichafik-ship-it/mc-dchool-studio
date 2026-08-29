import { ipcMain, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { DEFAULT_API_URL, deleteSetting, getSetting, getUploadConfig, saveConnectionToken, setSetting } from './upload'

type AuthMember = { email: string; role: 'owner' | 'admin' | 'assistant' | 'photographer' }
type AuthSession = { signedIn: boolean; member?: AuthMember; error?: string }

async function postJson(url: string, body: Record<string, unknown>, timeoutMs: number) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  return { response, payload }
}

async function fetchCurrentSession(): Promise<AuthSession> {
  const { apiUrl, connectionToken } = getUploadConfig()
  if (!connectionToken) return { signedIn: false }
  try {
    const response = await fetch(`${apiUrl}/api/desktop/me`, {
      headers: { Authorization: `Bearer ${connectionToken}` },
      signal: AbortSignal.timeout(5000),
    })
    const payload = await response.json().catch(() => ({})) as { member?: AuthMember; error?: string }
    if (response.ok && payload.member) return { signedIn: true, member: payload.member }
    if (response.status === 401) {
      return { signedIn: false, error: 'Your desktop session was signed out or revoked. Sign in again.' }
    }
    return { signedIn: false, error: payload.error ?? `Could not reach MC School Studio (${response.status})` }
  } catch {
    return { signedIn: false, error: 'Could not reach MC School Studio. Check your internet connection.' }
  }
}

export function registerAuthHandlers() {
  ipcMain.handle('auth:getSession', fetchCurrentSession)

  ipcMain.handle('auth:refresh', async (): Promise<AuthSession> => {
    const { apiUrl, connectionToken } = getUploadConfig()
    if (!connectionToken) return { signedIn: false, error: 'Sign in to MC School Studio first.' }
    try {
      const response = await fetch(`${apiUrl}/api/desktop/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${connectionToken}` },
        signal: AbortSignal.timeout(5000),
      })
      const payload = await response.json().catch(() => ({})) as { token?: string; member?: AuthMember; error?: string }
      if (!response.ok || !payload.token || !payload.member) {
        return { signedIn: false, error: payload.error ?? 'Your desktop session could not be refreshed.' }
      }
      saveConnectionToken(payload.token)
      return { signedIn: true, member: payload.member }
    } catch {
      return { signedIn: false, error: 'Could not refresh the desktop session.' }
    }
  })

  ipcMain.handle('auth:signOut', () => {
    deleteSetting('desktop_connection_token')
    return { ok: true }
  })

  ipcMain.handle('auth:signIn', async (): Promise<AuthSession> => {
    const apiUrl = (getSetting('upload_api_url') ?? DEFAULT_API_URL).replace(/\/+$/, '')
    const clientSecret = randomBytes(32).toString('base64url')

    try {
      const started = await postJson(`${apiUrl}/api/desktop/auth/start`, { clientSecret }, 10000)
      if (!started.response.ok || typeof started.payload.code !== 'string') {
        return {
          signedIn: false,
          error: typeof started.payload.error === 'string'
            ? started.payload.error
            : 'Could not start browser sign-in. Make sure the desktop release is up to date.',
        }
      }

      const code = started.payload.code
      const connectUrl = `${apiUrl}/desktop/connect?code=${encodeURIComponent(code)}`
      await shell.openExternal(connectUrl)

      const deadline = Date.now() + 10 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const status = await postJson(`${apiUrl}/api/desktop/auth/status`, { code, clientSecret }, 10000)
        if (!status.response.ok) {
          return { signedIn: false, error: 'The desktop sign-in request could not be verified. Start again.' }
        }
        if (status.payload.status === 'expired') {
          return { signedIn: false, error: 'The browser sign-in request expired. Click Sign in to try again.' }
        }
        if (status.payload.status !== 'approved') continue

        const exchanged = await postJson(`${apiUrl}/api/desktop/auth/exchange`, { code, clientSecret }, 10000)
        if (!exchanged.response.ok || typeof exchanged.payload.token !== 'string') {
          return {
            signedIn: false,
            error: typeof exchanged.payload.error === 'string'
              ? exchanged.payload.error
              : 'The browser sign-in could not be completed. Start again.',
          }
        }
        const member = exchanged.payload.member as AuthMember
        setSetting('upload_api_url', apiUrl)
        saveConnectionToken(exchanged.payload.token)
        return { signedIn: true, member }
      }
      return { signedIn: false, error: 'Sign-in timed out. Click Sign in to try again.' }
    } catch {
      return {
        signedIn: false,
        error: 'Could not connect to MC School Studio. Check your internet connection and try again.',
      }
    }
  })
}