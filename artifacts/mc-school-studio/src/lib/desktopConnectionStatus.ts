export const RETIREMENT_LIMITATION =
  'Retirement stops cloud access immediately and asks the desktop app to erase local project and photo data when it next reconnects. If a lost computer never reconnects, its local files cannot be erased remotely.'

type DesktopConnectionStatus = {
  status: 'active' | 'revoked' | 'retired'
  lastUsedAt: string | null
  retirementAcknowledgedAt: string | null
}

export function desktopConnectionStatus(connection: DesktopConnectionStatus): string {
  if (connection.status === 'active') {
    return connection.lastUsedAt
      ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}`
      : 'Not used yet'
  }
  if (connection.status === 'revoked') return 'Revoked'
  return connection.retirementAcknowledgedAt
    ? `Retirement acknowledged ${new Date(connection.retirementAcknowledgedAt).toLocaleString()}`
    : 'Retirement pending — waiting for this computer to reconnect'
}