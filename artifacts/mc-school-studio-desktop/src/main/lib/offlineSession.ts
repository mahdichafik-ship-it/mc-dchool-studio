export type CachedDesktopMember = {
  email: string
  role: 'owner' | 'admin' | 'assistant' | 'photographer'
}

export function parseCachedDesktopMember(value: string | null): CachedDesktopMember | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as Partial<CachedDesktopMember>
    if (
      typeof parsed.email !== 'string'
      || !['owner', 'admin', 'assistant', 'photographer'].includes(parsed.role ?? '')
    ) {
      return null
    }
    return { email: parsed.email, role: parsed.role as CachedDesktopMember['role'] }
  } catch {
    return null
  }
}

export function getOfflineDesktopSession(options: {
  hasConnectionToken: boolean
  isRetired: boolean
  cachedMember: CachedDesktopMember | null
}): { signedIn: true; member: CachedDesktopMember; offline: true } | null {
  if (!options.hasConnectionToken || options.isRetired || !options.cachedMember) return null
  return {
    signedIn: true,
    member: options.cachedMember,
    offline: true,
  }
}