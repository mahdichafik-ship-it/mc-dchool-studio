import React, { useState } from 'react'
import { FolderOpen, Upload, Camera, Users, BookOpen, Image, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useProjects } from '@/hooks/useApi'
import { addToast } from '@/components/ui/toast'
import type { Project } from '@/hooks/useApi'

interface Props {
  onOpenProject: (id: number, name: string) => void
}

export function ProjectList({ onOpenProject }: Props) {
  const { data: projects, loading, error, reload } = useProjects()
  const [importing, setImporting] = useState(false)

  async function handleImport() {
    const filePath = await window.api.invoke('dialog:openFile', {
      filters: [{ name: 'MC School Studio Export', extensions: ['json'] }],
    }) as string | null

    if (!filePath) return

    setImporting(true)
    try {
      const result = await window.api.invoke('projects:import', { filePath }) as {
        project: Project
        classesImported: number
        studentsImported: number
      }
      addToast({
        type: 'success',
        title: `Imported: ${result.project.schoolName}`,
        description: `${result.classesImported} classes, ${result.studentsImported} students`,
      })
      reload()
    } catch (e) {
      addToast({ type: 'error', title: 'Import failed', description: String(e) })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-8 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Projects</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Import a school project from the web app to get started
          </p>
        </div>
        <Button onClick={handleImport} disabled={importing}>
          <Upload className="size-4" />
          {importing ? 'Importing…' : 'Import Project'}
        </Button>
      </div>

      {/* Content */}
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
            <h3 className="font-semibold text-slate-700 mb-1">No projects yet</h3>
            <p className="text-sm text-slate-500 max-w-xs">
              Prepare your school project on the web app, export it as JSON, then import it here.
            </p>
            <Button className="mt-4" onClick={handleImport}>
              <Upload className="size-4" />
              Import First Project
            </Button>
          </div>
        )}

        {!loading && projects.length > 0 && (
          <div className="grid grid-cols-1 gap-3 max-w-3xl">
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onClick={() => onOpenProject(p.id, p.schoolName)}
              />
            ))}
          </div>
        )}
      </div>
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
