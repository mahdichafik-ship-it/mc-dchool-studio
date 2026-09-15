import React, { useState } from 'react';
import { Project } from '@workspace/api-client-react';
import { Download, FileArchive, QrCode, MonitorDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';

export function ExportsTab({ project, isCorporate }: { project: Project, isCorporate?: boolean }) {
  const [captureMode, setCaptureMode] = useState('paired');
  
  const downloadZip = () => {
    window.location.href = `/api/projects/${project.id}/export/zip`;
  };

  const downloadPdf = () => {
    window.location.href = `/api/projects/${project.id}/export/pdf`;
  };

  const downloadDesktopJson = () => {
    window.location.href = `/api/projects/${project.id}/export/json`;
  };

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h3 className="text-lg font-semibold text-slate-900 mb-2">Export Data</h3>
        <p className="text-sm text-slate-500 mb-6">
          Download QR codes and {isCorporate ? 'employee' : 'student'} data for {isCorporate ? 'headshot day' : 'photo day'}. Make sure to generate QR codes for all {isCorporate ? 'employees' : 'students'} before exporting.
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
            Printable PDF documents containing 4 QR codes per page. Designed to be handed to photographers and {isCorporate ? 'employees' : 'students'} on {isCorporate ? 'headshot day' : 'photo day'}.
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
            A ZIP archive containing individual PNG files for every QR code, organized by {isCorporate ? 'department' : 'class'} folders, plus a master CSV file.
          </p>
          <Button onClick={downloadZip} className="w-full bg-slate-900 hover:bg-slate-800 text-white">
            Download ZIP
          </Button>
        </div>
      </div>

      {/* Desktop Export */}
      <div className="pt-4 border-t border-slate-200">
        <div className="border border-teal-200 bg-teal-50 rounded-xl p-6 flex flex-col sm:flex-row items-center justify-between gap-6">
          <div>
            <h4 className="text-lg font-bold text-slate-900 mb-1 flex items-center gap-2">
              <MonitorDown className="w-5 h-5 text-teal-600" />
              Export for Desktop App
            </h4>
            <p className="text-sm text-slate-600">
              Download a JSON file to import into the Volume Capture desktop app. Use this on {isCorporate ? 'headshot day' : 'photo day'} to automatically match tethered photos to {isCorporate ? 'employees' : 'students'} via QR code.
            </p>
          </div>
          <Button onClick={downloadDesktopJson} className="shrink-0">
            <MonitorDown className="w-4 h-4" />
            Export for Desktop
          </Button>
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
        <div className="border border-slate-200 rounded-xl bg-white p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h4 className="text-lg font-bold text-slate-900 mb-1 flex items-center gap-2">
                <Download className="w-5 h-5 text-teal-600" />
                Export captures
              </h4>
              <p className="text-sm text-slate-600">
                Download the JPEG and RAW files currently visible to this project account. Files stay grouped by {isCorporate ? 'employee' : 'student'} and capture sequence.
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-56">
              <label htmlFor="capture-export-mode" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Capture filter
              </label>
              <select
                id="capture-export-mode"
                value={captureMode}
                onChange={(event) => setCaptureMode(event.target.value)}
                className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
              >
                <option value="paired">Paired JPEG + RAW</option>
                <option value="jpeg_only">JPEG only</option>
                <option value="raw_only">RAW only</option>
                <option value="selected">Selected</option>
                <option value="favorite">Favorites</option>
                <option value="final_selection">Final selection</option>
                <option value="all">All captures</option>
              </select>
            </div>
          </div>
          <Button
            onClick={() => {
              window.location.href = `/api/projects/${project.id}/captures/export?mode=${encodeURIComponent(captureMode)}`;
            }}
            className="mt-5 bg-teal-600 text-white hover:bg-teal-700"
          >
            <Download className="w-4 h-4" />
            Download capture ZIP
          </Button>
        </div>
      </div>

      <div className="pt-4 border-t border-slate-200">
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
