import React, { useState, useCallback, useEffect } from 'react'
import { AppLayout } from '@/components/layout/AppLayout'
import { ProjectList } from '@/pages/ProjectList'
import { ProjectView } from '@/pages/ProjectView'
import { Settings } from '@/pages/Settings'
import { Toaster } from '@/components/ui/toast'
import { usePhotoEvents } from '@/hooks/useApi'
import { addToast } from '@/components/ui/toast'
import type { PhotoMatchedEvent, PhotoMarkerEvent, PhotoUnmatchedEvent } from '@/hooks/useApi'

type Page = 'projects' | 'project-view' | 'settings'
type AuthMember = { email: string; role: 'owner' | 'admin' | 'assistant' | 'photographer' }
type AuthState = { status: 'loading' | 'signed-out' | 'signed-in'; member?: AuthMember; error?: string }

function SignInScreen({ onSignIn, error, busy }: { onSignIn: () => void; error?: string; busy: boolean }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-6">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-sm p-8 text-center">
        <div className="mx-auto mb-5 w-14 h-14 rounded-2xl bg-teal-600 flex items-center justify-center">
          <span className="text-2xl">📷</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Sign in to MC School Studio</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Sign in securely in your browser. Your studio projects and permissions will be loaded automatically.
        </p>
        {error && (
          <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-left text-sm text-red-700">
            {error}
          </div>
        )}
        <button
          className="mt-6 w-full rounded-lg bg-teal-600 px-4 py-3 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          onClick={onSignIn}
          disabled={busy}
        >
          {busy ? 'Waiting for browser sign-in…' : 'Sign in with your studio account'}
        </button>
        <p className="mt-5 text-xs text-slate-400">
          A browser window will open. No Mac or connection token setup is required.
        </p>
      </div>
    </div>
  )
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('projects')
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null)
  const [activeProjectName, setActiveProjectName] = useState<string>('')
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [authBusy, setAuthBusy] = useState(false)

  const loadAuth = useCallback(async () => {
    const result = await window.api.invoke('auth:getSession')
    setAuth(result.signedIn
      ? { status: 'signed-in', member: result.member }
      : { status: 'signed-out', error: result.error })
  }, [])

  useEffect(() => {
    loadAuth().catch(() => setAuth({ status: 'signed-out', error: 'Could not check your desktop session.' }))
  }, [loadAuth])

  const signIn = useCallback(async () => {
    setAuthBusy(true)
    setAuth({ status: 'signed-out' })
    try {
      const result = await window.api.invoke('auth:signIn')
      setAuth(result.signedIn
        ? { status: 'signed-in', member: result.member }
        : { status: 'signed-out', error: result.error })
    } catch {
      setAuth({ status: 'signed-out', error: 'Sign-in could not be completed. Please try again.' })
    } finally {
      setAuthBusy(false)
    }
  }, [])

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

  const handleMarker = useCallback((data: PhotoMarkerEvent) => {
    addToast({
      type: 'info',
      title: `Now photographing: ${data.student.firstName} ${data.student.lastName}`,
      description: 'The next portraits will be assigned to this student until the next QR marker.',
    })
  }, [])

  usePhotoEvents(handleMatched, handleUnmatched, handleMarker)

  if (auth.status === 'loading') {
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">Checking your session…</div>
  }

  if (auth.status !== 'signed-in') {
    return <SignInScreen onSignIn={signIn} error={auth.error} busy={authBusy} />
  }

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
      {currentPage === 'settings' && <Settings member={auth.member} onSignedOut={() => setAuth({ status: 'signed-out', error: 'You have signed out of this desktop.' })} />}
      <Toaster />
    </AppLayout>
  )
}
