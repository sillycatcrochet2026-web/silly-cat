CREATE TABLE IF NOT EXISTS shipping_labels (
  order_nsu TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'waiting_payment',
  auto_eligible INTEGER NOT NULL DEFAULT 0,
  quote_json TEXT,
  shipments_json TEXT,
  print_urls_json TEXT,
  claim_at TEXT,
  cart_created_at TEXT,
  purchased_at TEXT,
  generated_at TEXT,
  ready_at TEXT,
  error TEXT,
  raw_checkout_json TEXT,
  raw_generate_json TEXT,
  raw_print_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_nsu) REFERENCES orders(order_nsu) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shipping_labels_status ON shipping_labels(status);
