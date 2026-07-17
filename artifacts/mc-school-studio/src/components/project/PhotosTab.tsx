import React, { useState, useEffect, useCallback } from 'react';
import { Camera, Image, Download, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { useListStudents } from '@workspace/api-client-react';

interface CloudPhoto {
  id: number;
  projectId: number;
  studentId: number;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  capturedAt: string | null;
  createdAt: string;
}

interface StudentWithPhotos {
  studentId: number;
  firstName: string;
  lastName: string;
  generatedStudentId: string;
  className: string;
  photos: CloudPhoto[];
}

/** Fetch photos for a student via the Clerk-authenticated API (session cookie sent automatically) */
async function fetchStudentPhotos(projectId: number, studentId: number): Promise<CloudPhoto[]> {
  const res = await fetch(`/api/projects/${projectId}/students/${studentId}/photos`, {
    credentials: 'include',
  });
  if (!res.ok) return [];
  return res.json();
}

/** Build the URL that streams a photo file — same-origin, Clerk session cookie is sent by the browser */
function photoFileUrl(projectId: number, studentId: number, photoId: number): string {
  return `/api/projects/${projectId}/students/${studentId}/photos/${photoId}/file`;
}

export function PhotosTab({ projectId }: { projectId: number }) {
  const { data: students = [], isLoading: studentsLoading } = useListStudents(projectId);
  const [loading, setLoading] = useState(false);
  const [studentsWithPhotos, setStudentsWithPhotos] = useState<StudentWithPhotos[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const loadPhotos = useCallback(async (studentsData: typeof students) => {
    if (studentsData.length === 0) return;
    setLoading(true);
    try {
      const results: StudentWithPhotos[] = [];
      // Batch of 5 to avoid overwhelming the server
      for (let i = 0; i < studentsData.length; i += 5) {
        const batch = studentsData.slice(i, i + 5);
        const batchResults = await Promise.all(
          batch.map(async (s) => {
            const photos = await fetchStudentPhotos(projectId, s.id);
            return {
              studentId: s.id,
              firstName: s.firstName,
              lastName: s.lastName,
              generatedStudentId: s.generatedStudentId,
              className: s.className,
              photos,
            };
          }),
        );
        results.push(...batchResults);
      }
      setStudentsWithPhotos(results.filter((s) => s.photos.length > 0));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (students.length > 0) {
      loadPhotos(students);
    }
  }, [students, loadPhotos]);

  function toggleExpand(studentId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  }

  const totalPhotos = studentsWithPhotos.reduce((sum, s) => sum + s.photos.length, 0);

  if (studentsLoading || loading) {
    return (
      <div className="flex items-center justify-center p-12 text-slate-500 text-sm gap-2">
        <RefreshCw className="size-4 animate-spin" />
        Loading photos…
      </div>
    );
  }

  if (studentsWithPhotos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
          <Image className="size-8 text-slate-400" />
        </div>
        <h3 className="font-semibold text-slate-600 mb-1">No photos uploaded yet</h3>
        <p className="text-sm text-slate-400 max-w-xs">
          Photos will appear here after the desktop app uploads them during a shoot.
        </p>
        <button
          onClick={() => loadPhotos(students)}
          className="mt-4 text-sm text-teal-600 hover:text-teal-700 underline"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 bg-white flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Camera className="size-4 text-teal-600" />
          <span className="text-sm font-medium text-slate-700">
            {totalPhotos} photo{totalPhotos !== 1 ? 's' : ''} across {studentsWithPhotos.length} student{studentsWithPhotos.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={() => loadPhotos(students)}
          className="text-xs text-teal-600 hover:text-teal-700 font-medium flex items-center gap-1"
        >
          <RefreshCw className="size-3" />
          Refresh
        </button>
      </div>

      {/* Student list */}
      <div className="flex-1 overflow-auto">
        {studentsWithPhotos.map((s) => (
          <div key={s.studentId} className="border-b border-slate-100">
            <button
              onClick={() => toggleExpand(s.studentId)}
              className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left"
            >
              {expanded.has(s.studentId) ? (
                <ChevronDown className="size-4 text-slate-400 shrink-0" />
              ) : (
                <ChevronRight className="size-4 text-slate-400 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <span className="font-medium text-slate-900 text-sm">
                  {s.lastName}, {s.firstName}
                </span>
                <span className="ml-2 text-xs font-mono text-slate-400">{s.generatedStudentId}</span>
                <span className="ml-2 text-xs text-slate-500">{s.className}</span>
              </div>
              <span className="shrink-0 text-xs bg-teal-50 text-teal-700 rounded-full px-2 py-0.5 font-medium">
                {s.photos.length} photo{s.photos.length !== 1 ? 's' : ''}
              </span>
            </button>

            {expanded.has(s.studentId) && (
              <div className="grid grid-cols-4 gap-3 px-4 pb-4 pt-1 bg-slate-50/50">
                {s.photos.map((photo) => (
                  <PhotoCard key={photo.id} photo={photo} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PhotoCard({ photo }: { photo: CloudPhoto }) {
  // Use the authenticated proxy endpoint — browser sends session cookie automatically
  const fileUrl = photoFileUrl(photo.projectId, photo.studentId, photo.id);

  return (
    <div className="group relative bg-slate-100 rounded-lg overflow-hidden aspect-square border border-slate-200">
      <img
        src={fileUrl}
        alt={photo.fileName}
        className="w-full h-full object-cover"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-end justify-start p-1.5 gap-1">
        <a
          href={fileUrl}
          download={photo.fileName}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white bg-white/20 hover:bg-white/30 rounded p-1"
          title="Download"
        >
          <Download className="size-3.5" />
        </a>
      </div>

      {/* Filename */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1.5">
        <p className="text-white text-[9px] truncate">{photo.fileName}</p>
      </div>
    </div>
  );
}
