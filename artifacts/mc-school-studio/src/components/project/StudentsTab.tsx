import React, { useState, useMemo, useEffect } from 'react';
import { useListStudents, useBulkDeleteStudents, useGenerateQrCodes, getListStudentsQueryKey, Student, useListClasses, useCreateStudent, useUpdateStudent } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Search, Trash2, QrCode, Filter, X, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

const studentSchema = z.object({
  classId: z.coerce.number().min(1, "Required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  generatedStudentId: z.string().optional(),
  email: z.string().email("Invalid email").or(z.literal("")).optional(),
  secondaryEmail: z.string().email("Invalid email").or(z.literal("")).optional(),
  phone: z.string().optional(),
  jobTitle: z.string().optional(),
  officeLocation: z.string().optional(),
  photoSession: z.string().optional(),
  captureNotes: z.string().optional(),
});

type StudentFormValues = z.infer<typeof studentSchema>;

export function StudentsTab({ projectId, isCorporate }: { projectId: number, isCorporate?: boolean }) {
  const { data: students = [], isLoading: studentsLoading } = useListStudents(projectId);
  const { data: classes = [] } = useListClasses(projectId);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const bulkDelete = useBulkDeleteStudents();
  const generateQr = useGenerateQrCodes();
  const createStudent = useCreateStudent();
  const updateStudent = useUpdateStudent();

  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState<string>('all');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);

  const form = useForm<StudentFormValues>({
    resolver: zodResolver(studentSchema),
    defaultValues: {
      classId: undefined,
      firstName: "",
      lastName: "",
      generatedStudentId: "",
      email: "",
      secondaryEmail: "",
      phone: "",
      jobTitle: "",
      officeLocation: "",
      photoSession: "",
      captureNotes: "",
    },
  });

  useEffect(() => {
    if (editingStudent && isFormOpen) {
      form.reset({
        classId: editingStudent.classId,
        firstName: editingStudent.firstName,
        lastName: editingStudent.lastName,
        generatedStudentId: editingStudent.generatedStudentId || "",
        email: editingStudent.email || "",
        secondaryEmail: editingStudent.secondaryEmail || "",
        phone: editingStudent.phone || "",
        jobTitle: editingStudent.jobTitle || "",
        officeLocation: editingStudent.officeLocation || "",
        photoSession: editingStudent.photoSession || "",
        captureNotes: editingStudent.captureNotes || "",
      });
    } else if (!isFormOpen) {
      form.reset({
        classId: classes[0]?.id,
        firstName: "",
        lastName: "",
        generatedStudentId: "",
        email: "",
        secondaryEmail: "",
        phone: "",
        jobTitle: "",
        officeLocation: "",
        photoSession: "",
        captureNotes: "",
      });
      setEditingStudent(null);
    }
  }, [editingStudent, isFormOpen, form, classes]);

  const onFormSubmit = (data: StudentFormValues) => {
    // clean empty strings to null/undefined if necessary
    const payload = {
      ...data,
      generatedStudentId: data.generatedStudentId || null,
      email: data.email || null,
      secondaryEmail: data.secondaryEmail || null,
      phone: data.phone || null,
      jobTitle: data.jobTitle || null,
      officeLocation: data.officeLocation || null,
      photoSession: data.photoSession || null,
      captureNotes: data.captureNotes || null,
    };

    if (editingStudent) {
      updateStudent.mutate({ projectId, studentId: editingStudent.id, data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListStudentsQueryKey(projectId) });
          setIsFormOpen(false);
          toast({ title: `${isCorporate ? 'Employee' : 'Student'} updated` });
        },
        onError: (err) => {
          toast({ title: 'Failed to update', description: String(err), variant: 'destructive' });
        }
      });
    } else {
      createStudent.mutate({ projectId, data: payload }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListStudentsQueryKey(projectId) });
          setIsFormOpen(false);
          toast({ title: `${isCorporate ? 'Employee' : 'Student'} added` });
        },
        onError: (err) => {
          toast({ title: 'Failed to add', description: String(err), variant: 'destructive' });
        }
      });
    }
  };

  const filteredStudents = useMemo(() => {
    return students.filter(s => {
      const searchStr = search.toLowerCase();
      const matchesSearch = 
        s.firstName.toLowerCase().includes(searchStr) ||
        s.lastName.toLowerCase().includes(searchStr) ||
        (s.generatedStudentId && s.generatedStudentId.toLowerCase().includes(searchStr)) ||
        (s.email && s.email.toLowerCase().includes(searchStr)) ||
        (s.secondaryEmail && s.secondaryEmail.toLowerCase().includes(searchStr)) ||
        (s.phone && s.phone.toLowerCase().includes(searchStr)) ||
        (s.jobTitle && s.jobTitle.toLowerCase().includes(searchStr)) ||
        (s.officeLocation && s.officeLocation.toLowerCase().includes(searchStr)) ||
        (s.photoSession && s.photoSession.toLowerCase().includes(searchStr)) ||
        (s.captureNotes && s.captureNotes.toLowerCase().includes(searchStr));
        
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
        toast({ title: `Deleted ${res.deleted} ${isCorporate ? 'employees' : 'students'}` });
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

  if (studentsLoading) return <div className="p-6">Loading {isCorporate ? 'employees' : 'students'}...</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row gap-4 justify-between bg-white flex-shrink-0">
        <div className="flex items-center gap-3 flex-1">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input 
              placeholder={isCorporate ? "Search employees..." : "Search students..."}
              className="pl-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Select value={classFilter} onValueChange={setClassFilter}>
            <SelectTrigger className="w-[180px]">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder={isCorporate ? "All Departments" : "All Classes"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{isCorporate ? "All Departments" : "All Classes"}</SelectItem>
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
        
        <div className="flex flex-wrap items-center gap-3">
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
          <Button
            size="sm"
            className="bg-teal-600 hover:bg-teal-700 text-white"
            onClick={() => setIsFormOpen(true)}
          >
            <Plus className="w-4 h-4 mr-2" />
            Add {isCorporate ? 'Employee' : 'Student'}
          </Button>
        </div>
      </div>

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingStudent ? 'Edit' : 'Add'} {isCorporate ? 'Employee' : 'Student'}</DialogTitle>
            <DialogDescription>
              {isCorporate ? 'Update employee directory information and contact details.' : 'Update student roster information and contact details.'}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onFormSubmit)} className="space-y-4 py-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="firstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name *</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="lastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name *</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="classId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{isCorporate ? 'Department' : 'Class'} *</FormLabel>
                      <Select value={field.value?.toString()} onValueChange={(val) => field.onChange(parseInt(val, 10))}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {classes.map(c => (
                            <SelectItem key={c.id} value={c.id.toString()}>{c.className}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="generatedStudentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{isCorporate ? 'Employee ID' : 'Student ID'}</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{isCorporate ? 'Primary Delivery Email' : 'Parent/Guardian Email'}</FormLabel>
                      <FormControl><Input type="email" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="secondaryEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{isCorporate ? 'Secondary Delivery Email' : 'Second Parent/Guardian Email'}</FormLabel>
                      <FormControl><Input type="email" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl><Input type="tel" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {isCorporate && (
                  <FormField
                    control={form.control}
                    name="jobTitle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Job Title</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>

              {isCorporate && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="officeLocation"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Office/Location</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="photoSession"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Appointment time</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="captureNotes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Capture Notes</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}

              <DialogFooter className="sticky bottom-0 z-10 mt-6 border-t border-slate-200 bg-white py-4">
                <Button type="button" variant="outline" onClick={() => setIsFormOpen(false)}>Cancel</Button>
                <Button type="submit" className="bg-teal-600 hover:bg-teal-700" disabled={createStudent.isPending || updateStudent.isPending}>
                  {editingStudent ? 'Save Changes' : `Add ${isCorporate ? 'Employee' : 'Student'}`}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {isCorporate ? 'Employees' : 'Students'}</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedIds.size} {isCorporate ? 'employees' : 'students'}? This cannot be undone.
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
              <th className="px-4 py-3">{isCorporate ? 'Employee ID' : 'Student ID'}</th>
              <th className="px-4 py-3">First Name</th>
              <th className="px-4 py-3">Last Name</th>
              <th className="px-4 py-3">{isCorporate ? 'Department' : 'Class'}</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3 text-center">QR Code</th>
              <th className="sticky right-0 bg-slate-50 px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredStudents.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                  No {isCorporate ? 'employees' : 'students'} found.
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
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {student.email && <div>{student.email}</div>}
                    {student.phone && <div>{student.phone}</div>}
                    {!student.email && !student.phone && <span className="text-slate-400 italic">None</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {student.simpleQr ? (
                      <div className="inline-flex w-8 h-8 items-center justify-center bg-teal-50 rounded">
                        <QrCode className="w-4 h-4 text-teal-600" />
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">Missing</span>
                    )}
                  </td>
                  <td className="sticky right-0 bg-white px-4 py-3 text-right group-hover:bg-slate-50">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditingStudent(student);
                        setIsFormOpen(true);
                      }}
                      className="text-slate-400 hover:text-teal-600"
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
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
