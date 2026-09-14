import React, { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Star,
} from "lucide-react";
import { toast } from "sonner";

type CaptureFile = {
  id: number;
  fileRole: "JPEG" | "RAW";
  fileFormat: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number | null;
  url: string;
};

type Capture = {
  id: number;
  captureKey: string;
  baseFilename: string;
  capturedAt: string | null;
  sequence: number | null;
  pairingStatus: "complete" | "jpeg_only" | "raw_only";
  favorite: boolean;
  rejected: boolean;
  selected: boolean;
  rating: number;
  colorLabel: string;
  createdAt: string;
  updatedAt: string;
  files: CaptureFile[];
};

type StudentCaptures = {
  studentId: number;
  firstName: string;
  lastName: string;
  generatedStudentId: string;
  className: string | null;
  captures: Capture[];
};

type CaptureReviewResponse = {
  students: StudentCaptures[];
  totals: {
    captures: number;
    complete: number;
    jpegOnly: number;
    rawOnly: number;
  };
};

function statusLabel(status: Capture["pairingStatus"]): string {
  if (status === "complete") return "JPEG + RAW";
  if (status === "jpeg_only") return "JPEG only";
  return "RAW only";
}

function statusClass(status: Capture["pairingStatus"]): string {
  if (status === "complete") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "jpeg_only") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchCaptures(projectId: number): Promise<CaptureReviewResponse> {
  const response = await fetch(`/api/projects/${projectId}/captures`, {
    credentials: "include",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not load captures");
  }
  return response.json() as Promise<CaptureReviewResponse>;
}

export function PhotosTab({ projectId, isCorporate }: { projectId: number; isCorporate?: boolean }) {
  const [review, setReview] = useState<CaptureReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const loadCaptures = useCallback(async () => {
    setLoading(true);
    try {
      setReview(await fetchCaptures(projectId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load captures");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadCaptures();
  }, [loadCaptures]);

  const toggleStudent = (studentId: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  };

  if (loading && !review) {
    return (
      <div className="flex min-h-[320px] items-center justify-center text-slate-500">
        <Loader2 className="mr-2 size-5 animate-spin" />
        Loading captures…
      </div>
    );
  }

  if (!review || review.students.length === 0) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center">
        <ImageIcon className="mb-3 size-10 text-slate-300" />
        <h3 className="text-base font-semibold text-slate-800">No captures yet</h3>
        <p className="mt-1 max-w-md text-sm text-slate-500">
          JPEG and RAW files will appear here after a photographer finishes syncing this project.
        </p>
        <button
          type="button"
          onClick={() => void loadCaptures()}
          className="mt-5 inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className="size-4" /> Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-5">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Capture review</h3>
          <p className="mt-1 text-sm text-slate-500">
            {review.totals.captures} captures across {review.students.length} {isCorporate ? "employees" : "students"}.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadCaptures()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 border-b border-slate-200 bg-slate-50/70 px-6 py-4 sm:grid-cols-4">
        <Summary label="Paired" value={review.totals.complete} tone="emerald" />
        <Summary label="JPEG only" value={review.totals.jpegOnly} tone="amber" />
        <Summary label="RAW only" value={review.totals.rawOnly} tone="slate" />
        <Summary label="Total" value={review.totals.captures} tone="teal" />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="space-y-3">
          {review.students.map((student) => {
            const isExpanded = expanded.has(student.studentId);
            return (
              <section key={student.studentId} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => toggleStudent(student.studentId)}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-50"
                  aria-expanded={isExpanded}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    {isExpanded ? <ChevronDown className="size-4 shrink-0 text-slate-400" /> : <ChevronRight className="size-4 shrink-0 text-slate-400" />}
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-slate-900">{student.firstName} {student.lastName}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {student.className ?? "Unassigned"} · {student.generatedStudentId}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                    {student.captures.length} {student.captures.length === 1 ? "capture" : "captures"}
                  </span>
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-100 bg-slate-50/50 p-4">
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {student.captures.map((capture) => (
                        <CaptureCard key={capture.id} capture={capture} />
                      ))}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: number; tone: "emerald" | "amber" | "slate" | "teal" }) {
  const colors = {
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    slate: "text-slate-700",
    teal: "text-teal-700",
  };
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${colors[tone]}`}>{value}</p>
    </div>
  );
}

function CaptureCard({ capture }: { capture: Capture }) {
  const jpeg = capture.files.find((file) => file.fileRole === "JPEG");
  const raw = capture.files.find((file) => file.fileRole === "RAW");
  return (
    <article className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="relative aspect-[4/3] bg-slate-100">
        {jpeg ? (
          <img src={jpeg.url} alt={capture.baseFilename} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400">
            <CircleAlert className="size-7" />
            <span className="text-xs font-medium">JPEG not available</span>
          </div>
        )}
        <div className="absolute left-3 top-3 flex items-center gap-2">
          <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${statusClass(capture.pairingStatus)}`}>
            {statusLabel(capture.pairingStatus)}
          </span>
          {capture.favorite && <span className="rounded-full bg-amber-400 p-1 text-white" title="Favorite"><Star className="size-3 fill-current" /></span>}
        </div>
        {capture.rating > 0 && (
          <span className="absolute bottom-3 right-3 rounded-full bg-black/60 px-2 py-1 text-[10px] font-semibold text-white">
            {capture.rating}/5 · {capture.rejected ? "Rejected" : capture.selected ? "Selected" : "Reviewed"}
          </span>
        )}
      </div>
      <div className="space-y-3 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{capture.baseFilename}</p>
          <p className="text-xs text-slate-500">
            {capture.sequence ? `Sequence ${capture.sequence}` : "No sequence"} · {capture.capturedAt ? new Date(capture.capturedAt).toLocaleString() : "Capture time unavailable"}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {jpeg && <FileLink file={jpeg} label="Open JPEG" />}
          {raw && <FileLink file={raw} label="Open RAW" />}
        </div>
      </div>
    </article>
  );
}

function FileLink({ file, label }: { file: CaptureFile; label: string }) {
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-teal-300 hover:text-teal-700"
      title={`${file.originalFilename}${file.fileSize ? ` · ${formatFileSize(file.fileSize)}` : ""}`}
    >
      <Download className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}