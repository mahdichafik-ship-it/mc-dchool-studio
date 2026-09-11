import React, { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { 
  useListStudioPriceSheets, 
  useCreateStudioPriceSheet, 
  useUpdateStudioPriceSheet,
  getListStudioPriceSheetsQueryKey,
  type DeliveryOffer
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Save, Trash2, Tag, Copy, FileText, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function PriceSheets() {
  const { data: priceSheets, isLoading } = useListStudioPriceSheets();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const createMutation = useCreateStudioPriceSheet();
  const updateMutation = useUpdateStudioPriceSheet();

  const [selectedSheetId, setSelectedSheetId] = useState<number | "new">("new");
  const [sheetName, setSheetName] = useState("");
  const [offers, setOffers] = useState<DeliveryOffer[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  // Sync state when selection changes or data loads
  useEffect(() => {
    if (!priceSheets) return;

    if (selectedSheetId === "new") {
      setSheetName("");
      setOffers([]);
    } else {
      const sheet = priceSheets.find(s => s.id === selectedSheetId);
      if (sheet) {
        setSheetName(sheet.name);
        // Ensure offers have valid IDs if missing (fallback for older data)
        setOffers(sheet.offers.map(o => ({ ...o, id: o.id || crypto.randomUUID() })) || []);
      }
    }
  }, [selectedSheetId, priceSheets]);

  // Set default selection to the first sheet if available and currently on "new"
  useEffect(() => {
    if (priceSheets && priceSheets.length > 0 && selectedSheetId === "new" && !sheetName) {
      setSelectedSheetId(priceSheets[0].id);
    }
  }, [priceSheets, selectedSheetId, sheetName]);

  const addOffer = () => {
    setOffers([
      ...offers,
      {
        id: crypto.randomUUID(),
        name: "",
        productType: "digital",
        unitAmount: 0,
        currency: "usd",
        paymentMethods: ["stripe", "establishment", "bank_transfer"],
        photoCount: 1,
        deliveryMethods: ["digital"],
        active: true,
        includesDigitalDownloads: true,
      },
    ]);
  };

  const updateOffer = (id: string, updates: Partial<DeliveryOffer>) => {
    setOffers(offers.map((o) => (o.id === id ? { ...o, ...updates } : o)));
  };

  const removeOffer = (id: string) => {
    setOffers(offers.filter((o) => o.id !== id));
  };

  const duplicateOffer = (offer: DeliveryOffer) => {
    const newOffer = { ...offer, id: crypto.randomUUID(), name: `${offer.name} (Copy)` };
    setOffers([...offers, newOffer]);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!sheetName.trim()) {
      toast({ title: "Error", description: "Price sheet name is required.", variant: "destructive" });
      return;
    }

    if (offers.length === 0) {
      toast({ title: "Error", description: "Please add at least one offer.", variant: "destructive" });
      return;
    }

    if (offers.some(o => !o.name.trim() || o.unitAmount < 0 || !/^[A-Za-z]{3}$/.test(o.currency) || o.photoCount < 1 || o.paymentMethods.length < 1 || o.deliveryMethods.length < 1)) {
      toast({ 
        title: "Validation Error", 
        description: "Please complete all required fields for each offer. Make sure you've selected at least one delivery and payment method.", 
        variant: "destructive" 
      });
      return;
    }

    try {
      if (selectedSheetId === "new") {
        const newSheet = await createMutation.mutateAsync({
          data: { name: sheetName, offers }
        });
        setSelectedSheetId(newSheet.id);
        toast({ title: "Success", description: "Price sheet created successfully." });
      } else {
        await updateMutation.mutateAsync({
          priceSheetId: selectedSheetId,
          data: { name: sheetName, offers }
        });
        toast({ title: "Success", description: "Price sheet updated successfully." });
      }
      queryClient.invalidateQueries({ queryKey: getListStudioPriceSheetsQueryKey() });
    } catch (err) {
      toast({ title: "Error", description: "Failed to save price sheet. Please try again.", variant: "destructive" });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isEditing = selectedSheetId !== "new";

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-50">
      <div className="border-b bg-white px-8 py-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Price Sheets</h1>
            <p className="text-slate-500 mt-1">
              Manage your product offerings and pricing. Price sheets can be assigned to multiple projects.
            </p>
          </div>
          <Button 
            onClick={() => setSelectedSheetId("new")}
            variant={selectedSheetId === "new" ? "secondary" : "default"}
            className={selectedSheetId !== "new" ? "bg-teal-600 hover:bg-teal-700 text-white" : ""}
          >
            <Plus className="w-4 h-4 mr-2" />
            New Price Sheet
          </Button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="max-w-6xl w-full mx-auto flex flex-col md:flex-row h-full">
          {/* Sidebar list */}
          <div className="w-full md:w-64 lg:w-80 border-r border-slate-200 bg-white flex flex-col">
            <div className="p-4 border-b border-slate-100 bg-slate-50/50">
              <h3 className="font-medium text-sm text-slate-700">Your Price Sheets</h3>
            </div>
            <ScrollArea className="flex-1">
              {isLoading ? (
                <div className="p-8 text-center text-sm text-slate-500 flex flex-col items-center">
                  <Loader2 className="w-5 h-5 animate-spin mb-2" />
                  Loading...
                </div>
              ) : priceSheets?.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  No price sheets found. Create one to get started.
                </div>
              ) : (
                <div className="p-2 space-y-1">
                  {priceSheets?.map((sheet) => (
                    <button
                      key={sheet.id}
                      onClick={() => setSelectedSheetId(sheet.id)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-md text-left transition-colors ${
                        selectedSheetId === sheet.id 
                          ? "bg-teal-50 text-teal-900 font-medium" 
                          : "text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      <div className="flex items-center truncate">
                        <FileText className={`w-4 h-4 mr-2 flex-shrink-0 ${selectedSheetId === sheet.id ? "text-teal-600" : "text-slate-400"}`} />
                        <span className="truncate">{sheet.name}</span>
                      </div>
                      <ChevronRight className={`w-4 h-4 flex-shrink-0 ${selectedSheetId === sheet.id ? "text-teal-600" : "text-slate-300"}`} />
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Main Editor */}
          <div className="flex-1 overflow-auto bg-slate-50">
            <div className="p-6 lg:p-8 max-w-4xl mx-auto">
              <form onSubmit={handleSave} className="space-y-6">
                <Card className="border-slate-200 shadow-sm overflow-hidden">
                  <div className="border-b border-slate-100 bg-white px-6 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex-1">
                      <Label htmlFor="sheetName" className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1 block">
                        Price Sheet Name
                      </Label>
                      <Input
                        id="sheetName"
                        value={sheetName}
                        onChange={(e) => setSheetName(e.target.value)}
                        placeholder="e.g. Fall Portraits 2024"
                        className="text-lg font-semibold h-12 border-slate-200 focus-visible:ring-teal-500"
                        required
                      />
                    </div>
                    <div className="flex items-center gap-3 shrink-0 self-start sm:self-end mt-2 sm:mt-0">
                      <Button 
                        type="submit" 
                        disabled={isSaving}
                        className="bg-teal-600 hover:bg-teal-700 text-white min-w-[120px]"
                      >
                        {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                        {isSaving ? "Saving..." : (isEditing ? "Update" : "Create")}
                      </Button>
                    </div>
                  </div>

                  <div className="bg-slate-50 p-6 flex items-center justify-between border-b border-slate-100">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 flex items-center">
                        <Tag className="w-4 h-4 mr-2 text-slate-500" />
                        Offers & Products
                      </h3>
                      <p className="text-xs text-slate-500 mt-1">Configure what customers can buy in this price sheet.</p>
                    </div>
                    <Button type="button" onClick={addOffer} variant="outline" size="sm" className="bg-white">
                      <Plus className="w-4 h-4 mr-2" /> Add Offer
                    </Button>
                  </div>

                  <div className="p-6 bg-slate-50">
                    <div className="space-y-6">
                      {offers.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-slate-300 p-12 flex flex-col items-center justify-center text-center bg-white">
                          <div className="h-12 w-12 rounded-full bg-slate-100 flex items-center justify-center mb-4">
                            <Tag className="w-6 h-6 text-slate-400" />
                          </div>
                          <h4 className="text-sm font-medium text-slate-900 mb-1">No offers yet</h4>
                          <p className="text-sm text-slate-500 max-w-sm mb-4">
                            Add products like digital downloads, physical prints, or package deals to this price sheet.
                          </p>
                          <Button type="button" onClick={addOffer} variant="outline">
                            <Plus className="w-4 h-4 mr-2" /> Add Your First Offer
                          </Button>
                        </div>
                      ) : (
                        offers.map((offer, index) => (
                          <div key={offer.id} className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden transition-all focus-within:ring-2 focus-within:ring-teal-500 focus-within:border-teal-500">
                            <div className="flex items-center justify-between bg-slate-100/50 px-5 py-3 border-b border-slate-100">
                              <div className="flex items-center gap-2">
                                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-slate-200 text-xs font-medium text-slate-600">
                                  {index + 1}
                                </span>
                                <span className="font-medium text-slate-700 text-sm">
                                  {offer.productType === 'digital' ? 'Digital Download' : offer.productType === 'print' ? 'Physical Print' : 'Package Deal'}
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-slate-500 hover:text-teal-600"
                                  onClick={() => duplicateOffer(offer)}
                                  title="Duplicate offer"
                                >
                                  <Copy className="w-4 h-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-slate-500 hover:text-red-600"
                                  onClick={() => removeOffer(offer.id)}
                                  title="Remove offer"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                            
                            <div className="p-5">
                              <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-12">
                                <div className="space-y-2 sm:col-span-2 md:col-span-8">
                                  <Label className="text-xs font-medium text-slate-500">Offer Name <span className="text-red-500">*</span></Label>
                                  <Input
                                    required
                                    value={offer.name}
                                    onChange={(e) => updateOffer(offer.id, { name: e.target.value })}
                                    placeholder="e.g. Single Digital Photo"
                                    className="border-slate-200 focus-visible:ring-teal-500"
                                  />
                                </div>
                                
                                <div className="space-y-2 sm:col-span-1 md:col-span-4">
                                  <Label className="text-xs font-medium text-slate-500">Product Type</Label>
                                  <Select
                                    value={offer.productType}
                                    onValueChange={(val: any) => updateOffer(offer.id, { productType: val })}
                                  >
                                    <SelectTrigger className="border-slate-200 focus:ring-teal-500">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="digital">Digital</SelectItem>
                                      <SelectItem value="print">Print</SelectItem>
                                      <SelectItem value="pack">Pack</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="space-y-2 sm:col-span-1 md:col-span-4">
                                  <Label className="text-xs font-medium text-slate-500">Price <span className="text-red-500">*</span></Label>
                                  <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                                    <Input
                                      required
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      value={(offer.unitAmount / 100).toFixed(2)}
                                      onChange={(e) => updateOffer(offer.id, { unitAmount: Math.round((Number(e.target.value) || 0) * 100) })}
                                      className="pl-7 border-slate-200 focus-visible:ring-teal-500"
                                    />
                                  </div>
                                </div>
                                
                                <div className="space-y-2 sm:col-span-1 md:col-span-4">
                                  <Label className="text-xs font-medium text-slate-500">Currency <span className="text-red-500">*</span></Label>
                                  <Input
                                    required
                                    type="text"
                                    maxLength={3}
                                    value={offer.currency.toUpperCase()}
                                    onChange={(e) => updateOffer(offer.id, { currency: e.target.value.replace(/[^A-Za-z]/g, "").slice(0, 3).toLowerCase() })}
                                    className="uppercase border-slate-200 focus-visible:ring-teal-500"
                                    placeholder="USD"
                                  />
                                </div>

                                <div className="space-y-2 sm:col-span-1 md:col-span-4">
                                  <Label className="text-xs font-medium text-slate-500">Photo Count <span className="text-red-500">*</span></Label>
                                  <Input
                                    type="number"
                                    min={1}
                                    required
                                    value={offer.photoCount}
                                    onChange={(e) => updateOffer(offer.id, { photoCount: parseInt(e.target.value, 10) || 1 })}
                                    className="border-slate-200 focus-visible:ring-teal-500"
                                  />
                                </div>
                                
                                <div className="space-y-2 sm:col-span-2 md:col-span-12">
                                  <Label className="text-xs font-medium text-slate-500">Description (Optional)</Label>
                                  <Input
                                    type="text"
                                    value={offer.description || ""}
                                    onChange={(e) => updateOffer(offer.id, { description: e.target.value || undefined })}
                                    className="border-slate-200 focus-visible:ring-teal-500"
                                    placeholder="e.g. High-res download of 1 photo with print rights"
                                  />
                                </div>

                                {(offer.productType === "print" || offer.productType === "pack") && (
                                  <div className="space-y-2 sm:col-span-2 md:col-span-12">
                                    <Label className="text-xs font-medium text-slate-500">Print Size (Optional)</Label>
                                    <Input
                                      type="text"
                                      value={offer.printSize || ""}
                                      onChange={(e) => updateOffer(offer.id, { printSize: e.target.value || undefined })}
                                      className="border-slate-200 focus-visible:ring-teal-500"
                                      placeholder="e.g. 8x10"
                                    />
                                  </div>
                                )}

                                <div className="sm:col-span-2 md:col-span-12 grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
                                  <div className="space-y-3">
                                    <Label className="text-xs font-medium text-slate-900 block">Delivery Methods</Label>
                                    <div className="flex flex-col gap-2.5">
                                      {(['digital', 'school', 'collection', 'shipping'] as const).map(method => (
                                        <div key={method} className="flex items-center space-x-2">
                                          <Checkbox 
                                            id={`delivery-${offer.id}-${method}`}
                                            checked={offer.deliveryMethods.includes(method as any)}
                                            onCheckedChange={(checked) => {
                                              if (checked) {
                                                updateOffer(offer.id, { deliveryMethods: [...offer.deliveryMethods, method as any] });
                                              } else {
                                                updateOffer(offer.id, { deliveryMethods: offer.deliveryMethods.filter(m => m !== method) });
                                              }
                                            }}
                                          />
                                          <label htmlFor={`delivery-${offer.id}-${method}`} className="text-sm text-slate-700 capitalize cursor-pointer leading-none">
                                            {method}
                                          </label>
                                        </div>
                                      ))}
                                    </div>
                                  </div>

                                  <div className="space-y-3">
                                    <Label className="text-xs font-medium text-slate-900 block">Payment Methods</Label>
                                    <div className="flex flex-col gap-2.5">
                                      {([
                                        ["stripe", "Card with Stripe"],
                                        ["establishment", "Pay at establishment"],
                                        ["bank_transfer", "Bank transfer"],
                                      ] as const).map(([method, label]) => (
                                        <div key={method} className="flex items-center space-x-2">
                                          <Checkbox 
                                            id={`payment-${offer.id}-${method}`}
                                            checked={offer.paymentMethods.includes(method as any)}
                                            onCheckedChange={(checked) => {
                                              if (checked) {
                                                updateOffer(offer.id, { paymentMethods: [...offer.paymentMethods, method as any] });
                                              } else {
                                                updateOffer(offer.id, { paymentMethods: offer.paymentMethods.filter(m => m !== method) });
                                              }
                                            }}
                                          />
                                          <label htmlFor={`payment-${offer.id}-${method}`} className="text-sm text-slate-700 cursor-pointer leading-none">
                                            {label}
                                          </label>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                                
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </Card>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
