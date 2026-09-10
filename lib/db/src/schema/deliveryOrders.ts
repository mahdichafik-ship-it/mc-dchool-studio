import { pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
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
  amountTotal: integer("amount_total").notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("delivery_orders_gallery_session_unique").on(table.galleryId, table.stripeCheckoutSessionId),
]);

export const deliveryOrderItemsTable = pgTable("delivery_order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => deliveryOrdersTable.id, { onDelete: "cascade" }),
  photoId: integer("photo_id").notNull().references(() => studentPhotosTable.id, { onDelete: "cascade" }),
  unitAmount: integer("unit_amount").notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("delivery_order_items_order_photo_unique").on(table.orderId, table.photoId),
]);

export type DeliveryOrder = typeof deliveryOrdersTable.$inferSelect;
export type DeliveryOrderItem = typeof deliveryOrderItemsTable.$inferSelect;