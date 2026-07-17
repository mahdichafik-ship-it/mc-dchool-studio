import React from 'react';
import { useListStudents, useGenerateQrCodes, getListStudentsQueryKey } from '@workspace/api-client-react';
import { useRoute, Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

export default function ProjectQrPreview() {
  const [match, params] = useRoute('/projects/:projectId/qr-preview');
  const projectId = match && params?.projectId ? parseInt(params.projectId, 10) : null;

  const { data: students = [], isLoading } = useListStudents(projectId!, {
    query: { enabled: !!projectId, queryKey: getListStudentsQueryKey(projectId!) }
  });
  
  const generateQr = useGenerateQrCodes();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleGenerateAll = () => {
    generateQr.mutate({ projectId: projectId! }, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListStudentsQueryKey(projectId!) });
        toast({ title: `Generated ${res.generated} QR codes` });
      },
      onError: (err) => {
        toast({
          title: 'QR generation failed',
          description: String(err),
          variant: 'destructive',
        });
      },
    });
  };

  const handleDownloadSingle = (simpleQr: string, name: string) => {
    const a = document.createElement('a');
    a.href = simpleQr;
    a.download = `QR_${name.replace(/\s+/g, '_')}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (isLoading) {
    return <div className="p-8">Loading QR codes...</div>;
  }

  const missingCount = students.filter(s => !s.simpleQr).length;

  return (
    <div className="flex-1 overflow-auto bg-slate-50 flex flex-col min-h-0">
      <div className="px-8 py-6 bg-white border-b border-slate-200 flex-shrink-0 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <Link href={`/projects/${projectId}`} className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors mb-2">
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back to Project
            </Link>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">QR Code Preview</h1>
            <p className="text-slate-500 text-sm mt-1">{students.length} Total Students &bull; {missingCount} Missing QR</p>
          </div>
          <Button 
            onClick={handleGenerateAll} 
            disabled={generateQr.isPending || missingCount === 0}
            className="bg-teal-600 hover:bg-teal-700"
          >
            <QrCode className="w-4 h-4 mr-2" />
            {generateQr.isPending ? 'Generating...' : 'Generate Missing QR'}
          </Button>
        </div>
      </div>

      <div className="p-8 flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
            {students.map(student => (
              <div key={student.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col">
                <div className="aspect-square bg-slate-50 p-6 flex items-center justify-center relative border-b border-slate-100">
                  {student.simpleQr ? (
                    <img src={student.simpleQr} alt={`QR for ${student.firstName}`} className="w-full h-full object-contain" />
                  ) : (
                    <div className="text-slate-400 flex flex-col items-center">
                      <QrCode className="w-12 h-12 opacity-20 mb-2" />
                      <span className="text-xs font-medium uppercase tracking-wider">Not Generated</span>
                    </div>
                  )}
                  
                  {student.simpleQr && (
                    <button 
                      onClick={() => handleDownloadSingle(student.simpleQr!, `${student.firstName}_${student.lastName}`)}
                      className="absolute top-2 right-2 w-8 h-8 bg-white/90 backdrop-blur rounded-full flex items-center justify-center text-slate-700 hover:text-teal-600 hover:bg-white shadow-sm border border-slate-200/50 transition-colors"
                      title="Download PNG"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="font-bold text-slate-900 truncate">{student.firstName} {student.lastName}</h3>
                  <div className="mt-1 flex items-center justify-between text-xs">
                    <span className="text-slate-500 font-mono truncate">{student.generatedStudentId}</span>
                    <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-medium truncate ml-2 max-w-[50%]">{student.className}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
