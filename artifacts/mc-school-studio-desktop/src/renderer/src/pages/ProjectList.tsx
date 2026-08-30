import React, { useState } from 'react'
import { FolderOpen, Cloud, Camera, Users, BookOpen, Image, ChevronRight, RefreshCw, Download, AlertCircle, Loader } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useProjects } from '@/hooks/useApi'
import { addToast } from '@/components/ui/toast'
import type { Project } from '@/hooks/useApi'

interface CloudProject {
  id: number
  schoolName: string
  photoDate: string | null
  address: string | null
  contactName: string | null
  classCount: number
  studentCount: number
  updatedAt: string
}

interface Props {
  onOpenProject: (id: number, name: string) => void
  offline?: boolean
}

export function ProjectList({ onOpenProject, offline = false }: Props) {
  const { data: projects, loading, error, reload } = useProjects()

  // Cloud sync modal state
  const [syncOpen, setSyncOpen] = useState(false)
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([])
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [pullingId, setPullingId] = useState<number | null>(null)

  async function handleOpenSync() {
    setSyncOpen(true)
    setSyncError(null)
    setCloudProjects([])
    setSyncLoading(true)
    try {
      const result = await window.api.invoke('cloud:listProjects') as {
        ok: boolean
        projects?: CloudProject[]
        error?: string
      }
      if (result.ok && result.projects) {
        setCloudProjects(result.projects)
      } else {
        setSyncError(result.error ?? 'Failed to load cloud projects')
      }
    } catch (e) {
      setSyncError(String(e))
    } finally {
      setSyncLoading(false)
    }
  }

  async function handlePullProject(cp: CloudProject) {
    setPullingId(cp.id)
    try {
      const result = await window.api.invoke('cloud:pullProject', { cloudProjectId: cp.id }) as {
        ok: boolean
        classesImported?: number
        studentsImported?: number
        error?: string
      }
      if (result.ok) {
        addToast({
          type: 'success',
          title: `Synced: ${cp.schoolName}`,
          description: `${result.classesImported} classes · ${result.studentsImported} students`,
        })
        reload()
        setSyncOpen(false)
      } else {
        addToast({ type: 'error', title: 'Sync failed', description: result.error })
      }
    } catch (e) {
      addToast({ type: 'error', title: 'Sync failed', description: String(e) })
    } finally {
      setPullingId(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-8 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Projects</h1>
          <p className="text-sm text-slate-500 mt-0.5">
             {offline
               ? 'Your synced projects are available locally while offline'
               : 'Pull a project from the cloud to get started'}
          </p>
        </div>
         <Button
           onClick={handleOpenSync}
           disabled={offline}
           title={offline ? 'Cloud sync requires an internet connection' : undefined}
           className="bg-teal-600 hover:bg-teal-700"
         >
          <Cloud className="size-4" />
           {offline ? 'Cloud unavailable' : 'Sync from Cloud'}
        </Button>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-auto px-8 py-6">
        {loading && (
          <div className="flex items-center justify-center h-48 text-slate-500 text-sm">
            Loading…
          </div>
        )}
        {error && (
          <div className="text-red-500 text-sm bg-red-50 p-4 rounded-lg">{error}</div>
        )}
        {!loading && projects.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
              <FolderOpen className="size-8 text-slate-400" />
            </div>
            <h3 className="font-semibold text-slate-700 mb-1">No local projects yet</h3>
            <p className="text-sm text-slate-500 max-w-xs">
              Create and prepare your project on the web app, then pull it here to start the shoot.
            </p>
             <Button className="mt-4 bg-teal-600 hover:bg-teal-700" onClick={handleOpenSync} disabled={offline}>
              <Cloud className="size-4" />
               {offline ? 'Connect to sync a project' : 'Sync from Cloud'}
            </Button>
          </div>
        )}
        {!loading && projects.length > 0 && (
          <div className="grid grid-cols-1 gap-3 max-w-3xl">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} onClick={() => onOpenProject(p.id, p.schoolName)} />
            ))}
          </div>
        )}
      </div>

      {/* Cloud sync modal */}
      {syncOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            {/* Modal header */}
            <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-teal-50 flex items-center justify-center">
                  <Cloud className="size-5 text-teal-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-slate-900">Sync from Cloud</h2>
                  <p className="text-xs text-slate-500">Select a project to pull locally</p>
                </div>
              </div>
              <button
                onClick={() => { if (!pullingId) setSyncOpen(false) }}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none"
              >
                ×
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-auto p-4">
              {syncLoading && (
                <div className="flex items-center justify-center gap-2 py-12 text-slate-500 text-sm">
                  <Loader className="size-4 animate-spin" />
                  Connecting to cloud…
                </div>
              )}

              {syncError && (
                <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4">
                  <AlertCircle className="size-5 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-red-700">Could not reach cloud</p>
                    <p className="text-xs text-red-600 mt-1">{syncError}</p>
                    <p className="text-xs text-slate-500 mt-2">
                      Check your internet connection. If the problem continues, sign out and sign in again.
                    </p>
                  </div>
                </div>
              )}

              {!syncLoading && !syncError && cloudProjects.length === 0 && (
                <div className="text-center py-12 text-slate-500 text-sm">
                  No projects found on the cloud.
                </div>
              )}

              {!syncLoading && !syncError && cloudProjects.length > 0 && (
                <div className="space-y-2">
                  {cloudProjects.map((cp) => {
                    const isPulling = pullingId === cp.id
                    const alreadyLocal = projects.some(
                      (lp) => lp.schoolName === cp.schoolName,
                    )
                    return (
                      <div
                        key={cp.id}
                        className="flex items-center justify-between border border-slate-200 rounded-xl px-4 py-3 hover:border-teal-300 hover:bg-teal-50/40 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-lg bg-teal-50 flex items-center justify-center shrink-0">
                            <Camera className="size-4 text-teal-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900 truncate">{cp.schoolName}</p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {cp.classCount} classes · {cp.studentCount} students
                              {cp.photoDate ? ` · ${cp.photoDate}` : ''}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-3">
                          {alreadyLocal && (
                            <Badge variant="secondary" className="text-xs text-slate-400">Local copy exists</Badge>
                          )}
                          <button
                            onClick={() => handlePullProject(cp)}
                            disabled={!!pullingId}
                            className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white rounded-lg transition-colors"
                          >
                            {isPulling ? (
                              <Loader className="size-3.5 animate-spin" />
                            ) : (
                              <Download className="size-3.5" />
                            )}
                            {isPulling ? 'Pulling…' : alreadyLocal ? 'Re-sync' : 'Pull'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Refresh footer */}
            {!syncLoading && (
              <div className="px-6 py-3 border-t border-slate-100 flex justify-between items-center">
                <button
                  onClick={handleOpenSync}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700"
                >
                  <RefreshCw className="size-3" />
                  Refresh list
                </button>
                <button
                  onClick={() => setSyncOpen(false)}
                  disabled={!!pullingId}
                  className="text-sm text-slate-500 hover:text-slate-700 disabled:opacity-40"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ProjectCard({ project: p, onClick }: { project: Project; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group bg-white border border-slate-200 rounded-xl p-5 text-left hover:border-teal-300 hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-teal-50 flex items-center justify-center shrink-0">
            <Camera className="size-5 text-teal-600" />
          </div>
          <div>
            <h2 className="font-semibold text-slate-900">{p.schoolName}</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {p.photoDate ? `Photo day: ${p.photoDate}` : 'No photo date set'}
            </p>
          </div>
        </div>
        <ChevronRight className="size-5 text-slate-400 group-hover:text-teal-500 transition-colors mt-2.5" />
      </div>

      <div className="flex items-center gap-4 mt-4">
        <div className="flex items-center gap-1.5 text-sm text-slate-600">
          <BookOpen className="size-3.5" />
          <span>{p.classCount} {p.classCount === 1 ? 'class' : 'classes'}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm text-slate-600">
          <Users className="size-3.5" />
          <span>{p.studentCount} students</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm text-slate-600">
          <Image className="size-3.5" />
          <span>{p.photoCount} photos</span>
        </div>
        {p.watchFolder && (
          <Badge variant="success">Watch folder set</Badge>
        )}
      </div>
    </button>
  )
}
