import React, { useState, useEffect } from 'react'
import { FolderOpen, Cloud, Info, CheckCircle, XCircle, Loader } from 'lucide-react'

type ConnectionStatus = 'idle' | 'testing' | 'ok' | 'error'

export function Settings() {
  const [photosDir, setPhotosDir] = useState<string>('')
  const [apiUrl, setApiUrl] = useState<string>('')
  const [uploadKey, setUploadKey] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('idle')
  const [connError, setConnError] = useState<string | null>(null)

  useEffect(() => {
    window.api.invoke('app:getPhotosDir').then((dir) => {
      setPhotosDir(dir as string)
    })

    window.api.invoke('upload:getConfig').then((cfg) => {
      const { apiUrl: url, uploadKey: key } = cfg as { apiUrl: string | null; uploadKey: string | null }
      setApiUrl(url ?? '')
      setUploadKey(key ?? '')
    })
  }, [])

  async function handleOpenPhotosDir() {
    if (photosDir) {
      await window.api.invoke('app:openFile', { filePath: photosDir })
    }
  }

  async function handleSaveConfig() {
    setSaving(true)
    setSavedOk(false)
    try {
      await window.api.invoke('upload:setConfig', { apiUrl, uploadKey })
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  async function handleTestConnection() {
    // Save first
    await window.api.invoke('upload:setConfig', { apiUrl, uploadKey })
    setConnStatus('testing')
    setConnError(null)
    try {
      const result = await window.api.invoke('upload:testConnection') as { ok: boolean; error?: string }
      if (result.ok) {
        setConnStatus('ok')
        setTimeout(() => setConnStatus('idle'), 4000)
      } else {
        setConnStatus('error')
        setConnError(result.error ?? 'Connection failed')
      }
    } catch (e) {
      setConnStatus('error')
      setConnError(String(e))
    }
  }

  const hasConfig = apiUrl.trim() !== '' && uploadKey.trim() !== ''

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white border-b border-slate-200 px-8 py-5">
        <h1 className="text-xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">Application preferences</p>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="max-w-lg space-y-6">

          {/* Photos directory */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <FolderOpen className="size-5 text-teal-600" />
              <h3 className="font-semibold text-slate-900">Photos storage location</h3>
            </div>
            <p className="text-sm text-slate-500 mb-3">
              Matched photos are copied here and organised by project and student ID.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 truncate">
                {photosDir || 'Loading…'}
              </code>
              <button
                onClick={handleOpenPhotosDir}
                className="shrink-0 text-sm text-teal-600 hover:text-teal-700 font-medium"
              >
                Open
              </button>
            </div>
          </div>

          {/* Cloud upload */}
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <Cloud className="size-5 text-teal-600" />
              <h3 className="font-semibold text-slate-900">Cloud upload</h3>
            </div>
            <p className="text-sm text-slate-500 mb-4">
              After each photo is matched, it is automatically uploaded to your MC School
              Studio web app so clients can view their photos online.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Web app URL
                </label>
                <input
                  type="url"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder="https://your-app.replit.app"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-500 bg-white"
                />
                <p className="text-xs text-slate-400 mt-1">
                  The base URL of your web app (no trailing slash).
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Upload key
                </label>
                <input
                  type="password"
                  value={uploadKey}
                  onChange={(e) => setUploadKey(e.target.value)}
                  placeholder="Paste the PHOTO_UPLOAD_KEY from your server"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-500 bg-white font-mono"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Set <code className="bg-slate-100 px-1 rounded">PHOTO_UPLOAD_KEY</code> in
                  your server's environment variables, then paste the same value here.
                </p>
              </div>

              {/* Connection test result */}
              {connStatus === 'ok' && (
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <CheckCircle className="size-4 shrink-0" />
                  Connected successfully
                </div>
              )}
              {connStatus === 'error' && (
                <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <XCircle className="size-4 shrink-0" />
                  {connError ?? 'Connection failed'}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleTestConnection}
                  disabled={!hasConfig || connStatus === 'testing'}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  {connStatus === 'testing' ? (
                    <Loader className="size-3.5 animate-spin" />
                  ) : (
                    <Cloud className="size-3.5" />
                  )}
                  Test connection
                </button>

                <button
                  onClick={handleSaveConfig}
                  disabled={saving}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg disabled:opacity-40"
                >
                  {savedOk ? <CheckCircle className="size-3.5" /> : null}
                  {saving ? 'Saving…' : savedOk ? 'Saved!' : 'Save settings'}
                </button>
              </div>
            </div>
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
              <li>Photograph the student — SmartShooter saves the photo to the watch folder</li>
              <li>The app detects the new photo, reads the QR code, and assigns it automatically</li>
              <li>If cloud upload is configured, the photo is uploaded to the web app instantly</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
