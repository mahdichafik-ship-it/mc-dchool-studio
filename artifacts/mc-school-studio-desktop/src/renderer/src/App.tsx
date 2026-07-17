import React, { useState, useCallback } from 'react'
import { AppLayout } from '@/components/layout/AppLayout'
import { ProjectList } from '@/pages/ProjectList'
import { ProjectView } from '@/pages/ProjectView'
import { Settings } from '@/pages/Settings'
import { Toaster } from '@/components/ui/toast'
import { usePhotoEvents } from '@/hooks/useApi'
import { addToast } from '@/components/ui/toast'
import type { PhotoMatchedEvent, PhotoUnmatchedEvent } from '@/hooks/useApi'

type Page = 'projects' | 'project-view' | 'settings'

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('projects')
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null)
  const [activeProjectName, setActiveProjectName] = useState<string>('')

  const handleMatched = useCallback((data: PhotoMatchedEvent) => {
    addToast({
      type: 'success',
      title: `Photo matched: ${data.student.firstName} ${data.student.lastName}`,
      description: data.photo.fileName,
    })
  }, [])

  const handleUnmatched = useCallback((data: PhotoUnmatchedEvent) => {
    addToast({
      type: 'error',
      title: 'Photo could not be matched',
      description: data.reason,
    })
  }, [])

  usePhotoEvents(handleMatched, handleUnmatched)

  const openProject = (id: number, name: string) => {
    setActiveProjectId(id)
    setActiveProjectName(name)
    setCurrentPage('project-view')
  }

  const navigate = (page: Page) => {
    setCurrentPage(page)
  }

  return (
    <AppLayout
      currentPage={currentPage}
      onNavigate={navigate}
      projectName={activeProjectName}
    >
      {currentPage === 'projects' && (
        <ProjectList onOpenProject={openProject} />
      )}
      {currentPage === 'project-view' && activeProjectId && (
        <ProjectView
          projectId={activeProjectId}
          onBack={() => setCurrentPage('projects')}
        />
      )}
      {currentPage === 'settings' && <Settings />}
      <Toaster />
    </AppLayout>
  )
}
