import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { deliveryGalleriesTable } from "./deliveries";
import { studentPhotosTable } from "./photos";

export const deliveryOrdersTable = pgTable("delivery_orders", {
  id: serial("id").primaryKey(),
  galleryId: integer("gallery_id").notNull().references(() => deliveryGalleriesTable.id, { onDelete: "cascade" }),
  accessId: integer("access_id").notNull(),
  status: text("status", { enum: ["pending", "paid", "expired", "refunded", "cancelled"] }).notNull().default("pending"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull().unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  customerEmail: text("customer_email"),
  customerName: text("customer_name"),
  fulfillmentStatus: text("fulfillment_status", { enum: ["not_required", "paid", "preparing", "printed", "ready", "dispatched", "delivered"] }).notNull().default("not_required"),
  deliveryMethod: text("delivery_method", { enum: ["digital", "school", "collection", "shipping"] }).notNull().default("digital"),
  deliveryAddress: text("delivery_address"),
  amountTotal: integer("amount_total").notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export const deliveryOrderItemsTable = pgTable("delivery_order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => deliveryOrdersTable.id, { onDelete: "cascade" }),
  photoId: integer("photo_id").references(() => studentPhotosTable.id, { onDelete: "set null" }),
  offerId: text("offer_id").notNull().default("digital-single"),
  productName: text("product_name").notNull().default("Digital photo"),
  productType: text("product_type", { enum: ["digital", "print", "pack"] }).notNull().default("digital"),
  includesDigitalDownloads: boolean("includes_digital_downloads").notNull().default(false),
  printSize: text("print_size"),
  quantity: integer("quantity").notNull().default(1),
  unitAmount: integer("unit_amount").notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DeliveryOrder = typeof deliveryOrdersTable.$inferSelect;
export type DeliveryOrderItem = typeof deliveryOrderItemsTable.$inferSelect;