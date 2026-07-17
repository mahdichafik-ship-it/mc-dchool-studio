import React, { useState } from 'react';
import { useListClasses, useCreateClass, useUpdateClass, useDeleteClass, getListClassesQueryKey, Class } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, MoreHorizontal, Edit2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from '@/hooks/use-toast';

export function ClassesTab({ projectId }: { projectId: number }) {
  const { data: classes = [], isLoading } = useListClasses(projectId);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createClass = useCreateClass();
  const updateClass = useUpdateClass();
  const deleteClass = useDeleteClass();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newClassName, setNewClassName] = useState('');

  const [editClassId, setEditClassId] = useState<number | null>(null);
  const [editClassName, setEditClassName] = useState('');

  const [deleteClassId, setDeleteClassId] = useState<number | null>(null);

  const handleCreate = () => {
    if (!newClassName.trim()) return;
    createClass.mutate({ projectId, data: { className: newClassName } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListClassesQueryKey(projectId) });
        setIsCreateOpen(false);
        setNewClassName('');
        toast({ title: 'Class created' });
      }
    });
  };

  const handleUpdate = () => {
    if (!editClassName.trim() || !editClassId) return;
    updateClass.mutate({ projectId, classId: editClassId, data: { className: editClassName } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListClassesQueryKey(projectId) });
        setEditClassId(null);
        toast({ title: 'Class updated' });
      }
    });
  };

  const handleDelete = () => {
    if (!deleteClassId) return;
    deleteClass.mutate({ projectId, classId: deleteClassId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListClassesQueryKey(projectId) });
        setDeleteClassId(null);
        toast({ title: 'Class deleted' });
      }
    });
  };

  if (isLoading) {
    return <div className="p-6">Loading classes...</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-white flex-shrink-0">
        <h2 className="font-semibold text-slate-900">Manage Classes</h2>
        
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="bg-teal-600 hover:bg-teal-700">
              <Plus className="w-4 h-4 mr-2" /> Add Class
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Class</DialogTitle>
              <DialogDescription>Enter the name of the new class.</DialogDescription>
            </DialogHeader>
            <Input 
              value={newClassName} 
              onChange={e => setNewClassName(e.target.value)} 
              placeholder="e.g. 1st Grade - Mrs. Smith"
              autoFocus
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createClass.isPending || !newClassName.trim()} className="bg-teal-600 hover:bg-teal-700">
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editClassId} onOpenChange={(open) => !open && setEditClassId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Class</DialogTitle>
          </DialogHeader>
          <Input 
            value={editClassName} 
            onChange={e => setEditClassName(e.target.value)} 
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditClassId(null)}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={updateClass.isPending || !editClassName.trim()} className="bg-teal-600 hover:bg-teal-700">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={!!deleteClassId} onOpenChange={(open) => !open && setDeleteClassId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Class</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this class? This will also delete all students within it. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteClassId(null)}>Cancel</Button>
            <Button onClick={handleDelete} variant="destructive" disabled={deleteClass.isPending}>
              {deleteClass.isPending ? 'Deleting...' : 'Delete Class'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex-1 overflow-auto p-4">
        {classes.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            No classes yet. Create one manually or import from a file.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {classes.map((cls) => (
              <div key={cls.id} className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex items-center justify-between group">
                <div>
                  <h4 className="font-medium text-slate-900">{cls.className}</h4>
                  <p className="text-sm text-slate-500">{cls.studentCount} students</p>
                </div>
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => {
                      setEditClassId(cls.id);
                      setEditClassName(cls.className);
                    }}>
                      <Edit2 className="w-4 h-4 mr-2" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      className="text-red-600 focus:text-red-600" 
                      onClick={() => setDeleteClassId(cls.id)}
                    >
                      <Trash2 className="w-4 h-4 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
