import React, { useState, useEffect, useCallback } from 'react';
import { Camera, Image as ImageIcon, Download, RefreshCw, ChevronDown, ChevronRight, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useListStudents, useUpdatePhotoSharing } from '@workspace/api-client-react';

interface CloudPhoto {
  id: number;
  projectId: number;
  studentId: number;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  shareWithParents: boolean;
  capturedAt: string | null;
  createdAt: string;
}

interface StudentWithPhotos {
  studentId: number;
  firstName: string;
  lastName: string;
  generatedStudentId: string;
  className: string | null;
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

export function PhotosTab({ projectId, isCorporate }: { projectId: number, isCorporate?: boolean }) {
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
              className: s.className ?? null,
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
      void loadPhotos(students);
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
      <div className="flex h-64 items-center justify-center gap-2 p-12 text-sm text-slate-500">
        <Loader2 className="size-4 animate-spin" />
        Loading photos…
      </div>
    );
  }

  if (studentsWithPhotos.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center p-12 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100">
          <ImageIcon className="size-8 text-slate-400" />
        </div>
        <h3 className="mb-1 font-semibold text-slate-600">No photos uploaded yet</h3>
        <p className="max-w-xs text-sm text-slate-400">
          Photos will appear here after the desktop app uploads them during a shoot.
        </p>
        <button
          onClick={() => void loadPhotos(students)}
          className="mt-4 text-sm text-teal-600 underline hover:text-teal-700"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <Camera className="size-4 text-teal-600" />
          <span className="text-sm font-medium text-slate-700">
            {totalPhotos} photo{totalPhotos !== 1 ? 's' : ''} across {studentsWithPhotos.length} {isCorporate ? 'employee' : 'student'}{studentsWithPhotos.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={() => void loadPhotos(students)}
          className="flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-700"
        >
          <RefreshCw className="size-3" />
          Refresh
        </button>
      </div>

      {/* Employee/Student list */}
      <div className="flex-1 overflow-auto">
        {studentsWithPhotos.map((s) => (
          <div key={s.studentId} className="border-b border-slate-100">
            <button
              onClick={() => toggleExpand(s.studentId)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
            >
              {expanded.has(s.studentId) ? (
                <ChevronDown className="size-4 shrink-0 text-slate-400" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-slate-400" />
              )}
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-slate-900">
                  {s.lastName}, {s.firstName}
                </span>
                <span className="ml-2 text-xs font-mono text-slate-400">{s.generatedStudentId}</span>
                {s.className && (
                  <span className="ml-2 text-xs text-slate-500">{s.className}</span>
                )}
              </div>
              <span className="shrink-0 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">
                {s.photos.length} photo{s.photos.length !== 1 ? 's' : ''}
              </span>
            </button>

            {expanded.has(s.studentId) && (
              <div className="grid grid-cols-2 gap-3 bg-slate-50/50 px-4 pb-4 pt-1 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {s.photos.map((photo) => (
                  <PhotoCard key={photo.id} photo={photo} isCorporate={isCorporate} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PhotoCard({ photo, isCorporate }: { photo: CloudPhoto, isCorporate?: boolean }) {
  // Use the authenticated proxy endpoint — browser sends session cookie automatically
  const fileUrl = photoFileUrl(photo.projectId, photo.studentId, photo.id);
  const [isShared, setIsShared] = useState(photo.shareWithParents);
  const updateSharing = useUpdatePhotoSharing();

  useEffect(() => {
    setIsShared(photo.shareWithParents);
  }, [photo.shareWithParents]);

  const handleToggleShare = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (updateSharing.isPending) return;
    
    const nextValue = !isShared;
    // Optimistic update
    setIsShared(nextValue);

    updateSharing.mutate(
      {
        projectId: photo.projectId,
        studentId: photo.studentId,
        photoId: photo.id,
        data: { shareWithParents: nextValue },
      },
      {
        onError: () => {
          // Revert on error
          setIsShared(!nextValue);
        },
      }
    );
  };

  const updating = updateSharing.isPending;

  return (
    <div className="group relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
      <img
        src={fileUrl}
        alt={photo.fileName}
        className={`h-full w-full object-cover transition-opacity duration-300 ${!isShared ? 'opacity-40 grayscale' : 'opacity-100'}`}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />

      {/* Top action bar - Share Toggle */}
      <div className="absolute left-0 right-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={handleToggleShare}
          disabled={updating}
          title={isShared ? `Hide from ${isCorporate ? 'employee' : 'parent'} gallery` : `Show in ${isCorporate ? 'employee' : 'parent'} gallery`}
          data-testid={`button-toggle-share-${photo.id}`}
          className={`flex items-center gap-1.5 rounded bg-black/50 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/70 ${updating ? 'opacity-50' : ''}`}
        >
          {updating ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : isShared ? (
            <>
              <Eye className="size-3.5" />
              <span>Visible</span>
            </>
          ) : (
            <>
              <EyeOff className="size-3.5" />
              <span>Hidden</span>
            </>
          )}
        </button>

        <a
          href={fileUrl}
          download={photo.fileName}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`link-download-${photo.id}`}
          className="rounded bg-black/50 p-1.5 text-white backdrop-blur-sm transition-colors hover:bg-black/70"
          title="Download original"
          onClick={(e) => e.stopPropagation()}
        >
          <Download className="size-3.5" />
        </a>
      </div>

      {!isShared && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-md">
            Hidden from delivery
          </div>
        </div>
      )}

      {/* Filename */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
        <p className="truncate text-[10px] text-white/90" data-testid={`text-filename-${photo.id}`}>{photo.fileName}</p>
      </div>
    </div>
  );
}
