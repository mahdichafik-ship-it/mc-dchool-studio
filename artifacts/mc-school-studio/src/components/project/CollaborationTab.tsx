import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, Users } from 'lucide-react';

type BatchStatus = 'uploading' | 'failed' | 'complete';

type CollaborationData = {
  summary: {
    expectedStudents: number;
    photographedStudents: number;
    completionPercent: number;
    missingStudents: number;
    totalCaptures: number;
    duplicateStudentCount: number;
    failedFiles: number;
    unbatchedFiles: number;
    pairing: { complete: number; jpegOnly: number; rawOnly: number; pending: number };
  };
  assignments: Array<{
    memberId: number;
    displayName: string | null;
    email: string;
    role: string;
    status: string;
    batchCount: number;
    latestBatchStatus: BatchStatus | 'not_started';
  }>;
  batches: Array<{
    id: number;
    memberId: number;
    displayName: string | null;
    email: string;
    deviceName: string;
    status: BatchStatus;
    expectedFileCount: number;
    uploadedFileCount: number;
    failedFileCount: number;
    lastSyncAt: string;
  }>;
  completionGate: {
    ready: boolean;
    allBatchesComplete: boolean;
    failedUploadsResolved: boolean;
    duplicatesReviewed: boolean;
    pairsComplete: boolean;
    missingStudentsAcknowledged: boolean;
  };
};

const statusLabel: Record<BatchStatus | 'not_started', string> = {
  uploading: 'Uploading',
  failed: 'Needs retry',
  complete: 'Complete',
  not_started: 'Not started',
};

function StatusBadge({ status }: { status: BatchStatus | 'not_started' }) {
  const style = status === 'complete'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : status === 'failed'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-amber-50 text-amber-700 border-amber-200';
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}>{statusLabel[status]}</span>;
}

export function CollaborationTab({ projectId }: { projectId: number }) {
  const [data, setData] = useState<CollaborationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/collaboration`);
      if (!response.ok) throw new Error('Could not load collaboration status');
      setData(await response.json() as CollaborationData);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load collaboration status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [projectId]);

  if (loading) return <div className="p-8 text-sm text-slate-500">Loading collaboration status…</div>;
  if (error || !data) return <div className="p-8 text-sm text-rose-700">{error ?? 'Collaboration status is unavailable.'}</div>;

  const gateRows = [
    ['All photographer batches complete', data.completionGate.allBatchesComplete],
    ['Failed uploads resolved', data.completionGate.failedUploadsResolved],
    ['Duplicate captures reviewed', data.completionGate.duplicatesReviewed],
    ['JPEG/RAW pairs complete', data.completionGate.pairsComplete],
    ['Missing students acknowledged', data.completionGate.missingStudentsAcknowledged],
  ] as const;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Collaborative project uploads</h2>
          <p className="mt-1 text-sm text-slate-500">Each photographer uploads an independent batch into this shared project.</p>
        </div>
        <button onClick={() => void load()} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Project progress</p><p className="mt-2 text-3xl font-bold text-slate-900">{data.summary.completionPercent}%</p><p className="mt-1 text-sm text-slate-500">{data.summary.photographedStudents} of {data.summary.expectedStudents} students</p></div>
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Complete pairs</p><p className="mt-2 text-3xl font-bold text-slate-900">{data.summary.pairing.complete}</p><p className="mt-1 text-sm text-slate-500">{data.summary.pairing.jpegOnly + data.summary.pairing.rawOnly} incomplete pairs</p></div>
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Needs review</p><p className="mt-2 text-3xl font-bold text-slate-900">{data.summary.duplicateStudentCount}</p><p className="mt-1 text-sm text-slate-500">students with duplicate captures</p></div>
        <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Upload issues</p><p className="mt-2 text-3xl font-bold text-slate-900">{data.summary.failedFiles}</p><p className="mt-1 text-sm text-slate-500">{data.summary.unbatchedFiles} files from older app versions</p></div>
      </div>

      <section className="rounded-xl border border-slate-200">
        <div className="border-b border-slate-200 px-5 py-4"><h3 className="flex items-center gap-2 font-semibold text-slate-900"><Users className="h-4 w-4 text-teal-600" /> Assigned photographers</h3></div>
        {data.assignments.length === 0 ? <p className="p-5 text-sm text-slate-500">No photographers are assigned yet. Assign them from Team.</p> : (
          <div className="divide-y divide-slate-100">
            {data.assignments.map((assignment) => <div key={assignment.memberId} className="flex items-center justify-between gap-4 px-5 py-4">
              <div><p className="font-medium text-slate-900">{assignment.displayName || assignment.email}</p><p className="text-sm capitalize text-slate-500">{assignment.role} · {assignment.batchCount} {assignment.batchCount === 1 ? 'batch' : 'batches'}</p></div>
              <StatusBadge status={assignment.latestBatchStatus} />
            </div>)}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200">
        <div className="border-b border-slate-200 px-5 py-4"><h3 className="font-semibold text-slate-900">Capture batches</h3></div>
        {data.batches.length === 0 ? <p className="p-5 text-sm text-slate-500">Batches appear here after a photographer chooses Upload &amp; Finish in the Mac app.</p> : (
          <div className="divide-y divide-slate-100">
            {data.batches.map((batch) => <div key={batch.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_auto_auto] md:items-center">
              <div><p className="font-medium text-slate-900">{batch.displayName || batch.email}</p><p className="text-sm text-slate-500">{batch.deviceName} · synced {new Date(batch.lastSyncAt).toLocaleString()}</p></div>
              <p className="text-sm text-slate-600">{batch.uploadedFileCount} / {batch.expectedFileCount} files{batch.failedFileCount ? ` · ${batch.failedFileCount} failed` : ''}</p>
              <StatusBadge status={batch.status} />
            </div>)}
          </div>
        )}
      </section>

      <section className={`rounded-xl border p-5 ${data.completionGate.ready ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
        <h3 className="flex items-center gap-2 font-semibold text-slate-900">{data.completionGate.ready ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <AlertTriangle className="h-5 w-5 text-amber-600" />} Project completion gate</h3>
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {gateRows.map(([label, complete]) => <div key={label} className="flex items-center gap-2 text-sm text-slate-700">{complete ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Clock3 className="h-4 w-4 text-amber-600" />}{label}</div>)}
        </div>
      </section>
    </div>
  );
}