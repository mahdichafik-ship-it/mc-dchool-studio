import React, { useState, useEffect } from 'react'
import { FolderOpen, UserCircle, Info, Loader, AlertTriangle, RefreshCw, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGlobalErrorCount } from '@/hooks/useApi'

type UpdateStatus =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

interface UpdateState {
  status: UpdateStatus
  version?: string
  percent?: number
  message?: string
}

interface SettingsProps {
  member?: { email: string; role: string }
  onSignedOut: () => void
}

export function Settings({ member, onSignedOut }: SettingsProps) {
  const [photosDir, setPhotosDir] = useState<string>('')
  const [spoolDir, setSpoolDir] = useState<string>('')
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'unsupported' })
  const { count: globalErrorCount } = useGlobalErrorCount()

  useEffect(() => {
    window.api.invoke('app:getPhotosDir').then(setPhotosDir)
    window.api.invoke('app:getSpoolDir').then(setSpoolDir)

    window.api.invoke('update:getState').then(setUpdateState)
    return window.api.on('update:status', setUpdateState)
  }, [])

  async function handleOpenPhotosDir() {
    if (photosDir) {
      await window.api.invoke('app:openFile', { filePath: photosDir })
    }
  }

  async function handleChoosePhotosDir() {
    const selected = await window.api.invoke('dialog:openFolder') as string | null
    if (!selected) return
    const saved = await window.api.invoke('app:setPhotosDir', { dir: selected }) as string
    setPhotosDir(saved)
  }

  async function handleOpenSpoolDir() {
    if (spoolDir) {
      await window.api.invoke('app:openFile', { filePath: spoolDir })
    }
  }

  async function handleSignOut() {
    await window.api.invoke('auth:signOut')
    onSignedOut()
  }

  async function handleCheckForUpdates() {
    setUpdateState({ status: 'checking' })
    const result = await window.api.invoke('update:check')
    setUpdateState(result)
  }

  async function handleInstallUpdate() {
    const result = await window.api.invoke('update:install')
    setUpdateState(result)
  }

  function updateStatusMessage() {
    switch (updateState.status) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return updateState.version
          ? `Version ${updateState.version} is available.`
          : 'An update is available.'
      case 'downloading':
        return `Downloading update${updateState.percent !== undefined ? ` (${Math.round(updateState.percent)}%)` : '…'}`
      case 'downloaded':
        return 'Update downloaded. Restart when ready to install it.'
      case 'not-available':
        return 'You’re up to date.'
      case 'error':
        return 'Could not check for updates. Try again later.'
      default:
        return 'Updates are checked from an installed release.'
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white border-b border-slate-200 px-8 py-5">
        <h1 className="text-xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">Application preferences</p>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="max-w-lg space-y-6">

          {/* Photo folders */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <FolderOpen className="size-5 text-teal-600" />
              <h3 className="font-semibold text-slate-900">Photo folders</h3>
            </div>
            <p className="text-sm text-slate-500 mb-3">
              Matched photos are copied to PHOTOS and organised by project, class, and student. Smart Shooter’s original files are never moved.
            </p>
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Managed photos</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 truncate">
                    {photosDir || 'Loading…'}
                  </code>
                  <button
                    onClick={handleOpenPhotosDir}
                    className="shrink-0 text-sm text-teal-600 hover:text-teal-700 font-medium"
                  >
                    Open
                  </button>
                  <button onClick={handleChoosePhotosDir} className="shrink-0 text-sm text-slate-600 hover:text-slate-900 font-medium">
                    Change
                  </button>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">Smart Shooter spool</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 truncate">
                    {spoolDir || 'Loading…'}
                  </code>
                  <button
                    onClick={handleOpenSpoolDir}
                    className="shrink-0 text-sm text-teal-600 hover:text-teal-700 font-medium"
                  >
                    Open
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  JPEG and RAW output folders are created inside this Spool folder.
                </p>
              </div>
            </div>
          </div>

          {/* Failed uploads summary */}
          {globalErrorCount > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
              <AlertTriangle className="size-5 text-red-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-red-800">
                  {globalErrorCount} failed upload{globalErrorCount !== 1 ? 's' : ''}
                </p>
                <p className="text-xs text-red-600 mt-0.5">
                  Open the affected project and click "Retry failed uploads" to retry.
                </p>
              </div>
            </div>
          )}

          {/* Desktop updates */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <RefreshCw className="size-5 text-teal-600" />
              <h3 className="font-semibold text-slate-900">App updates</h3>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              Check whether a newer signed version of MC School Studio is available.
            </p>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={updateState.status === 'downloaded' ? handleInstallUpdate : handleCheckForUpdates}
                disabled={updateState.status === 'checking' || updateState.status === 'downloading'}
              >
                {updateState.status === 'checking' || updateState.status === 'downloading' ? (
                  <Loader className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                {updateState.status === 'downloaded' ? 'Restart and install' : 'Check for updates'}
              </Button>
              <span className="text-xs text-slate-500">{updateStatusMessage()}</span>
            </div>
          </div>

          {/* Account */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <UserCircle className="size-5 text-teal-600" />
              <h3 className="font-semibold text-slate-900">Studio account</h3>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              Signed in as <span className="font-medium text-slate-700">{member?.email ?? 'studio member'}</span>.
              Projects and uploads are limited by your studio role.
            </p>
            <button
              onClick={handleSignOut}
              className="inline-flex items-center gap-2 text-sm px-3 py-1.5 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50"
            >
              <LogOut className="size-3.5" />
              Sign out of desktop
            </button>
          </div>

          {/* How to use */}
          <div className="bg-teal-50 border border-teal-200 rounded-xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <Info className="size-5 text-teal-600" />
              <h3 className="font-semibold text-teal-800">Photo day workflow</h3>
            </div>
            <ol className="text-sm text-teal-700 space-y-1.5 list-decimal list-inside">
              <li>Prepare the school project in the web app and export it as JSON</li>
              <li>Import the JSON file here using the "Import Project" button</li>
              <li>Open the project and set the watch folder (SmartShooter output folder)</li>
              <li>Start the watcher — the green "Live" indicator appears</li>
              <li>Select a student to display their QR code on screen</li>
               <li>Photograph the QR code first — this marks the start of that student’s capture sequence</li>
               <li>Photograph the student; every following portrait is assigned to that student until the next QR marker</li>
               <li>QR marker images stay in the spool folder but are not added to student galleries</li>
               <li>When signed in, matched portraits are uploaded to the web app automatically</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
