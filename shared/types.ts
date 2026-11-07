export type OrderSource = "whatsapp" | "manual" | "instagram" | "facebook" | "website" | "other";

export type OrderStatus =
  | "pending"
  | "confirmed"
  | "packed"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "returned";

export type PaymentMethod = "cod" | "upi" | "bank" | "cash" | "prepaid";

export type PaymentStatus = "unpaid" | "partial" | "paid" | "refunded";

export type PaymentType = "payment" | "refund" | "cod_collection" | "courier_remittance";

export type TxnMethod = "cash" | "upi" | "bank" | "card" | "other";

export type ShipmentStatus =
  | "pending"
  | "packed"
  | "picked_up"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "rto"
  | "lost";

export type CampaignStatus = "draft" | "active" | "paused" | "completed" | "archived";

export type ExpenseCategory = "shipping" | "packaging" | "operating" | "returns_loss" | "other";

export const ORDER_SOURCES: { value: OrderSource; label: string }[] = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "manual", label: "Manual" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "website", label: "Website" },
  { value: "other", label: "Other" },
];

export const ORDER_STATUSES: { value: OrderStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "packed", label: "Packed" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
  { value: "returned", label: "Returned" },
];

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cod", label: "COD" },
  { value: "upi", label: "UPI" },
  { value: "bank", label: "Bank Transfer" },
  { value: "cash", label: "Cash" },
  { value: "prepaid", label: "Prepaid" },
];

export const PAYMENT_STATUSES: { value: PaymentStatus; label: string }[] = [
  { value: "unpaid", label: "Unpaid" },
  { value: "partial", label: "Partially Paid" },
  { value: "paid", label: "Paid" },
  { value: "refunded", label: "Refunded" },
];

export const PAYMENT_TYPES: { value: PaymentType; label: string }[] = [
  { value: "payment", label: "Payment In" },
  { value: "cod_collection", label: "COD Collection" },
  { value: "refund", label: "Refund" },
  { value: "courier_remittance", label: "Courier Remittance" },
];

export const TXN_METHODS: { value: TxnMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "bank", label: "Bank Transfer" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

export const SHIPMENT_STATUSES: { value: ShipmentStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "packed", label: "Packed" },
  { value: "picked_up", label: "Picked Up" },
  { value: "in_transit", label: "In Transit" },
  { value: "out_for_delivery", label: "Out for Delivery" },
  { value: "delivered", label: "Delivered" },
  { value: "rto", label: "RTO" },
  { value: "lost", label: "Lost" },
];

export const CAMPAIGN_STATUSES: { value: CampaignStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

export const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: "packaging", label: "Packaging" },
  { value: "shipping", label: "Shipping" },
  { value: "operating", label: "Operating" },
  { value: "returns_loss", label: "Return Losses" },
  { value: "other", label: "Other" },
];

export interface User {
  id: number;
  username: string;
  full_name: string;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  email: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  pincode: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: number;
  name: string;
  sku: string;
  category: string;
  description: string;
  price: number;
  cost_price: number;
  stock_qty: number;
  low_stock_threshold: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface StockMovement {
  id: number;
  product_id: number;
  delta: number;
  reason: string;
  order_id: number | null;
  note: string;
  created_at: string;
}

export interface OrderItem {
  id?: number;
  order_id?: number;
  product_id: number | null;
  product_name: string;
  sku: string;
  unit_price: number;
  unit_cost: number;
  quantity: number;
  line_total: number;
}

export interface OrderStatusEntry {
  id: number;
  order_id: number;
  status: string;
  note: string;
  created_at: string;
}

export interface Order {
  id: number;
  order_number: string;
  customer_id: number;
  customer_name?: string;
  customer_phone?: string;
  source: OrderSource;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  shipping_charge: number;
  total: number;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  paid_amount?: number;
  campaign_id: number | null;
  campaign_name?: string;
  ship_name: string;
  ship_phone: string;
  ship_address_line1: string;
  ship_address_line2: string;
  ship_city: string;
  ship_state: string;
  ship_pincode: string;
  notes: string;
  placed_at: string;
  created_at: string;
  updated_at: string;
  items?: OrderItem[];
  history?: OrderStatusEntry[];
}

export interface Campaign {
  id: number;
  name: string;
  objective: string;
  status: CampaignStatus;
  daily_budget: number;
  start_date: string;
  end_date: string;
  notes: string;
  created_at: string;
  updated_at: string;
  spend?: number;
  impressions?: number;
  reach?: number;
  clicks?: number;
  leads?: number;
  conversations?: number;
  purchases?: number;
  revenue?: number;
}

export interface AdSet {
  id: number;
  campaign_id: number;
  name: string;
  audience: string;
  budget: number;
  status: string;
  notes: string;
  ads?: Ad[];
}

export interface Ad {
  id: number;
  ad_set_id: number;
  name: string;
  creative_type: string;
  cta: string;
  status: string;
  notes: string;
}

export interface CampaignMetrics {
  id: number;
  campaign_id: number;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  leads: number;
  conversations: number;
  purchases: number;
  revenue: number;
}

export interface Shipment {
  id: number;
  order_id: number;
  courier: string;
  awb: string;
  tracking_number: string;
  ship_date: string;
  shipping_charge: number;
  weight_g: number;
  cod_amount: number;
  status: ShipmentStatus;
  delivered_date: string;
  notes: string;
  order_number?: string;
  customer_name?: string;
  customer_phone?: string;
  ship_address_line1?: string;
  ship_address_line2?: string;
  ship_city?: string;
  ship_state?: string;
  ship_pincode?: string;
  items?: OrderItem[];
}

export interface Payment {
  id: number;
  order_id: number | null;
  order_number?: string;
  type: PaymentType;
  method: TxnMethod;
  amount: number;
  reference: string;
  paid_at: string;
  notes: string;
  created_at: string;
}

export interface Expense {
  id: number;
  category: ExpenseCategory;
  description: string;
  amount: number;
  expense_date: string;
  order_id: number | null;
  notes: string;
  created_at: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PnlReport {
  from: string;
  to: string;
  product_revenue: number;
  discounts: number;
  refunds: number;
  net_revenue: number;
  cogs: number;
  gross_profit: number;
  shipping_income: number;
  shipping_expense: number;
  packaging_expense: number;
  advertising_expense: number;
  returns_loss: number;
  operating_expense: number;
  total_expenses: number;
  net_profit: number;
  gross_margin: number;
  net_margin: number;
  orders_count: number;
  units_sold: number;
  ad_spend: number;
  attributed_revenue: number;
  roas: number;
  average_order_value: number;
  expense_breakdown?: { category: string; amount: number }[];
}

export interface ProductReportRow {
  product_id: number | null;
  product_name: string;
  qty: number;
  revenue: number;
  cogs: number;
  profit: number;
  margin: number;
}

export interface CampaignReportRow extends Campaign {
  orders: number;
  linked_revenue: number;
  linked_cogs: number;
  ctr: number;
  cpc: number;
  cpm: number;
  cpl: number;
  cost_per_purchase: number;
  roas: number;
  profit: number;
  margin: number;
}

export interface CodRow {
  order_id: number;
  order_number: string;
  courier: string;
  awb: string;
  status: string;
  cod_due: number;
  collected: number;
  remitted: number;
  variance: number;
  settled: boolean;
}
