import React, { useState, useRef } from 'react';
import { useRoute, Link, useLocation } from 'wouter';
import { useParseImportFile, useConfirmImport, ParseResult, SheetMapping } from '@workspace/api-client-react';
import { ArrowLeft, Upload, FileText, CheckCircle2, ChevronRight, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { getListStudentsQueryKey, getListClassesQueryKey, getGetProjectQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';

type Step = 'upload' | 'map' | 'confirm' | 'done';

export default function ProjectImport() {
  const [match, params] = useRoute('/projects/:projectId/import');
  const projectId = match && params?.projectId ? parseInt(params.projectId, 10) : null;
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const parseFile = useParseImportFile();
  const confirmImport = useConfirmImport();

  const [step, setStep] = useState<Step>('upload');
  
  // State from Upload
  const [file, setFile] = useState<File | null>(null);
  const [csvClassName, setCsvClassName] = useState<string>('');
  
  // State from Parse
  const [parsedData, setParsedData] = useState<ParseResult | null>(null);
  
  // State from Map
  const [mappings, setMappings] = useState<Record<string, {
    className: string;
    firstNameColumn: string;
    lastNameColumn: string;
    studentIdColumn: string;
    emailColumn: string;
    phoneColumn: string;
  }>>({});

  // State from Confirm
  const [importResult, setImportResult] = useState<{ classesCreated: number, studentsCreated: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleUploadSubmit = () => {
    if (!file || !projectId) return;

    if (file.name.endsWith('.csv') && !csvClassName) {
      toast({ title: 'Class name required for CSV files', variant: 'destructive' });
      return;
    }

    parseFile.mutate({ projectId, data: { file, csvClassName: csvClassName || undefined } }, {
      onSuccess: (data) => {
        setParsedData(data);
        
        // Initialize default mappings
        const initialMappings: typeof mappings = {};
        data.sheets.forEach(sheet => {
          // Try to guess columns
          const lowerHeaders = sheet.headers.map(h => h.toLowerCase());
          const guessFn = (...keywords: string[]) => sheet.headers.find((_, i) => keywords.some(k => lowerHeaders[i].includes(k))) || '';
          const guessLast = (...keywords: string[]) => sheet.headers.find((_, i) => keywords.some(k => lowerHeaders[i].includes(k))) || '';
          
          initialMappings[sheet.name] = {
            className: file.name.endsWith('.csv') ? csvClassName : sheet.name,
            firstNameColumn: guessFn('first', 'prenom', 'prénom'),
            lastNameColumn: guessLast('last', 'nom', 'surname'),
            studentIdColumn: guessFn('id', 'student', 'matricule', 'numero'),
            emailColumn: guessFn('email', 'mail', 'courriel'),
            phoneColumn: guessFn('phone', 'tel', 'mobile', 'gsm', 'portable'),
          };
        });
        setMappings(initialMappings);
        setStep('map');
      },
      onError: (err) => {
        toast({ title: 'Failed to parse file', description: String(err), variant: 'destructive' });
      }
    });
  };

  const handleConfirmMapping = () => {
    // Validate mappings
    for (const sheet of parsedData?.sheets || []) {
      const map = mappings[sheet.name];
      if (!map.firstNameColumn || !map.lastNameColumn || !map.className) {
        toast({ title: `Missing required mapping for sheet "${sheet.name}"`, variant: 'destructive' });
        return;
      }
    }
    setStep('confirm');
  };

  const handleExecuteImport = async () => {
    if (!file || !projectId || !parsedData) return;
    
    try {
      // Re-parse the full file client-side to get all rows
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      
      const sheetsData: SheetMapping[] = [];

      for (const sheetPreview of parsedData.sheets) {
        const worksheet = workbook.Sheets[sheetPreview.name];
        if (!worksheet) continue;
        
        // Convert to array of arrays
        const rawData = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, defval: "" });
        
        // Find header row (using the headers from preview to locate it)
        const headerRowIndex = rawData.findIndex(row => 
          sheetPreview.headers.every(h => row.includes(h))
        );
        
        const startRow = headerRowIndex !== -1 ? headerRowIndex + 1 : 1;
        const rows = rawData.slice(startRow).map(r => r.map(String));
        const map = mappings[sheetPreview.name];

        sheetsData.push({
          sheetName: sheetPreview.name,
          className: map.className,
          firstNameColumn: map.firstNameColumn,
          lastNameColumn: map.lastNameColumn,
          studentIdColumn: map.studentIdColumn || null,
          emailColumn: map.emailColumn || null,
          phoneColumn: map.phoneColumn || null,
          rows: rows,
          headers: sheetPreview.headers
        });
      }

      confirmImport.mutate({ projectId, data: { sheets: sheetsData } }, {
        onSuccess: (res) => {
          setImportResult(res);
          setStep('done');
          queryClient.invalidateQueries({ queryKey: getListStudentsQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListClassesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        },
        onError: (err) => {
          toast({ title: 'Import failed', description: String(err), variant: 'destructive' });
        }
      });
      
    } catch (err) {
      toast({ title: 'Error reading file for import', description: String(err), variant: 'destructive' });
    }
  };

  const updateMapping = (sheetName: string, field: keyof typeof mappings[string], value: string) => {
    setMappings(prev => ({
      ...prev,
      [sheetName]: {
        ...prev[sheetName],
        [field]: value
      }
    }));
  };

  return (
    <div className="flex-1 overflow-auto bg-slate-50 flex flex-col min-h-0">
      <div className="px-8 py-6 bg-white border-b border-slate-200 flex-shrink-0">
        <div className="max-w-5xl mx-auto">
          <Link href={`/projects/${projectId}`} className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors mb-2">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Project
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Import Students</h1>
          
          <div className="mt-6 flex items-center max-w-2xl">
            <StepIndicator current={step} name="upload" label="1. Upload" />
            <div className={`h-px flex-1 mx-4 ${step !== 'upload' ? 'bg-teal-600' : 'bg-slate-200'}`} />
            <StepIndicator current={step} name="map" label="2. Map Columns" />
            <div className={`h-px flex-1 mx-4 ${step === 'confirm' || step === 'done' ? 'bg-teal-600' : 'bg-slate-200'}`} />
            <StepIndicator current={step} name="confirm" label="3. Confirm" />
            <div className={`h-px flex-1 mx-4 ${step === 'done' ? 'bg-teal-600' : 'bg-slate-200'}`} />
            <StepIndicator current={step} name="done" label="4. Done" />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-5xl mx-auto">
          
          {step === 'upload' && (
            <Card className="border-slate-200 shadow-sm max-w-xl">
              <CardContent className="p-8">
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">Upload Roster File</h3>
                    <p className="text-sm text-slate-500">
                      Upload an Excel (.xlsx) or CSV file. Excel files with multiple sheets will create multiple classes automatically.
                    </p>
                  </div>

                  <div 
                    className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${file ? 'border-teal-500 bg-teal-50' : 'border-slate-300 hover:border-teal-400 bg-slate-50'}`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      className="hidden" 
                      accept=".xlsx,.csv"
                      onChange={handleFileChange}
                    />
                    <Upload className={`w-10 h-10 mx-auto mb-4 ${file ? 'text-teal-600' : 'text-slate-400'}`} />
                    <div className="text-sm font-medium text-slate-900 mb-1">
                      {file ? file.name : 'Click to upload or drag and drop'}
                    </div>
                    <div className="text-xs text-slate-500">
                      {file ? `${(file.size / 1024).toFixed(1)} KB` : 'XLSX or CSV up to 10MB'}
                    </div>
                  </div>

                  {file?.name.endsWith('.csv') && (
                    <div className="space-y-2">
                      <Label>Class Name for this CSV</Label>
                      <Input 
                        value={csvClassName} 
                        onChange={e => setCsvClassName(e.target.value)} 
                        placeholder="e.g. Grade 1"
                      />
                      <p className="text-xs text-slate-500">Since CSV files don't have sheet names, provide a class name.</p>
                    </div>
                  )}

                  <div className="flex justify-end pt-4">
                    <Button 
                      onClick={handleUploadSubmit} 
                      disabled={!file || parseFile.isPending}
                      className="bg-teal-600 hover:bg-teal-700 w-full sm:w-auto"
                    >
                      {parseFile.isPending ? 'Reading file...' : 'Next Step'} <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 'map' && parsedData && (
            <div className="space-y-8">
              {parsedData.sheets.map((sheet, index) => (
                <Card key={index} className="border-slate-200 shadow-sm overflow-hidden">
                  <div className="bg-slate-50 border-b border-slate-200 px-6 py-4 flex items-center justify-between">
                    <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                      <FileText className="w-4 h-4 text-teal-600" />
                      Sheet: {sheet.name}
                    </h3>
                    <div className="flex items-center gap-3">
                      <Label className="text-xs text-slate-500">Target Class:</Label>
                      <Input 
                        className="w-48 h-8 text-sm"
                        value={mappings[sheet.name]?.className || ''} 
                        onChange={e => updateMapping(sheet.name, 'className', e.target.value)}
                      />
                    </div>
                  </div>
                  <CardContent className="p-0">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6 border-b border-slate-100 bg-white">
                      <div className="space-y-2">
                        <Label className="text-red-500 flex items-center gap-1">First Name Column *</Label>
                        <Select value={mappings[sheet.name]?.firstNameColumn} onValueChange={v => updateMapping(sheet.name, 'firstNameColumn', v)}>
                          <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                          <SelectContent>
                            {sheet.headers.map((h, i) => <SelectItem key={`fn-${i}`} value={h}>{h || `(column ${i + 1})`}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-red-500 flex items-center gap-1">Last Name Column *</Label>
                        <Select value={mappings[sheet.name]?.lastNameColumn} onValueChange={v => updateMapping(sheet.name, 'lastNameColumn', v)}>
                          <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                          <SelectContent>
                            {sheet.headers.map((h, i) => <SelectItem key={`ln-${i}`} value={h}>{h || `(column ${i + 1})`}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-slate-500">Student ID Column <span className="text-slate-400 font-normal">(Optional)</span></Label>
                        <Select value={mappings[sheet.name]?.studentIdColumn || 'none'} onValueChange={v => updateMapping(sheet.name, 'studentIdColumn', v === 'none' ? '' : v)}>
                          <SelectTrigger><SelectValue placeholder="-- Skip --" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">-- Skip --</SelectItem>
                            {sheet.headers.map((h, i) => <SelectItem key={`sid-${i}`} value={h}>{h || `(column ${i + 1})`}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-slate-500">Email Column <span className="text-slate-400 font-normal">(Optional)</span></Label>
                        <Select value={mappings[sheet.name]?.emailColumn || 'none'} onValueChange={v => updateMapping(sheet.name, 'emailColumn', v === 'none' ? '' : v)}>
                          <SelectTrigger><SelectValue placeholder="-- Skip --" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">-- Skip --</SelectItem>
                            {sheet.headers.map((h, i) => <SelectItem key={`em-${i}`} value={h}>{h || `(column ${i + 1})`}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-slate-500">Phone Column <span className="text-slate-400 font-normal">(Optional)</span></Label>
                        <Select value={mappings[sheet.name]?.phoneColumn || 'none'} onValueChange={v => updateMapping(sheet.name, 'phoneColumn', v === 'none' ? '' : v)}>
                          <SelectTrigger><SelectValue placeholder="-- Skip --" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">-- Skip --</SelectItem>
                            {sheet.headers.map((h, i) => <SelectItem key={`ph-${i}`} value={h}>{h || `(column ${i + 1})`}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    
                    <div className="p-6 bg-slate-50/50">
                      <Label className="text-xs text-slate-500 mb-2 block">Data Preview (First 3 rows)</Label>
                      <div className="border border-slate-200 rounded-md overflow-x-auto bg-white">
                        <table className="w-full text-xs text-left">
                          <thead className="bg-slate-50 border-b border-slate-200">
                            <tr>
                              {sheet.headers.map((h, i) => (
                                <th key={i} className="px-3 py-2 font-medium text-slate-600 whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sheet.rows.slice(0, 3).map((row, rIdx) => (
                              <tr key={rIdx} className="border-b border-slate-100 last:border-0">
                                {sheet.headers.map((_, cIdx) => (
                                  <td key={cIdx} className="px-3 py-2 text-slate-600 whitespace-nowrap">{row[cIdx]}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}

              <div className="flex justify-end gap-3 pt-4">
                <Button variant="outline" onClick={() => setStep('upload')}>Back</Button>
                <Button onClick={handleConfirmMapping} className="bg-teal-600 hover:bg-teal-700">
                  Review Import <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {step === 'confirm' && parsedData && (
            <Card className="border-slate-200 shadow-sm max-w-xl">
              <CardContent className="p-8 text-center">
                <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6">
                  <AlertCircle className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-2">Ready to Import</h3>
                <p className="text-slate-600 mb-8">
                  You are about to create <strong className="text-slate-900">{parsedData.sheets.length}</strong> classes from this file. 
                  Existing students with matching details may be skipped or duplicated depending on exact matches.
                </p>

                <div className="bg-slate-50 rounded-lg p-4 text-left mb-8 space-y-2 border border-slate-100">
                  {parsedData.sheets.map((sheet, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="text-slate-600 font-medium">{mappings[sheet.name]?.className}</span>
                      <span className="text-slate-400">from sheet "{sheet.name}"</span>
                    </div>
                  ))}
                </div>

                <div className="flex justify-center gap-3">
                  <Button variant="outline" onClick={() => setStep('map')}>Review Mappings</Button>
                  <Button 
                    onClick={handleExecuteImport} 
                    disabled={confirmImport.isPending}
                    className="bg-teal-600 hover:bg-teal-700"
                  >
                    {confirmImport.isPending ? 'Importing...' : 'Confirm & Import Data'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {step === 'done' && importResult && (
            <Card className="border-teal-200 shadow-sm max-w-xl bg-teal-50/30">
              <CardContent className="p-8 text-center">
                <div className="w-20 h-20 bg-teal-100 text-teal-600 rounded-full flex items-center justify-center mx-auto mb-6">
                  <CheckCircle2 className="w-10 h-10" />
                </div>
                <h3 className="text-2xl font-bold text-slate-900 mb-2">Import Complete!</h3>
                <p className="text-slate-600 mb-8 text-lg">
                  Successfully imported data into the project.
                </p>

                <div className="grid grid-cols-2 gap-4 mb-8">
                  <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                    <div className="text-3xl font-bold text-slate-900 mb-1">{importResult.classesCreated}</div>
                    <div className="text-sm font-medium text-slate-500">Classes Created</div>
                  </div>
                  <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                    <div className="text-3xl font-bold text-slate-900 mb-1">{importResult.studentsCreated}</div>
                    <div className="text-sm font-medium text-slate-500">Students Imported</div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row justify-center gap-3">
                  <Link href={`/projects/${projectId}`} className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2 w-full sm:w-auto">
                    View Project
                  </Link>
                  <Link href={`/projects/${projectId}/qr-preview`} className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-teal-600 text-primary-foreground hover:bg-teal-700 h-10 px-4 py-2 w-full sm:w-auto">
                    Generate QR Codes
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}

        </div>
      </div>
    </div>
  );
}

function StepIndicator({ current, name, label }: { current: Step, name: Step, label: string }) {
  const isDone = 
    (name === 'upload' && current !== 'upload') ||
    (name === 'map' && (current === 'confirm' || current === 'done')) ||
    (name === 'confirm' && current === 'done');
  
  const isActive = current === name;
  
  return (
    <div className={`flex flex-col items-center gap-2 ${isActive ? 'text-teal-600' : isDone ? 'text-teal-600' : 'text-slate-400'}`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${isActive ? 'bg-teal-600 text-white shadow-md shadow-teal-200' : isDone ? 'bg-teal-100' : 'bg-slate-100'}`}>
        {isDone ? <CheckCircle2 className="w-5 h-5" /> : label.split('.')[0]}
      </div>
      <span className="text-xs font-semibold whitespace-nowrap">{label.split(' ')[1]}</span>
    </div>
  );
}
