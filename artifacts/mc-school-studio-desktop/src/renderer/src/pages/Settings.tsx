import React, { useState, useEffect } from 'react'
import { FolderOpen, CloudOff, Info } from 'lucide-react'

export function Settings() {
  const [photosDir, setPhotosDir] = useState<string>('')

  useEffect(() => {
    window.api.invoke('app:getPhotosDir').then((dir) => {
      setPhotosDir(dir as string)
    })
  }, [])

  async function handleOpenPhotosDir() {
    if (photosDir) {
      await window.api.invoke('app:openFile', { filePath: photosDir })
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

          {/* Cloud sync (coming soon) */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 opacity-60">
            <div className="flex items-center gap-3 mb-3">
              <CloudOff className="size-5 text-slate-400" />
              <h3 className="font-semibold text-slate-600">Cloud upload</h3>
              <span className="text-xs bg-slate-200 text-slate-500 rounded-full px-2 py-0.5 font-medium">Coming soon</span>
            </div>
            <p className="text-sm text-slate-400">
              Upload captured photos to the cloud and sync them with the web app. This feature will be added in a future update.
            </p>
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
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
