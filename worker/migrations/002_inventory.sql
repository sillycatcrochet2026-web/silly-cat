-- v2.1 — estoque vivo no D1.
-- Seguro para executar mais de uma vez.
CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT PRIMARY KEY,
  stock INTEGER NOT NULL DEFAULT 0,
  catalog_stock_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  order_nsu TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (order_nsu, product_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_order ON inventory_movements(order_nsu);
