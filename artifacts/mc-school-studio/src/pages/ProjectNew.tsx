import React from 'react';
import { useLocation, Link } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useCreateProject, getListProjectsQueryKey, useListStudioPriceSheets } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const projectSchema = z.object({
  projectType: z.enum(['school', 'corporate']),
  schoolName: z.string().min(1, 'Name is required'),
  priceSheetId: z.coerce.number().min(1, 'Price sheet is required'),
  photoDate: z.string().optional(),
  address: z.string().optional(),
  contactName: z.string().optional(),
  contactEmail: z.string().email('Invalid email address').optional().or(z.literal('')),
  contactPhone: z.string().optional(),
  notes: z.string().optional(),
});

type ProjectFormValues = z.infer<typeof projectSchema>;

export default function ProjectNew() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  
  const { data: priceSheets, isLoading: isLoadingPriceSheets } = useListStudioPriceSheets();

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      projectType: 'school',
      schoolName: '',
      priceSheetId: 0,
      photoDate: '',
      address: '',
      contactName: '',
      contactEmail: '',
      contactPhone: '',
      notes: '',
    },
  });

  const isCorporate = form.watch('projectType') === 'corporate';

  const onSubmit = (data: ProjectFormValues) => {
    // Convert empty strings to undefined for optional fields
    const payload = {
      projectType: data.projectType,
      schoolName: data.schoolName,
      priceSheetId: data.priceSheetId,
      photoDate: data.photoDate || undefined,
      address: data.address || undefined,
      contactName: data.contactName || undefined,
      contactEmail: data.contactEmail || undefined,
      contactPhone: data.contactPhone || undefined,
      notes: data.notes || undefined,
    };

    createProject.mutate({ data: payload }, {
      onSuccess: (project) => {
        queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        setLocation(`/projects/${project.id}`);
      }
    });
  };

  const hasNoPriceSheets = !isLoadingPriceSheets && (!priceSheets || priceSheets.length === 0);

  return (
    <div className="flex-1 overflow-auto bg-slate-50 p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <Link href="/dashboard" className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors mb-4">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Dashboard
          </Link>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">New Project</h1>
          <p className="text-slate-500 mt-1">Create a new photography project.</p>
        </div>

        <Card className="border-slate-200">
          <CardHeader>
            <CardTitle>Project Details</CardTitle>
            <CardDescription>Basic information about the project and event date.</CardDescription>
          </CardHeader>
          <CardContent>
            {hasNoPriceSheets ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 flex flex-col items-center text-center">
                <AlertCircle className="w-10 h-10 text-amber-500 mb-3" />
                <h3 className="text-lg font-semibold text-amber-900">No Price Sheets Found</h3>
                <p className="text-amber-700 mt-1 mb-5 max-w-md">
                  You need at least one price sheet to create a project. Price sheets define the products and prices offered to customers.
                </p>
                <Button asChild className="bg-amber-600 hover:bg-amber-700 text-white">
                  <Link href="/price-sheets">Create a Price Sheet</Link>
                </Button>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  
                  <FormField
                    control={form.control}
                    name="projectType"
                    render={({ field }) => (
                      <FormItem className="space-y-3">
                        <FormLabel>Project Type</FormLabel>
                        <FormControl>
                          <RadioGroup
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                            className="flex flex-col space-y-1 sm:flex-row sm:space-x-4 sm:space-y-0"
                          >
                            <FormItem className="flex items-center space-x-3 space-y-0">
                              <FormControl>
                                <RadioGroupItem value="school" />
                              </FormControl>
                              <FormLabel className="font-normal cursor-pointer">
                                School Photography
                              </FormLabel>
                            </FormItem>
                            <FormItem className="flex items-center space-x-3 space-y-0">
                              <FormControl>
                                <RadioGroupItem value="corporate" />
                              </FormControl>
                              <FormLabel className="font-normal cursor-pointer">
                                Corporate Headshots
                              </FormLabel>
                            </FormItem>
                          </RadioGroup>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <FormField
                      control={form.control}
                      name="schoolName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{isCorporate ? 'Company Name' : 'School Name'} <span className="text-red-500">*</span></FormLabel>
                          <FormControl>
                            <Input placeholder={isCorporate ? 'e.g. Acme Corp' : 'e.g. Lincoln High School'} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="priceSheetId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Price Sheet <span className="text-red-500">*</span></FormLabel>
                          <Select
                            onValueChange={(val) => field.onChange(Number(val))}
                            value={field.value ? String(field.value) : undefined}
                          >
                            <FormControl>
                              <SelectTrigger disabled={isLoadingPriceSheets}>
                                <SelectValue placeholder={isLoadingPriceSheets ? "Loading..." : "Select a price sheet"} />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {priceSheets?.map((sheet) => (
                                <SelectItem key={sheet.id} value={String(sheet.id)}>
                                  {sheet.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <FormField
                      control={form.control}
                      name="photoDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{isCorporate ? 'Headshot Date' : 'Photo Date'} <span className="text-slate-400 font-normal">(Optional)</span></FormLabel>
                          <FormControl>
                            <Input type="date" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="address"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{isCorporate ? 'Company Address' : 'School Address'} <span className="text-slate-400 font-normal">(Optional)</span></FormLabel>
                          <FormControl>
                            <Input placeholder="123 Main St..." {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="space-y-4 pt-4 border-t border-slate-100">
                    <h3 className="text-sm font-medium text-slate-900">Contact Information (Optional)</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <FormField
                        control={form.control}
                        name="contactName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Name</FormLabel>
                            <FormControl>
                              <Input placeholder="Jane Doe" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="contactEmail"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Email</FormLabel>
                            <FormControl>
                              <Input type="email" placeholder="jane@school.edu" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="contactPhone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Phone</FormLabel>
                            <FormControl>
                              <Input placeholder="(555) 123-4567" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Internal Notes</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="Any special requirements for this shoot..." 
                            className="resize-none h-24"
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex justify-end pt-4">
                    <Button 
                      type="button" 
                      variant="outline" 
                      className="mr-3"
                      onClick={() => setLocation('/dashboard')}
                    >
                      Cancel
                    </Button>
                    <Button 
                      type="submit" 
                      className="bg-teal-600 hover:bg-teal-700 text-white"
                      disabled={createProject.isPending || !form.formState.isValid}
                    >
                      {createProject.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...
                        </>
                      ) : (
                        'Create Project'
                      )}
                    </Button>
                  </div>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
