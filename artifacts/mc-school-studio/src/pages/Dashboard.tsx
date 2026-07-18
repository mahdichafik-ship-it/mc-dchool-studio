import React from 'react';
import { useGetDashboardStats, useListProjects } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { Plus, Building2, Layers, Users, FolderKanban, Calendar, ChevronRight, Monitor, Apple, AppWindow } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';

const GITHUB_RELEASES_URL = 'https://github.com/mahdichafik-ship-it/untitled-project/releases/latest';

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: projects, isLoading: projectsLoading } = useListProjects();

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Dashboard</h1>
          <Link href="/projects/new" className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 bg-teal-600 hover:bg-teal-700 text-white shadow-sm h-10 px-4 py-2">
            <Plus className="w-4 h-4 mr-2" />
            New Project
          </Link>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard title="Total Projects" value={stats?.totalProjects} icon={FolderKanban} isLoading={statsLoading} />
          <StatCard title="Schools" value={stats?.totalSchools} icon={Building2} isLoading={statsLoading} />
          <StatCard title="Classes" value={stats?.totalClasses} icon={Layers} isLoading={statsLoading} />
          <StatCard title="Students" value={stats?.totalStudents} icon={Users} isLoading={statsLoading} />
        </div>

        {/* Desktop App Download */}
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-6 flex items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-teal-600 flex items-center justify-center shrink-0">
              <Monitor className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Desktop App — for shoot day</h2>
              <p className="text-sm text-slate-600 mt-0.5">
                Watch your camera folder, auto-match QR codes, and upload photos live during the shoot.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={`${GITHUB_RELEASES_URL}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-white border border-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
            >
              <Apple className="w-4 h-4" />
              Mac (.dmg)
            </a>
            <a
              href={`${GITHUB_RELEASES_URL}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-white border border-slate-200 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
            >
              <AppWindow className="w-4 h-4" />
              Windows (.exe)
            </a>
          </div>
        </div>

        {/* Projects */}
        <div>
          <h2 className="text-xl font-semibold text-slate-900 mb-4">Recent Projects</h2>
          {projectsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map(i => (
                <Card key={i} className="animate-pulse h-40 bg-slate-100/50 border-slate-200" />
              ))}
            </div>
          ) : projects?.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-xl border border-slate-200 border-dashed">
              <div className="w-12 h-12 bg-teal-50 text-teal-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <FolderKanban className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-medium text-slate-900 mb-2">No projects yet</h3>
              <p className="text-slate-500 mb-6 max-w-sm mx-auto">Create your first photography project to start importing students and generating QR codes.</p>
              <Link href="/projects/new" className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-teal-600 text-white hover:bg-teal-700 h-10 px-4 py-2">
                Create Project
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects?.map((project) => (
                <Link key={project.id} href={`/projects/${project.id}`}>
                  <Card className="hover:border-teal-600/50 hover:shadow-md transition-all cursor-pointer bg-white group">
                    <CardHeader className="pb-3 flex flex-row justify-between items-start space-y-0">
                      <div>
                        <CardTitle className="text-lg font-semibold text-slate-900 line-clamp-1">
                          {project.schoolName}
                        </CardTitle>
                        <div className="flex items-center text-sm text-slate-500 mt-1">
                          <Calendar className="w-3.5 h-3.5 mr-1" />
                          {project.photoDate ? format(new Date(project.photoDate), 'MMM d, yyyy') : 'No date set'}
                        </div>
                      </div>
                      <div className="w-8 h-8 rounded-full bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-teal-50 group-hover:text-teal-600 transition-colors">
                        <ChevronRight className="w-4 h-4" />
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-4 text-sm">
                        <div className="flex items-center gap-1.5 text-slate-600">
                          <Layers className="w-4 h-4 text-slate-400" />
                          <span className="font-medium text-slate-900">{project.classCount}</span> classes
                        </div>
                        <div className="flex items-center gap-1.5 text-slate-600">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span className="font-medium text-slate-900">{project.studentCount}</span> students
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, isLoading }: { title: string, value?: number, icon: any, isLoading: boolean }) {
  return (
    <Card className="bg-white border-slate-200">
      <CardContent className="p-6">
        <div className="flex items-center justify-between space-y-0 pb-2">
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <Icon className="w-4 h-4 text-teal-600" />
        </div>
        {isLoading ? (
          <div className="h-8 w-16 bg-slate-100 animate-pulse rounded mt-1" />
        ) : (
          <div className="text-3xl font-bold text-slate-900 mt-1">{value?.toLocaleString() || 0}</div>
        )}
      </CardContent>
    </Card>
  );
}
