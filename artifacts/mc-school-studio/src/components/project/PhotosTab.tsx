import React, { useState, useEffect, useCallback } from 'react';
import { Camera, Image as ImageIcon, Download, RefreshCw, ChevronDown, ChevronRight, Loader2, Star, EyeOff, CheckCircle2, CircleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useListStudents } from '@workspace/api-client-react';

interface CloudPhoto {
  id: number;
  projectId: number;
  studentId: number;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  rating: number;
  colorLabel: string;
  shareWithParents: boolean;
  sourceGroupCaptureFileId: number | null;
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

async function reviewPhoto(
  projectId: number,
  studentId: number,
  photoId: number,
  decision: 'selected' | 'do_not_share',
  rating?: number,
): Promise<CloudPhoto> {
  const res = await fetch(`/api/projects/${projectId}/students/${studentId}/photos/${photoId}/review`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, rating }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? 'Could not save the review');
  }
  const body = await res.json() as { photo: CloudPhoto };
  return body.photo;
}

/** Build the URL that streams a photo file — same-origin, Clerk session cookie is sent by the browser */
function photoFileUrl(projectId: number, studentId: number, photoId: number): string {
  return `/api/projects/${projectId}/students/${studentId}/photos/${photoId}/file?size=thumbnail`;
}

export function PhotosTab({ projectId, isCorporate }: { projectId: number, isCorporate?: boolean }) {
  const { data: students = [], isLoading: studentsLoading } = useListStudents(projectId);
  const [loading, setLoading] = useState(false);
  const [canManage, setCanManage] = useState(false);
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

  useEffect(() => {
    let active = true;
    void fetch('/api/studio', { credentials: 'include' })
      .then(async (response) => response.ok ? response.json() as Promise<{ member: { role: string; status: string } }> : null)
      .then((context) => {
        if (!active) return;
        setCanManage(Boolean(
          context
          && context.member.status === 'active'
          && (context.member.role === 'owner' || context.member.role === 'admin'),
        ));
      })
      .catch(() => {
        if (active) setCanManage(false);
      });
    return () => { active = false; };
  }, []);

  function toggleExpand(studentId: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  }

  const totalPhotos = studentsWithPhotos.reduce((sum, s) => sum + s.photos.length, 0);
  const unresolvedPhotos = studentsWithPhotos.reduce(
    (sum, student) => sum + student.photos.filter((photo) => photo.rating === 0 && photo.colorLabel !== 'red').length,
    0,
  );

  const updateReviewedPhoto = useCallback((reviewed: CloudPhoto) => {
    setStudentsWithPhotos((current) => current.map((student) => ({
      ...student,
      photos: student.photos.map((photo) => (
        photo.id === reviewed.id
        || (reviewed.sourceGroupCaptureFileId && photo.sourceGroupCaptureFileId === reviewed.sourceGroupCaptureFileId)
          ? { ...photo, ...reviewed }
          : photo
      )),
    })));
  }, []);

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
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <Camera className="size-4 text-teal-600" />
          <span className="text-sm font-medium text-slate-700">
            {totalPhotos} photo{totalPhotos !== 1 ? 's' : ''} across {studentsWithPhotos.length} {isCorporate ? 'employee' : 'student'}{studentsWithPhotos.length !== 1 ? 's' : ''}
          </span>
          {canManage && unresolvedPhotos > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
              <CircleAlert className="size-3" />
              {unresolvedPhotos} need review
            </span>
          ) : canManage ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="size-3" />
              Review complete
            </span>
          ) : null}
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
                  <PhotoCard key={photo.id} photo={photo} canManage={canManage} onReviewed={updateReviewedPhoto} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PhotoCard({ photo, canManage, onReviewed }: { photo: CloudPhoto, canManage: boolean, onReviewed: (photo: CloudPhoto) => void }) {
  // Use the authenticated proxy endpoint — browser sends session cookie automatically
  const fileUrl = photoFileUrl(photo.projectId, photo.studentId, photo.id);
  const [saving, setSaving] = useState(false);
  const isDoNotShare = photo.rating === 0 && photo.colorLabel === 'red';
  const isSelected = photo.rating > 0 && photo.shareWithParents;

  async function saveReview(decision: 'selected' | 'do_not_share', rating?: number) {
    setSaving(true);
    try {
      const reviewed = await reviewPhoto(photo.projectId, photo.studentId, photo.id, decision, rating);
      onReviewed(reviewed);
      toast.success(decision === 'selected' ? `${rating} star selection saved` : 'Marked Do not share');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the review');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`overflow-hidden rounded-lg border bg-white shadow-sm ${isSelected ? 'border-emerald-400 ring-1 ring-emerald-200' : isDoNotShare ? 'border-slate-300 opacity-75' : 'border-amber-300'}`}>
      <div className="group relative aspect-square bg-slate-100">
        <img
          src={fileUrl}
          alt={photo.fileName}
          className="h-full w-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />

        <div className="absolute left-0 right-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent p-2">
          <span className={`rounded px-2 py-1 text-[10px] font-bold text-white ${isSelected ? 'bg-emerald-600' : isDoNotShare ? 'bg-slate-700' : 'bg-amber-600'}`}>
            {isSelected ? `${photo.rating} star${photo.rating === 1 ? '' : 's'} · Gallery` : isDoNotShare ? 'Do not share' : 'Needs review'}
          </span>
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

        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-8">
          <p className="truncate text-[10px] text-white/90" data-testid={`text-filename-${photo.id}`}>{photo.fileName}</p>
        </div>
      </div>

      {canManage && <div className="space-y-2 p-2">
        <div className="flex items-center justify-between" aria-label={`Rate ${photo.fileName}`}>
          {[1, 2, 3, 4, 5].map((rating) => (
            <button
              key={rating}
              type="button"
              disabled={saving}
              onClick={() => void saveReview('selected', rating)}
              className="rounded p-1 text-slate-300 transition hover:bg-amber-50 hover:text-amber-500 disabled:opacity-50"
              title={`Select with ${rating} star${rating === 1 ? '' : 's'}`}
              aria-label={`${rating} star${rating === 1 ? '' : 's'}`}
            >
              <Star className={`size-4 ${isSelected && photo.rating >= rating ? 'fill-amber-400 text-amber-400' : ''}`} />
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveReview('do_not_share')}
          className={`flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${isDoNotShare ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : <EyeOff className="size-3" />}
          Do not share
        </button>
      </div>}
    </div>
  );
}
