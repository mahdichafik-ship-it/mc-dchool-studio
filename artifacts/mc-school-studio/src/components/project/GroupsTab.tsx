import React, { useState, useMemo, useEffect } from 'react';
import { 
  useListGroups, useCreateGroup, useUpdateGroup, useDeleteGroup, 
  useReplaceGroupMembers, useRemoveGroupMembers, getListGroupsQueryKey,
  useListStudents, useListClasses, Group, Student, Class
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Trash2, Edit2, Users, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';

export function GroupsTab({ projectId, isCorporate }: { projectId: number, isCorporate?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const { data: groups = [], isLoading: groupsLoading } = useListGroups(projectId, { query: { queryKey: getListGroupsQueryKey(projectId) } });
  const { data: students = [] } = useListStudents(projectId);
  const { data: classes = [] } = useListClasses(projectId);
  
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupClassId, setNewGroupClassId] = useState<string>('none');
  
  const createGroup = useCreateGroup();
  
  const handleCreate = () => {
    if (!newGroupName.trim()) return;
    createGroup.mutate({
      projectId,
      data: {
        name: newGroupName.trim(),
        classId: newGroupClassId === 'none' ? null : parseInt(newGroupClassId, 10),
      }
    }, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey(projectId) });
        setIsCreateOpen(false);
        setNewGroupName('');
        setNewGroupClassId('none');
        setSelectedGroupId(res.id);
        toast({ title: "Group created successfully" });
      }
    });
  };

  const selectedGroup = groups.find(g => g.id === selectedGroupId);

  const filteredGroups = useMemo(() => {
    return groups.filter(g => g.name.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [groups, searchQuery]);

  return (
    <div className="flex flex-col md:flex-row h-full w-full">
      {/* LEFT PANEL: GROUP LIST */}
      <div className="w-full md:w-80 border-r border-slate-200 bg-slate-50/50 flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-slate-200 flex flex-col gap-3 bg-white">
          <Button onClick={() => setIsCreateOpen(true)} className="w-full bg-teal-600 hover:bg-teal-700 text-white shadow-sm">
            <Plus className="w-4 h-4 mr-2" /> Create Group
          </Button>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input 
              placeholder="Search groups..." 
              className="pl-9 bg-white"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {groupsLoading ? (
            <div className="p-4 text-sm text-slate-500 text-center">Loading groups...</div>
          ) : filteredGroups.length === 0 ? (
            <div className="p-4 text-sm text-slate-500 text-center">
              {searchQuery ? "No groups match your search." : "No groups found. Create one!"}
            </div>
          ) : (
            filteredGroups.map(g => (
              <div 
                key={g.id} 
                onClick={() => setSelectedGroupId(g.id)}
                className={`p-3 mb-1 rounded-md border cursor-pointer transition-colors ${
                  selectedGroupId === g.id 
                    ? 'bg-teal-50 border-teal-200 shadow-sm' 
                    : 'bg-white border-transparent hover:border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="font-medium text-sm text-slate-900 flex items-center justify-between">
                  <span className="truncate pr-2">{g.name}</span>
                  {g.isDefaultClassGroup && (
                    <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                      {isCorporate ? 'Dept' : 'Class'}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-1.5 flex items-center gap-2">
                  <span className="flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" />
                    {g.members?.length || 0}
                  </span>
                  {g.classId && (
                    <>
                      <span className="text-slate-300">•</span>
                      <span className="truncate text-slate-600">{classes.find(c => c.id === g.classId)?.className || (isCorporate ? 'Dept' : 'Class')}</span>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* RIGHT PANEL: GROUP DETAILS */}
      <div className="flex-1 flex flex-col bg-white min-w-0">
        {selectedGroup ? (
          <GroupDetail 
            projectId={projectId} 
            group={selectedGroup} 
            students={students} 
            classes={classes} 
            onDelete={() => setSelectedGroupId(null)}
            isCorporate={isCorporate}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50/30">
            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4 border border-slate-200 shadow-sm">
              <Users className="w-8 h-8 text-slate-400" />
            </div>
            <h3 className="text-lg font-medium text-slate-900 mb-1">No Group Selected</h3>
            <p className="text-sm max-w-sm text-slate-500">Select a group from the sidebar to view its members or create a new custom group.</p>
          </div>
        )}
      </div>

      {/* CREATE DIALOG */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Custom Group</DialogTitle>
            <DialogDescription>
              Create a custom group to organize specific {isCorporate ? 'employees' : 'students'} (e.g., {isCorporate ? 'Execs, IT Support' : 'Debate Team, Staff'}).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Group Name</Label>
              <Input 
                id="name" 
                value={newGroupName} 
                onChange={(e) => setNewGroupName(e.target.value)} 
                placeholder={isCorporate ? "e.g. Executives" : "e.g. Chess Club"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="class">Attach to {isCorporate ? 'Department' : 'Class'} (Optional)</Label>
              <Select value={newGroupClassId} onValueChange={setNewGroupClassId}>
                <SelectTrigger id="class">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {classes.map(c => (
                    <SelectItem key={c.id} value={c.id.toString()}>{c.className}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[13px] text-slate-500">
                Attaching a {isCorporate ? 'department' : 'class'} makes it easier to filter {isCorporate ? 'employees' : 'students'} when adding members.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleCreate} 
              disabled={!newGroupName.trim() || createGroup.isPending}
              className="bg-teal-600 hover:bg-teal-700 text-white"
            >
              {createGroup.isPending ? 'Creating...' : 'Create Group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GroupDetail({ projectId, group, students, classes, onDelete, isCorporate }: { projectId: number, group: Group, students: Student[], classes: Class[], onDelete: () => void, isCorporate?: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const updateGroup = useUpdateGroup();
  const deleteGroup = useDeleteGroup();
  const removeMembers = useRemoveGroupMembers();
  
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  
  const [isManageMembersOpen, setIsManageMembersOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');

  useEffect(() => {
    setMemberSearch('');
  }, [group.id]);

  const handleRename = () => {
    if (!renameValue.trim() || renameValue === group.name) {
      setIsRenameOpen(false);
      return;
    }
    updateGroup.mutate({
      projectId,
      groupId: group.id,
      data: { name: renameValue.trim() }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey(projectId) });
        setIsRenameOpen(false);
        toast({ title: "Group renamed" });
      }
    });
  };

  const handleDelete = () => {
    deleteGroup.mutate({
      projectId,
      groupId: group.id
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey(projectId) });
        onDelete();
        setIsDeleteOpen(false);
        toast({ title: "Group deleted" });
      }
    });
  };

  const handleRemoveMember = (studentId: number) => {
    removeMembers.mutate({
      projectId,
      groupId: group.id,
      data: { studentIds: [studentId] }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey(projectId) });
        toast({ title: "Member removed" });
      }
    });
  };

  const memberStudentIds = new Set(group.members.map(m => m.studentId).filter((id): id is number => id !== undefined));
  const memberStudents = useMemo(() => {
    return students
      .filter(s => memberStudentIds.has(s.id))
      .filter(s => {
        if (!memberSearch) return true;
        const term = memberSearch.toLowerCase();
        return s.firstName.toLowerCase().includes(term) || 
               s.lastName.toLowerCase().includes(term) ||
               s.generatedStudentId.toLowerCase().includes(term);
      })
      .sort((a, b) => a.lastName.localeCompare(b.lastName));
  }, [students, memberStudentIds, memberSearch]);

  const groupClass = group.classId ? classes.find(c => c.id === group.classId) : null;

  return (
    <div className="flex flex-col h-full bg-white">
      {/* HEADER */}
      <div className="p-6 border-b border-slate-200 flex-shrink-0">
        <div className="flex justify-between items-start mb-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold tracking-tight text-slate-900">{group.name}</h2>
              {!group.isDefaultClassGroup && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-teal-600 hover:bg-teal-50" onClick={() => { setRenameValue(group.name); setIsRenameOpen(true); }}>
                  <Edit2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-4 mt-2 text-sm text-slate-500 font-medium">
              <span className="flex items-center gap-1.5"><Users className="w-4 h-4" /> {group.members?.length || 0} Members</span>
              {groupClass && <span className="flex items-center gap-1.5">{isCorporate ? 'Department' : 'Class'}: {groupClass.className}</span>}
            </div>
          </div>
          {!group.isDefaultClassGroup && (
            <Button variant="outline" size="sm" className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700" onClick={() => setIsDeleteOpen(true)}>
              <Trash2 className="h-4 w-4 mr-2" /> Delete Group
            </Button>
          )}
        </div>

        {group.isDefaultClassGroup && (
          <div className="bg-slate-50 text-slate-800 p-3 rounded-md text-sm flex gap-3 items-start border border-slate-200">
            <Info className="w-5 h-5 flex-shrink-0 mt-0.5 text-slate-500" />
            <div>
              <p className="font-semibold text-slate-900">Automatic {isCorporate ? 'Department' : 'Class'} Group</p>
              <p className="text-slate-600 mt-0.5">This group is maintained automatically based on {isCorporate ? 'department' : 'class'} membership. You cannot rename or delete it, but you can adjust members manually if an override is required.</p>
            </div>
          </div>
        )}
      </div>

      {/* MEMBERS LIST */}
      <div className="flex-1 flex flex-col min-h-0 bg-white">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input 
              placeholder="Search members..." 
              className="pl-9 h-9 text-sm"
              value={memberSearch}
              onChange={e => setMemberSearch(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={() => setIsManageMembersOpen(true)} className="bg-teal-600 hover:bg-teal-700 text-white shadow-sm">
            <Users className="w-4 h-4 mr-2" /> Manage Members
          </Button>
        </div>

        <div className="flex-1 overflow-auto">
          {memberStudents.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">
              {memberSearch ? "No members match your search." : "This group currently has no members."}
            </div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-slate-500 uppercase bg-slate-50 sticky top-0 z-10 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 font-medium">{isCorporate ? 'Employee Name' : 'Student Name'}</th>
                  <th className="px-6 py-3 font-medium">{isCorporate ? 'Employee ID' : 'Student ID'}</th>
                  <th className="px-6 py-3 font-medium">{isCorporate ? 'Department' : 'Class'}</th>
                  <th className="px-6 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {memberStudents.map(student => (
                  <tr key={student.id} className="border-b border-slate-100 hover:bg-slate-50 group/row">
                    <td className="px-6 py-3 font-medium text-slate-900">
                      {student.firstName} {student.lastName}
                    </td>
                    <td className="px-6 py-3 font-mono text-xs text-slate-500">{student.generatedStudentId}</td>
                    <td className="px-6 py-3 text-slate-600">{student.className}</td>
                    <td className="px-6 py-3 text-right">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="text-slate-400 hover:text-red-600 hover:bg-red-50 h-8 px-2 opacity-0 group-hover/row:opacity-100 transition-opacity"
                        onClick={() => handleRemoveMember(student.id)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* MODALS */}
      <Dialog open={isRenameOpen} onOpenChange={setIsRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Group</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="rename">Group Name</Label>
            <Input 
              id="rename" 
              value={renameValue} 
              onChange={e => setRenameValue(e.target.value)} 
              className="mt-2"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRenameOpen(false)}>Cancel</Button>
            <Button onClick={handleRename} disabled={!renameValue.trim() || updateGroup.isPending} className="bg-teal-600 text-white hover:bg-teal-700">
              {updateGroup.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Group</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the group "{group.name}"? This action cannot be undone. 
              {isCorporate ? 'Employees' : 'Students'} themselves will not be deleted, only their membership in this group.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteGroup.isPending}>
              {deleteGroup.isPending ? 'Deleting...' : 'Delete Group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isManageMembersOpen && (
        <ManageMembersDialog 
          projectId={projectId} 
          group={group} 
          students={students} 
          classes={classes}
          open={isManageMembersOpen} 
          onOpenChange={setIsManageMembersOpen} 
          isCorporate={isCorporate}
        />
      )}
    </div>
  );
}

function ManageMembersDialog({ projectId, group, students, classes, open, onOpenChange, isCorporate }: {
  projectId: number, 
  group: Group, 
  students: Student[], 
  classes: Class[], 
  open: boolean, 
  onOpenChange: (open: boolean) => void,
  isCorporate?: boolean
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const replaceMembers = useReplaceGroupMembers();

  const initialMemberIds = useMemo(() => new Set(group.members.map(m => m.studentId).filter((id): id is number => id !== undefined)), [group.members]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(initialMemberIds);
  
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState<string>(group.classId ? group.classId.toString() : 'all');

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

  const handleToggle = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleSave = () => {
    replaceMembers.mutate({
      projectId,
      groupId: group.id,
      data: { studentIds: Array.from(selectedIds) }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListGroupsQueryKey(projectId) });
        onOpenChange(false);
        toast({ title: "Group members updated successfully" });
      }
    });
  };

  const toggleSelectAll = () => {
    const allFilteredIds = filteredStudents.map(s => s.id);
    const allSelected = allFilteredIds.every(id => selectedIds.has(id));
    
    const next = new Set(selectedIds);
    if (allSelected && allFilteredIds.length > 0) {
      allFilteredIds.forEach(id => next.delete(id));
    } else {
      allFilteredIds.forEach(id => next.add(id));
    }
    setSelectedIds(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <div className="p-6 pb-4 border-b border-slate-100 flex-shrink-0 bg-white">
          <DialogHeader>
            <DialogTitle className="text-xl">Manage Members: {group.name}</DialogTitle>
            <DialogDescription className="text-slate-500">
              Select {isCorporate ? 'employees' : 'students'} to include in this group. You have <strong className="text-slate-900">{selectedIds.size}</strong> {isCorporate ? 'employees' : 'students'} selected total.
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex gap-3 mt-4">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <Input 
                placeholder={isCorporate ? "Search employees..." : "Search students..."}
                className="pl-9 h-9"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <Select value={classFilter} onValueChange={setClassFilter}>
              <SelectTrigger className="w-[200px] h-9">
                <SelectValue placeholder={isCorporate ? "All Departments" : "All Classes"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{isCorporate ? "All Departments" : "All Classes"}</SelectItem>
                {classes.map(c => (
                  <SelectItem key={c.id} value={c.id.toString()}>{c.className}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-slate-50 px-6 py-4">
          <div className="border border-slate-200 rounded-lg overflow-hidden bg-white shadow-sm">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 w-12 text-center bg-slate-50">
                    <Checkbox 
                      checked={filteredStudents.length > 0 && filteredStudents.every(s => selectedIds.has(s.id))}
                      onCheckedChange={toggleSelectAll}
                    />
                  </th>
                  <th className="px-4 py-3 bg-slate-50 font-semibold">{isCorporate ? 'Employee Name' : 'Student Name'}</th>
                  <th className="px-4 py-3 bg-slate-50 font-semibold">{isCorporate ? 'Employee ID' : 'Student ID'}</th>
                  <th className="px-4 py-3 bg-slate-50 font-semibold">{isCorporate ? 'Department' : 'Class'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredStudents.length === 0 ? (
                  <tr><td colSpan={4} className="p-8 text-center text-slate-500">No {isCorporate ? 'employees' : 'students'} match your filters.</td></tr>
                ) : (
                  filteredStudents.map(student => (
                    <tr 
                      key={student.id} 
                      className={`hover:bg-slate-50 cursor-pointer transition-colors ${selectedIds.has(student.id) ? 'bg-teal-50/30' : ''}`}
                      onClick={() => handleToggle(student.id)}
                    >
                      <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
                        <Checkbox 
                          checked={selectedIds.has(student.id)}
                          onCheckedChange={() => handleToggle(student.id)}
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">{student.firstName} {student.lastName}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">{student.generatedStudentId}</td>
                      <td className="px-4 py-3 text-slate-600">{student.className}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="p-4 border-t border-slate-200 flex justify-end gap-3 flex-shrink-0 bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-20">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={replaceMembers.isPending} className="bg-teal-600 hover:bg-teal-700 text-white">
            {replaceMembers.isPending ? 'Saving...' : 'Save Members'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
