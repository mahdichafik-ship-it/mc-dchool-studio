import React, { useState } from 'react';
import {
  useListStudents,
  useListClasses,
  useGenerateQrCodes,
  getListStudentsQueryKey,
} from '@workspace/api-client-react';
import { useRoute, Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  UserPlus,
  RotateCcw,
  Archive,
  FileText,
  QrCode,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export default function ProjectQrPreview() {
  const [match, params] = useRoute('/projects/:projectId/qr-preview');
  const projectId =
    match && params?.projectId ? parseInt(params.projectId, 10) : null;

  const [selectedClassId, setSelectedClassId] = useState<number | 'all'>('all');
  const [qrFormat, setQrFormat] = useState<'simple' | 'json'>('simple');
  const [isZipping, setIsZipping] = useState(false);

  const { data: students = [], isLoading: studentsLoading } = useListStudents(
    projectId!,
    {
      query: {
        enabled: !!projectId,
        queryKey: getListStudentsQueryKey(projectId!),
      },
    },
  );

  const { data: classes = [] } = useListClasses(projectId!, {
    query: { enabled: !!projectId },
  });

  const generateQr = useGenerateQrCodes();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const filteredStudents =
    selectedClassId === 'all'
      ? students
      : students.filter((s) => s.classId === selectedClassId);

  const missingCount = students.filter((s) => !s.simpleQr).length;

  const handleGenerateAll = () => {
    generateQr.mutate(
      { projectId: projectId! },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({
            queryKey: getListStudentsQueryKey(projectId!),
          });
          toast({ title: `Generated ${res.generated} QR codes` });
        },
        onError: (err) => {
          toast({
            title: 'QR generation failed',
            description: String(err),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDownloadZip = async () => {
    const toZip = filteredStudents.filter((s) =>
      qrFormat === 'simple' ? s.simpleQr : s.jsonQr,
    );
    if (toZip.length === 0) {
      toast({ title: 'No QR codes to download. Generate them first.' });
      return;
    }

    setIsZipping(true);
    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      for (const student of toZip) {
        const dataUrl = qrFormat === 'simple' ? student.simpleQr! : student.jsonQr!;
        const base64 = dataUrl.split(',')[1];
        const safeName = `${student.firstName}_${student.lastName}_${student.generatedStudentId}`
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9_.-]/g, '');
        zip.file(`${safeName}.png`, base64, { base64: true });
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `qr-codes-${selectedClassId === 'all' ? 'all' : classes.find((c) => c.id === selectedClassId)?.className ?? 'class'}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: `Downloaded ${toZip.length} QR codes as ZIP` });
    } catch (e) {
      toast({ title: 'ZIP export failed', description: String(e), variant: 'destructive' });
    } finally {
      setIsZipping(false);
    }
  };

  const handleDownloadPdf = () => {
    // Open a print-friendly window with QR codes laid out in a grid
    const toPrint = filteredStudents.filter((s) =>
      qrFormat === 'simple' ? s.simpleQr : s.jsonQr,
    );
    if (toPrint.length === 0) {
      toast({ title: 'No QR codes to print. Generate them first.' });
      return;
    }

    const cards = toPrint
      .map((s) => {
        const qr = qrFormat === 'simple' ? s.simpleQr! : s.jsonQr!;
        return `<div style="display:inline-block;width:160px;margin:8px;text-align:center;page-break-inside:avoid">
          <img src="${qr}" style="width:140px;height:140px" />
          <div style="font-size:11px;font-weight:bold;margin-top:4px">${s.firstName} ${s.lastName}</div>
          <div style="font-size:10px;color:#666">${s.generatedStudentId}</div>
        </div>`;
      })
      .join('');

    const html = `<!DOCTYPE html><html><head><title>QR Codes</title><style>
      body{font-family:sans-serif;margin:16px}
      @media print{body{margin:0}}
    </style></head><body>
      <h2 style="margin-bottom:12px">QR Codes — ${toprint.length} students</h2>
      <div>${cards}</div>
      <script>window.onload=()=>window.print();<\/script>
    </body></html>`;

    const w = window.open('', '_blank');
    if (w) {
      w.document.write(html);
      w.document.close();
    }
  };

  if (studentsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#13131f] text-white">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#13131f] text-white">

      {/* ── Top bar ─────────────────────────────────── */}
      <div className="flex-shrink-0 px-6 py-2.5 bg-[#0d0d1a] border-b border-white/10 flex items-center gap-3">
        <Link
          href={`/projects/${projectId}`}
          className="flex items-center text-xs text-gray-400 hover:text-white transition-colors mr-2"
        >
          <ArrowLeft className="w-3.5 h-3.5 mr-1" />
          Back
        </Link>
        <span className="text-xs text-gray-500">QR Format:</span>
        <Select
          value={qrFormat}
          onValueChange={(v) => setQrFormat(v as 'simple' | 'json')}
        >
          <SelectTrigger className="h-7 text-xs w-56 bg-[#1e1e33] border-white/15 text-white focus:ring-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-[#1e1e33] border-white/15 text-white">
            <SelectItem value="simple">Simple (firstName.lastName.id)</SelectItem>
            <SelectItem value="json">JSON (full student data)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* ── Header ──────────────────────────────────── */}
      <div className="flex-shrink-0 px-8 pt-6 pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Manage QR Codes</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {students.length} students processed. Format:{' '}
            {qrFormat === 'simple' ? 'Plain Text (fn.ln.id)' : 'JSON'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {missingCount > 0 && (
            <Button
              size="sm"
              onClick={handleGenerateAll}
              disabled={generateQr.isPending}
              className="bg-teal-600 hover:bg-teal-700 text-white text-xs h-8"
            >
              <QrCode className="w-3.5 h-3.5 mr-1.5" />
              {generateQr.isPending
                ? 'Generating…'
                : `Generate ${missingCount} Missing`}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleGenerateAll}
            disabled={generateQr.isPending}
            className="bg-transparent border-white/20 text-gray-300 hover:text-white hover:bg-white/10 text-xs h-8"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Regenerate All
          </Button>
        </div>
      </div>

      {/* ── Class filter tabs ────────────────────────── */}
      <div className="flex-shrink-0 px-8 pb-3 flex flex-wrap gap-2">
        <button
          onClick={() => setSelectedClassId('all')}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
            selectedClassId === 'all'
              ? 'bg-blue-600 text-white'
              : 'bg-[#1e1e33] text-gray-300 hover:bg-[#252545] border border-white/10'
          }`}
        >
          All ({students.length})
        </button>
        {classes.map((cls) => {
          const count = students.filter((s) => s.classId === cls.id).length;
          return (
            <button
              key={cls.id}
              onClick={() => setSelectedClassId(cls.id)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                selectedClassId === cls.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#1e1e33] text-gray-300 hover:bg-[#252545] border border-white/10'
              }`}
            >
              {cls.className} ({count})
            </button>
          );
        })}
      </div>

      {/* ── Scrollable content ───────────────────────── */}
      <div className="flex-1 overflow-auto px-8 pb-8">
        {/* Export buttons */}
        <div className="flex justify-end gap-2 mb-4">
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownloadZip}
            disabled={isZipping}
            className="bg-transparent border-white/20 text-gray-300 hover:text-white hover:bg-white/10 text-xs h-8"
          >
            <Archive className="w-3.5 h-3.5 mr-1.5" />
            {isZipping ? 'Zipping…' : 'ZIP'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownloadPdf}
            className="bg-transparent border-white/20 text-gray-300 hover:text-white hover:bg-white/10 text-xs h-8"
          >
            <FileText className="w-3.5 h-3.5 mr-1.5" />
            PDF
          </Button>
        </div>

        {/* Student grid */}
        {filteredStudents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-500">
            <QrCode className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">No students in this class</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {filteredStudents.map((student) => (
              <div
                key={student.id}
                className="bg-[#1c1c30] border border-white/8 rounded-lg px-4 py-3 hover:bg-[#222240] transition-colors"
              >
                <p className="font-bold text-white text-sm uppercase tracking-wide leading-snug truncate">
                  {student.firstName} {student.lastName}
                </p>
                <p className="text-gray-400 text-xs mt-1 font-mono">
                  ID: {student.generatedStudentId}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
