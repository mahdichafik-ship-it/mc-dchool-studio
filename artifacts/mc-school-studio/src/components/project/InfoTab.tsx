import React, { useState } from 'react';
import { Project, useUpdateProject, getGetProjectQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Building, Calendar, Mail, MapPin, Phone, StickyNote, User } from 'lucide-react';

export function InfoTab({ project }: { project: Project }) {
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    schoolName: project.schoolName,
    photoDate: project.photoDate || '',
    address: project.address || '',
    contactName: project.contactName || '',
    contactEmail: project.contactEmail || '',
    contactPhone: project.contactPhone || '',
    notes: project.notes || '',
  });

  const updateProject = useUpdateProject();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    updateProject.mutate({
      projectId: project.id,
      data: {
        schoolName: formData.schoolName,
        photoDate: formData.photoDate || null,
        address: formData.address || null,
        contactName: formData.contactName || null,
        contactEmail: formData.contactEmail || null,
        contactPhone: formData.contactPhone || null,
        notes: formData.notes || null,
      }
    }, {
      onSuccess: () => {
        setIsEditing(false);
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(project.id) });
        toast({
          title: 'Project updated',
          description: 'Project information has been saved successfully.',
        });
      },
      onError: () => {
        toast({
          title: 'Error',
          description: 'Failed to update project.',
          variant: 'destructive',
        });
      }
    });
  };

  if (isEditing) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div className="grid grid-cols-1 gap-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">School Name</label>
            <Input 
              value={formData.schoolName} 
              onChange={e => setFormData({ ...formData, schoolName: e.target.value })} 
            />
          </div>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Photo Date <span className="text-slate-400 font-normal">(Optional)</span></label>
              <Input 
                type="date"
                value={formData.photoDate ? formData.photoDate.split('T')[0] : ''} 
                onChange={e => setFormData({ ...formData, photoDate: e.target.value })} 
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Address <span className="text-slate-400 font-normal">(Optional)</span></label>
              <Input 
                value={formData.address} 
                onChange={e => setFormData({ ...formData, address: e.target.value })} 
              />
            </div>
          </div>

          <div className="space-y-4 pt-4 border-t border-slate-100">
            <h3 className="text-sm font-medium text-slate-900">Contact Information</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <label className="text-xs text-slate-500">Name</label>
                <Input 
                  value={formData.contactName} 
                  onChange={e => setFormData({ ...formData, contactName: e.target.value })} 
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-slate-500">Email</label>
                <Input 
                  type="email"
                  value={formData.contactEmail} 
                  onChange={e => setFormData({ ...formData, contactEmail: e.target.value })} 
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-slate-500">Phone</label>
                <Input 
                  value={formData.contactPhone} 
                  onChange={e => setFormData({ ...formData, contactPhone: e.target.value })} 
                />
              </div>
            </div>
          </div>

          <div className="space-y-2 pt-4 border-t border-slate-100">
            <label className="text-sm font-medium text-slate-700">Notes</label>
            <Textarea 
              value={formData.notes} 
              onChange={e => setFormData({ ...formData, notes: e.target.value })} 
              className="min-h-[100px]"
            />
          </div>
        </div>

        <div className="flex gap-3 pt-4">
          <Button onClick={handleSave} disabled={updateProject.isPending} className="bg-teal-600 hover:bg-teal-700">
            {updateProject.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
          <Button variant="outline" onClick={() => setIsEditing(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl relative">
      <Button 
        variant="outline" 
        size="sm" 
        onClick={() => setIsEditing(true)}
        className="absolute top-0 right-0 text-slate-600"
      >
        Edit Info
      </Button>

      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2 mb-4">
            <Building className="w-5 h-5 text-teal-600" />
            General Information
          </h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-6 text-sm">
            <div>
              <dt className="text-slate-500 mb-1">School Name</dt>
              <dd className="font-medium text-slate-900">{project.schoolName}</dd>
            </div>
            <div>
              <dt className="text-slate-500 mb-1 flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" /> Photo Date</dt>
              <dd className="font-medium text-slate-900">{project.photoDate ? new Date(project.photoDate).toLocaleDateString() : '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-500 mb-1 flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> Address</dt>
              <dd className="font-medium text-slate-900">{project.address || '—'}</dd>
            </div>
          </dl>
        </div>

        <div className="pt-6 border-t border-slate-100">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2 mb-4">
            <User className="w-5 h-5 text-teal-600" />
            Contact Person
          </h3>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-6 text-sm">
            <div>
              <dt className="text-slate-500 mb-1">Name</dt>
              <dd className="font-medium text-slate-900">{project.contactName || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 mb-1 flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" /> Email</dt>
              <dd className="font-medium text-slate-900">{project.contactEmail ? <a href={`mailto:${project.contactEmail}`} className="text-teal-600 hover:underline">{project.contactEmail}</a> : '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 mb-1 flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> Phone</dt>
              <dd className="font-medium text-slate-900">{project.contactPhone || '—'}</dd>
            </div>
          </dl>
        </div>

        <div className="pt-6 border-t border-slate-100">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2 mb-4">
            <StickyNote className="w-5 h-5 text-teal-600" />
            Notes
          </h3>
          <div className="text-sm text-slate-700 whitespace-pre-wrap bg-slate-50 p-4 rounded-lg border border-slate-100 min-h-[100px]">
            {project.notes || <span className="text-slate-400 italic">No notes added.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
