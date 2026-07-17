import React from 'react';
import { Project } from '@workspace/api-client-react';
import { Download, FileArchive, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';

export function ExportsTab({ project }: { project: Project }) {
  
  const downloadZip = () => {
    window.location.href = `/api/projects/${project.id}/export/zip`;
  };

  const downloadPdf = () => {
    window.location.href = `/api/projects/${project.id}/export/pdf`;
  };

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h3 className="text-lg font-semibold text-slate-900 mb-2">Export Data</h3>
        <p className="text-sm text-slate-500 mb-6">
          Download QR codes and student data for photo day. Make sure to generate QR codes for all students before exporting.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* PDF Export */}
        <div className="border border-slate-200 rounded-xl p-6 bg-white hover:border-teal-200 hover:shadow-sm transition-all flex flex-col items-start">
          <div className="w-12 h-12 bg-red-50 text-red-600 rounded-xl flex items-center justify-center mb-4">
            <Download className="w-6 h-6" />
          </div>
          <h4 className="text-lg font-bold text-slate-900 mb-2">Camera Cards (PDF)</h4>
          <p className="text-sm text-slate-600 mb-6 flex-1">
            Printable PDF documents containing 4 QR codes per page. Designed to be handed to photographers and students on photo day.
          </p>
          <Button onClick={downloadPdf} className="w-full bg-slate-900 hover:bg-slate-800 text-white">
            Download PDF
          </Button>
        </div>

        {/* ZIP Export */}
        <div className="border border-slate-200 rounded-xl p-6 bg-white hover:border-teal-200 hover:shadow-sm transition-all flex flex-col items-start">
          <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center mb-4">
            <FileArchive className="w-6 h-6" />
          </div>
          <h4 className="text-lg font-bold text-slate-900 mb-2">Raw Assets (ZIP)</h4>
          <p className="text-sm text-slate-600 mb-6 flex-1">
            A ZIP archive containing individual PNG files for every QR code, organized by class folders, plus a master CSV file.
          </p>
          <Button onClick={downloadZip} className="w-full bg-slate-900 hover:bg-slate-800 text-white">
            Download ZIP
          </Button>
        </div>
      </div>

      <div className="pt-8 border-t border-slate-200">
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div>
            <h4 className="text-lg font-bold text-slate-900 mb-1 flex items-center gap-2">
              <QrCode className="w-5 h-5 text-teal-600" />
              Preview QR Codes
            </h4>
            <p className="text-sm text-slate-600">
              Visually inspect all generated QR codes before exporting. You can also download them individually.
            </p>
          </div>
          <Link href={`/projects/${project.id}/qr-preview`} className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-teal-200 text-teal-700 hover:bg-teal-50 bg-white h-10 px-4 py-2">
            Open Preview Grid
          </Link>
        </div>
      </div>

    </div>
  );
}
