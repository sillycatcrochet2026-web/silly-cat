CREATE TABLE IF NOT EXISTS orders (
  order_nsu TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,

  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_document TEXT NOT NULL,

  postal_code TEXT NOT NULL,
  street TEXT NOT NULL,
  number TEXT NOT NULL,
  complement TEXT,
  neighborhood TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,

  shipping_service_id TEXT NOT NULL,
  shipping_service_name TEXT NOT NULL,
  shipping_company TEXT NOT NULL,
  shipping_deadline_days INTEGER,
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,

  checkout_url TEXT,
  transaction_nsu TEXT,
  invoice_slug TEXT,
  capture_method TEXT,
  installments INTEGER,
  paid_amount_cents INTEGER,
  receipt_url TEXT,
  raw_payment_json TEXT,
  webhook_received_at TEXT,

  notification_claimed_at TEXT,
  notification_sent_at TEXT,
  notification_error TEXT,

  melhor_envio_shipment_id TEXT,
  label_status TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_nsu TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  shipping_json TEXT,
  FOREIGN KEY (order_nsu) REFERENCES orders(order_nsu) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order_nsu ON order_items(order_nsu);
