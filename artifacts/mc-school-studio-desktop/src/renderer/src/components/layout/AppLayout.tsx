import React, { useEffect, useState } from 'react'
import { Camera, LayoutDashboard, Settings, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Page = 'projects' | 'project-view' | 'settings'

function SidebarHint({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="group/sidebar-hint relative w-full">
      {children}
      <div
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 w-max max-w-64 -translate-y-1/2 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-[11px] font-medium leading-4 text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover/sidebar-hint:opacity-100 group-focus-within/sidebar-hint:opacity-100"
      >
        {text}
      </div>
    </div>
  )
}

interface AppLayoutProps {
  children: React.ReactNode
  currentPage: Page
  onNavigate: (page: Page) => void
  projectName?: string
  projectClasses?: Array<{ id: number; className: string; studentCount: number }>
  selectedClassId?: number | null
  onSelectClass?: (classId: number | null) => void
  offline?: boolean
  version: string
}

export function AppLayout({
  children,
  currentPage,
  onNavigate,
  projectName,
  projectClasses = [],
  selectedClassId = null,
  onSelectClass,
  offline = false,
  version,
}: AppLayoutProps) {
  const [projectNavOpen, setProjectNavOpen] = useState(false)

  useEffect(() => {
    setProjectNavOpen(false)
  }, [projectName])

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-[#0f172a] flex flex-col">
        {/* Logo area — with macOS traffic light padding */}
        <div className="h-16 flex items-center px-5 border-b border-white/10" style={{ paddingTop: 'env(titlebar-area-height, 0)' }}>
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-black">
              <img src="./volume-capture-logo.png" alt="" className="h-full w-full object-cover" />
            </div>
            <span className="text-white font-semibold text-sm leading-tight">Volume<br />Capture</span>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          <SidebarHint text="Return to the project list.">
            <Button
              variant={currentPage === 'projects' ? 'sidebar-active' : 'sidebar'}
              className="w-full text-sm"
              onClick={() => onNavigate('projects')}
            >
              <LayoutDashboard className="size-4" />
              Projects
            </Button>
          </SidebarHint>

          {projectName && currentPage === 'project-view' && (
            <div className="ml-1 mt-2">
              <SidebarHint text={projectNavOpen ? 'Hide this project’s classes.' : 'Show this project’s classes.'}>
                <button
                  type="button"
                  aria-expanded={projectNavOpen}
                  aria-controls="project-class-navigation"
                  onClick={() => setProjectNavOpen((open) => !open)}
                  className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
                >
                  <ChevronRight className={cn('size-3 shrink-0 transition-transform', projectNavOpen && 'rotate-90')} />
                  <span className="truncate">{projectName}</span>
                </button>
              </SidebarHint>
              {projectNavOpen && (
                <div id="project-class-navigation" className="mt-1 space-y-0.5 pl-4">
                  <SidebarHint text="Show students from every class.">
                    <button
                      type="button"
                      onClick={() => onSelectClass?.(null)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[11px] transition-colors',
                        selectedClassId === null
                          ? 'bg-white/10 font-semibold text-white'
                          : 'text-slate-500 hover:bg-white/5 hover:text-slate-200',
                      )}
                    >
                      <span>All classes</span>
                      <span className="text-[10px] text-slate-500">{projectClasses.reduce((total, item) => total + item.studentCount, 0)}</span>
                    </button>
                  </SidebarHint>
                  {projectClasses.map((projectClass) => (
                    <SidebarHint key={projectClass.id} text={`Show students from ${projectClass.className}.`}>
                      <button
                        type="button"
                        onClick={() => onSelectClass?.(projectClass.id)}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors',
                          selectedClassId === projectClass.id
                            ? 'bg-teal-500/15 font-semibold text-teal-300'
                            : 'text-slate-500 hover:bg-white/5 hover:text-slate-200',
                        )}
                      >
                        <span className="truncate">{projectClass.className}</span>
                        <span className="shrink-0 text-[10px] text-slate-500">{projectClass.studentCount}</span>
                      </button>
                    </SidebarHint>
                  ))}
                  {projectClasses.length === 0 && (
                    <p className="px-2 py-1 text-[10px] text-slate-600">Loading classes…</p>
                  )}
                </div>
              )}
            </div>
          )}
        </nav>

        {/* Bottom */}
        <div className="px-3 pb-4 border-t border-white/10 pt-3">
          <SidebarHint text="Open desktop settings.">
            <Button
              variant={currentPage === 'settings' ? 'sidebar-active' : 'sidebar'}
              className="w-full text-sm"
              onClick={() => onNavigate('settings')}
            >
              <Settings className="size-4" />
              Settings
            </Button>
          </SidebarHint>
          <p className="text-xs text-slate-500 mt-3 px-2">Volume Capture v{version || '—'}</p>
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
