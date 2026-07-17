import React from 'react';
import { useRoute } from 'wouter';
import { useGetProject, getGetProjectQueryKey, useUpdateProject } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { ArrowLeft, Edit2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';

// We'll separate out the tabs into their own components to keep things clean
import { InfoTab } from '@/components/project/InfoTab';
import { ClassesTab } from '@/components/project/ClassesTab';
import { StudentsTab } from '@/components/project/StudentsTab';
import { ExportsTab } from '@/components/project/ExportsTab';

export default function ProjectOverview() {
  const [match, params] = useRoute('/projects/:projectId');
  const projectId = match && params?.projectId ? parseInt(params.projectId, 10) : null;

  const { data: project, isLoading, error } = useGetProject(projectId!, {
    query: {
      enabled: !!projectId,
      queryKey: getGetProjectQueryKey(projectId!)
    }
  });

  if (isLoading) {
    return (
      <div className="flex-1 overflow-auto bg-slate-50 p-8">
        <div className="max-w-6xl mx-auto space-y-6">
          <Skeleton className="w-32 h-4 mb-4" />
          <Skeleton className="w-64 h-10 mb-2" />
          <Skeleton className="w-full h-[500px]" />
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50">
        <div className="text-center text-slate-500">
          <p>Project not found or an error occurred.</p>
          <Link href="/dashboard" className="text-teal-600 hover:underline mt-2 inline-block">Return to Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-slate-50 flex flex-col min-h-0">
      <div className="px-8 py-6 bg-white border-b border-slate-200 flex-shrink-0">
        <div className="max-w-6xl mx-auto">
          <Link href="/dashboard" className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors mb-3">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Dashboard
          </Link>
          <div className="flex items-end justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900">{project.schoolName}</h1>
              <p className="text-slate-500 mt-1 flex items-center gap-3">
                {project.photoDate && (
                  <span>Photo Day: {format(new Date(project.photoDate), 'MMM d, yyyy')}</span>
                )}
                {project.photoDate && <span className="w-1 h-1 rounded-full bg-slate-300"></span>}
                <span>{project.classCount} Classes</span>
                <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                <span>{project.studentCount} Students</span>
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link href={`/projects/${project.id}/import`} className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-teal-600 text-white hover:bg-teal-700 h-10 px-4 py-2">
                Import Data
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-6xl mx-auto h-full">
          <Tabs defaultValue="students" className="h-full flex flex-col">
            <TabsList className="bg-slate-100/50 p-1 border border-slate-200 w-full justify-start rounded-lg self-start">
              <TabsTrigger value="students" className="data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-teal-700">Students</TabsTrigger>
              <TabsTrigger value="classes" className="data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-teal-700">Classes</TabsTrigger>
              <TabsTrigger value="exports" className="data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-teal-700">Exports</TabsTrigger>
              <TabsTrigger value="info" className="data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-teal-700">Project Info</TabsTrigger>
            </TabsList>

            <div className="mt-6 flex-1 min-h-0 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
              <TabsContent value="info" className="m-0 p-6 flex-1 overflow-auto">
                <InfoTab project={project} />
              </TabsContent>
              <TabsContent value="classes" className="m-0 p-0 flex-1 overflow-auto flex flex-col">
                <ClassesTab projectId={project.id} />
              </TabsContent>
              <TabsContent value="students" className="m-0 p-0 flex-1 overflow-auto flex flex-col">
                <StudentsTab projectId={project.id} />
              </TabsContent>
              <TabsContent value="exports" className="m-0 p-6 flex-1 overflow-auto">
                <ExportsTab project={project} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
