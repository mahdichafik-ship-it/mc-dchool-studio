export type DeliveryProductType = "digital" | "print" | "pack";

export function validateDeliverySelection(
  productType: DeliveryProductType,
  photoCount: number,
  selectedCount: number,
  quantity: number,
  quantityProvided = true,
): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error("quantity");
  if (productType === "print" && selectedCount !== 1) throw new Error("print selection");
  if (productType === "pack" && selectedCount !== photoCount * quantity) throw new Error("pack selection");
  if (productType === "digital" && photoCount === 1 && quantityProvided && quantity !== selectedCount) {
    throw new Error("digital quantity");
  }
}

export function deliveryOrderQuantity(
  productType: DeliveryProductType,
  photoCount: number,
  selectedCount: number,
  quantity: number,
): number {
  return productType === "digital" && photoCount === 1 ? selectedCount : quantity;
}

export function deliveryAmount(unitAmount: number, orderQuantity: number): number {
  return unitAmount * orderQuantity;
}