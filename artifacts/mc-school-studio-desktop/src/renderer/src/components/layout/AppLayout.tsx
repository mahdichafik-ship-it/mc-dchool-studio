import React from 'react'
import { Camera, LayoutDashboard, Settings, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Page = 'projects' | 'project-view' | 'settings'

interface AppLayoutProps {
  children: React.ReactNode
  currentPage: Page
  onNavigate: (page: Page) => void
  projectName?: string
  offline?: boolean
  version: string
}

export function AppLayout({ children, currentPage, onNavigate, projectName, offline = false, version }: AppLayoutProps) {
  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-[#0f172a] flex flex-col">
        {/* Logo area — with macOS traffic light padding */}
        <div className="h-16 flex items-center px-5 border-b border-white/10" style={{ paddingTop: 'env(titlebar-area-height, 0)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <Camera className="size-4 text-white" />
            </div>
            <span className="text-white font-semibold text-sm leading-tight">MC School<br />Studio</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          <Button
            variant={currentPage === 'projects' ? 'sidebar-active' : 'sidebar'}
            className="w-full text-sm"
            onClick={() => onNavigate('projects')}
          >
            <LayoutDashboard className="size-4" />
            Projects
          </Button>

          {projectName && currentPage === 'project-view' && (
            <div className="ml-3 mt-2">
              <div className="flex items-center gap-1 text-xs text-slate-500 mb-1">
                <ChevronRight className="size-3" />
                <span className="truncate">{projectName}</span>
              </div>
            </div>
          )}
        </nav>

        {/* Bottom */}
        <div className="px-3 pb-4 border-t border-white/10 pt-3">
          <Button
            variant={currentPage === 'settings' ? 'sidebar-active' : 'sidebar'}
            className="w-full text-sm"
            onClick={() => onNavigate('settings')}
          >
            <Settings className="size-4" />
            Settings
          </Button>
          <p className="text-xs text-slate-500 mt-3 px-2">MC School Studio v{version || '—'}</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {offline && (
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
            <span>
              Offline mode: local projects and photo capture are available. Uploads will resume automatically when internet returns.
            </span>
          </div>
        )}
        {children}
      </main>
    </div>
  )
}
