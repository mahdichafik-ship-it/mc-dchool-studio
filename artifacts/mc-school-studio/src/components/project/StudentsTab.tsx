import React, { useState, useMemo } from 'react';
import { useListStudents, useBulkDeleteStudents, useGenerateQrCodes, getListStudentsQueryKey, Student, useListClasses } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Search, Trash2, QrCode, Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function StudentsTab({ projectId }: { projectId: number }) {
  const { data: students = [], isLoading: studentsLoading } = useListStudents(projectId);
  const { data: classes = [] } = useListClasses(projectId);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const bulkDelete = useBulkDeleteStudents();
  const generateQr = useGenerateQrCodes();

  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState<string>('all');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const filteredStudents = useMemo(() => {
    return students.filter(s => {
      const matchesSearch = 
        s.firstName.toLowerCase().includes(search.toLowerCase()) || 
        s.lastName.toLowerCase().includes(search.toLowerCase()) ||
        s.generatedStudentId.toLowerCase().includes(search.toLowerCase());
        
      const matchesClass = classFilter === 'all' || s.classId.toString() === classFilter;
      
      return matchesSearch && matchesClass;
    });
  }, [students, search, classFilter]);

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredStudents.length && filteredStudents.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredStudents.map(s => s.id)));
    }
  };

  const toggleSelect = (id: number) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    bulkDelete.mutate({ projectId, data: { studentIds: Array.from(selectedIds) } }, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListStudentsQueryKey(projectId) });
        setSelectedIds(new Set());
        setIsDeleteDialogOpen(false);
        toast({ title: `Deleted ${res.deleted} students` });
      }
    });
  };

  const handleGenerateQr = () => {
    const idsToGenerate = selectedIds.size > 0 ? Array.from(selectedIds) : undefined;
    generateQr.mutate({ projectId, data: { studentIds: idsToGenerate } }, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListStudentsQueryKey(projectId) });
        toast({ title: `Generated ${res.generated} QR codes` });
      }
    });
  };

  if (studentsLoading) return <div className="p-6">Loading students...</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row gap-4 justify-between bg-white flex-shrink-0">
        <div className="flex items-center gap-3 flex-1">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input 
              placeholder="Search students..." 
              className="pl-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Select value={classFilter} onValueChange={setClassFilter}>
            <SelectTrigger className="w-[180px]">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder="All Classes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Classes</SelectItem>
              {classes.map(c => (
                <SelectItem key={c.id} value={c.id.toString()}>{c.className}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(search || classFilter !== 'all') && (
            <Button variant="ghost" size="icon" onClick={() => { setSearch(''); setClassFilter('all'); }}>
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          {selectedIds.size > 0 && (
            <>
              <span className="text-sm font-medium text-slate-600">{selectedIds.size} selected</span>
              <Button variant="destructive" size="sm" onClick={() => setIsDeleteDialogOpen(true)}>
                <Trash2 className="w-4 h-4 mr-2" /> Delete
              </Button>
            </>
          )}
          <Button 
            variant="outline" 
            size="sm"
            onClick={handleGenerateQr}
            disabled={generateQr.isPending || (students.length === 0)}
            className="text-teal-700 border-teal-200 hover:bg-teal-50"
          >
            <QrCode className="w-4 h-4 mr-2" /> 
            {generateQr.isPending ? 'Generating...' : selectedIds.size > 0 ? 'Generate Selected QR' : 'Generate All QR'}
          </Button>
        </div>
      </div>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Students</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedIds.size} students? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleBulkDelete} variant="destructive" disabled={bulkDelete.isPending}>
              {bulkDelete.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 z-10 border-b border-slate-200">
            <tr>
              <th className="px-4 py-3 w-12">
                <Checkbox 
                  checked={selectedIds.size === filteredStudents.length && filteredStudents.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
              </th>
              <th className="px-4 py-3">Student ID</th>
              <th className="px-4 py-3">First Name</th>
              <th className="px-4 py-3">Last Name</th>
              <th className="px-4 py-3">Class</th>
              <th className="px-4 py-3 text-center">QR Code</th>
            </tr>
          </thead>
          <tbody>
            {filteredStudents.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No students found.
                </td>
              </tr>
            ) : (
              filteredStudents.map(student => (
                <tr key={student.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                  <td className="px-4 py-3">
                    <Checkbox 
                      checked={selectedIds.has(student.id)}
                      onCheckedChange={() => toggleSelect(student.id)}
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{student.generatedStudentId}</td>
                  <td className="px-4 py-3 font-medium text-slate-900">{student.firstName}</td>
                  <td className="px-4 py-3 font-medium text-slate-900">{student.lastName}</td>
                  <td className="px-4 py-3 text-slate-600">{student.className}</td>
                  <td className="px-4 py-3 text-center">
                    {student.simpleQr ? (
                      <div className="inline-flex w-8 h-8 items-center justify-center bg-teal-50 rounded">
                        <QrCode className="w-4 h-4 text-teal-600" />
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">Missing</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
