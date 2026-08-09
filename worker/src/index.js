import { connect } from "cloudflare:sockets";
import bundledCatalog from "../../catalogo.json" with { type: "json" };

let inventorySchemaReady = false;
let shippingSchemaReady = false;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error("[worker]", error?.message || error, error?.details || "");
      return json(request, env, error?.status || 500, { error: error?.message || "Erro interno do servidor." });
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (request.method === "GET" && path === "/health") {
    return json(request, env, 200, {
      ok: true,
      service: "silly-cat-ecommerce-api",
      database: Boolean(env.DB),
      melhor_envio_env: String(env.MELHOR_ENVIO_ENV || "production"),
      infinitepay_configured: configured(env.INFINITEPAY_HANDLE),
      melhor_envio_configured: configured(env.MELHOR_ENVIO_TOKEN) && digits(env.MELHOR_ENVIO_FROM_POSTAL_CODE).length === 8,
      melhor_envio_allowed_carriers: allowedCarrierNames(env),
      melhor_envio_auto_label: autoLabelEnabled(env),
      melhor_envio_sender_configured: senderConfigured(env),
      melhor_envio_label_print_mode: labelPrintMode(env),
      smtp_configured: smtpConfigured(env),
    });
  }

  if (request.method === "GET" && path === "/api/catalog") {
    const catalog = await loadEffectiveCatalog(env);
    const safe = catalog.map(({ frete, ...product }) => ({
      ...product,
      tag: Number(product.estoque) <= 0 ? "Esgotado" : product.tag,
      frete_provisorio: Boolean(frete?.provisorio),
    }));
    return json(request, env, 200, safe);
  }

  if (request.method === "POST" && path === "/api/shipping/quote") {
    const body = await readJson(request);
    const catalog = await loadEffectiveCatalog(env);
    const cart = resolveCart(body.items, catalog);
    const result = await quoteShipping(env, cart, body.postalCode);
    return json(request, env, 200, {
      subtotal_centavos: cartSubtotal(cart),
      ...result,
      options: result.options.map(publicShippingOption),
    });
  }

  if (request.method === "POST" && path === "/api/checkout") {
    const body = await readJson(request);
    const catalog = await loadEffectiveCatalog(env);
    const cart = resolveCart(body.items, catalog);
    const orderInput = validateOrderInput(body);
    const quote = await quoteShipping(env, cart, orderInput.address.cep);
    const shipping = quote.options.find((option) => String(option.id) === String(body.shippingServiceId || ""));
    if (!shipping) throw httpError(409, "A opção de frete selecionada não está mais disponível. Calcule o frete novamente.");

    const subtotal = cartSubtotal(cart);
    const total = subtotal + shipping.preco_centavos;
    const orderNsu = makeOrderNsu();
    await savePendingOrder(env, { orderNsu, cart, shipping, subtotal, total, ...orderInput });

    try {
      const apiOrigin = url.origin;
      const checkout = await createInfinitePayCheckout(env, {
        orderNsu,
        cart,
        shipping,
        customer: orderInput.customer,
        address: orderInput.address,
        apiOrigin,
      });
      await env.DB.prepare("UPDATE orders SET checkout_url = ?, updated_at = ? WHERE order_nsu = ?")
        .bind(checkout.url, nowIso(), orderNsu).run();

      return json(request, env, 200, {
        url: checkout.url,
        order_nsu: orderNsu,
        subtotal_centavos: subtotal,
        frete_centavos: shipping.preco_centavos,
        total_centavos: total,
        frete: publicShippingOption(shipping),
      });
    } catch (error) {
      await env.DB.prepare("UPDATE orders SET status = 'checkout_error', updated_at = ? WHERE order_nsu = ?")
        .bind(nowIso(), orderNsu).run();
      throw error;
    }
  }

  if (request.method === "POST" && path === "/api/payment-status") {
    const body = await readJson(request);
    const identifiers = {
      orderNsu: String(body.order_nsu || "").trim(),
      transactionNsu: String(body.transaction_nsu || "").trim(),
      slug: String(body.slug || "").trim(),
      receiptUrl: safeHttpUrl(body.receipt_url),
    };
    if (!identifiers.orderNsu) throw httpError(400, "Pedido não informado.");

    const existing = await getOrder(env, identifiers.orderNsu);
    if (!existing) throw httpError(404, "Pedido não encontrado.");

    if (existing.status !== "paid") {
      if (!identifiers.transactionNsu || !identifiers.slug) {
        return json(request, env, 200, publicOrderStatus(existing));
      }
      const verified = await verifyAndRecordPayment(env, identifiers);
      if (verified.paid) ctx.waitUntil(runPostPaymentAutomation(env, identifiers.orderNsu));
    } else {
      ctx.waitUntil(runPostPaymentAutomation(env, identifiers.orderNsu));
    }

    const updated = await getOrder(env, identifiers.orderNsu);
    return json(request, env, 200, publicOrderStatus(updated));
  }

  const statusMatch = path.match(/^\/api\/orders\/([^/]+)\/status$/);
  if (request.method === "GET" && statusMatch) {
    const order = await getOrder(env, decodeURIComponent(statusMatch[1]));
    if (!order) throw httpError(404, "Pedido não encontrado.");
    return json(request, env, 200, publicOrderStatus(order));
  }

  const adminLabelMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/label$/);
  if (adminLabelMatch && ["GET", "POST"].includes(request.method)) {
    requireAdmin(request, env);
    const orderNsu = decodeURIComponent(adminLabelMatch[1]);
    const order = await getOrder(env, orderNsu);
    if (!order) throw httpError(404, "Pedido não encontrado.");

    if (request.method === "POST") {
      if (order.status !== "paid") throw httpError(409, "A etiqueta só pode ser gerada após o pagamento confirmado.");
      await maybeCreateShippingLabel(env, orderNsu, { force: true });
    }

    const state = await getShippingLabelState(env, orderNsu);
    return json(request, env, 200, publicShippingLabelState(state));
  }

  if (request.method === "POST" && path === "/api/infinitepay/webhook") {
    const event = await readJson(request);
    const orderNsu = String(event.order_nsu || "").trim();
    const transactionNsu = String(event.transaction_nsu || "").trim();
    const slug = String(event.invoice_slug || event.slug || "").trim();
    const amount = Number(event.amount);

    if (!orderNsu) return json(request, env, 400, { success: false, message: "Pedido não informado" });
    const order = await getOrder(env, orderNsu);
    if (!order) return json(request, env, 400, { success: false, message: "Pedido não encontrado" });
    if (!Number.isInteger(amount) || amount !== Number(order.total_cents)) {
      return json(request, env, 400, { success: false, message: "Valor do pedido divergente" });
    }

    await env.DB.prepare(`
      UPDATE orders
      SET webhook_received_at = ?, transaction_nsu = COALESCE(?, transaction_nsu),
          receipt_url = COALESCE(?, receipt_url), raw_payment_json = ?, updated_at = ?
      WHERE order_nsu = ?
    `).bind(
      nowIso(), transactionNsu || null, safeHttpUrl(event.receipt_url), JSON.stringify(event), nowIso(), orderNsu
    ).run();

    if (transactionNsu && slug) {
      ctx.waitUntil((async () => {
        try {
          const verified = await verifyAndRecordPayment(env, {
            orderNsu,
            transactionNsu,
            slug,
            receiptUrl: safeHttpUrl(event.receipt_url),
          });
          if (verified.paid) await runPostPaymentAutomation(env, orderNsu);
        } catch (error) {
          console.error("[InfinitePay webhook verification]", error?.message || error);
        }
      })());
    }

    return json(request, env, 200, { success: true, message: null });
  }

  return json(request, env, 404, { error: "Rota não encontrada." });
}

async function ensureInventorySchema(env) {
  if (inventorySchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS inventory (
        product_id TEXT PRIMARY KEY,
        stock INTEGER NOT NULL DEFAULT 0,
        catalog_stock_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        order_nsu TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (order_nsu, product_id)
      )
    `),
  ]);
  inventorySchemaReady = true;
}

function sourceStock(product) {
  const value = Number(product?.estoque ?? 1);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function catalogStockKey(product) {
  // estoque_revisao é opcional. Ele serve apenas para o caso raro em que
  // você queira repor exatamente a mesma quantidade original de um produto
  // já vendido. Ex.: estoque continua 1 no JSON, mas o D1 já baixou para 0;
  // mudar estoque_revisao de 0 para 1 força uma reposição para 1.
  return `${sourceStock(product)}:${clean(product?.estoque_revisao ?? "0", 80)}`;
}

async function loadSourceCatalog(env) {
  const storeUrl = String(env.STORE_URL || env.STORE_ORIGIN || "https://www.sillycatcroche.shop").replace(/\/$/, "");
  const url = `${storeUrl}/catalogo.json?sc=${Date.now()}`;

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("catalogo.json não retornou uma lista.");
    return data;
  } catch (error) {
    console.warn("[catalogo] Falha ao buscar catálogo publicado; usando cópia embarcada.", error?.message || error);
    return bundledCatalog;
  }
}

async function syncInventory(env, catalog) {
  await ensureInventorySchema(env);
  const result = await env.DB.prepare("SELECT product_id, stock, catalog_stock_key FROM inventory").all();
  const rows = new Map((result.results || []).map((row) => [String(row.product_id), row]));
  const statements = [];
  const timestamp = nowIso();

  for (const product of catalog) {
    const id = clean(product?.id, 100);
    if (!id) continue;
    const key = catalogStockKey(product);
    const stock = sourceStock(product);
    const existing = rows.get(id);

    if (!existing) {
      statements.push(env.DB.prepare(`
        INSERT INTO inventory (product_id, stock, catalog_stock_key, updated_at)
        VALUES (?, ?, ?, ?)
      `).bind(id, stock, key, timestamp));
    } else if (String(existing.catalog_stock_key) !== key) {
      // Uma alteração explícita de estoque (ou estoque_revisao) no catálogo
      // é tratada como reposição/ajuste manual e passa a ser o novo saldo.
      statements.push(env.DB.prepare(`
        UPDATE inventory SET stock = ?, catalog_stock_key = ?, updated_at = ?
        WHERE product_id = ?
      `).bind(stock, key, timestamp, id));
    }
  }

  if (statements.length) await env.DB.batch(statements);
}

async function loadEffectiveCatalog(env) {
  const catalog = await loadSourceCatalog(env);
  await syncInventory(env, catalog);
  // Também reconcilia vendas pagas que já existiam antes da v2.1 (como a
  // compra de teste usada para validar o fluxo ponta a ponta).
  await reconcilePaidStock(env);
  const result = await env.DB.prepare("SELECT product_id, stock FROM inventory").all();
  const stockMap = new Map((result.results || []).map((row) => [String(row.product_id), Number(row.stock)]));

  return catalog.map((product) => ({
    ...product,
    estoque: Math.max(0, Number(stockMap.get(String(product.id)) ?? sourceStock(product))),
  }));
}

async function reconcilePaidStock(env) {
  await ensureInventorySchema(env);
  const pending = await env.DB.prepare(`
    SELECT DISTINCT o.order_nsu
    FROM orders o
    JOIN order_items oi ON oi.order_nsu = o.order_nsu
    LEFT JOIN inventory_movements im
      ON im.order_nsu = oi.order_nsu AND im.product_id = oi.product_id
    WHERE o.status = 'paid' AND im.order_nsu IS NULL
    ORDER BY o.paid_at ASC
    LIMIT 100
  `).all();

  for (const row of pending.results || []) {
    await applyStockForPaidOrder(env, String(row.order_nsu));
  }
}

async function applyStockForPaidOrder(env, orderNsu) {
  await ensureInventorySchema(env);
  const items = await getOrderItems(env, orderNsu);
  if (!items.length) return;

  // Garante que produtos novos já tenham uma linha de estoque antes de
  // aplicar a baixa. O catálogo publicado é a fonte de metadados e estoque
  // inicial; o D1 passa a controlar o saldo vivo após a primeira venda.
  const catalog = await loadSourceCatalog(env);
  await syncInventory(env, catalog);

  const timestamp = nowIso();
  const statements = [];
  for (const item of items) {
    const quantity = Math.max(1, Number(item.quantity || 1));
    const productId = String(item.product_id);

    // O UPDATE só desconta quando ainda não existe movimento para este
    // pedido/produto. Em seguida o INSERT OR IGNORE grava o marcador.
    // Como D1 batch é transacional, a operação fica idempotente.
    statements.push(env.DB.prepare(`
      UPDATE inventory
      SET stock = MAX(0, stock - ?), updated_at = ?
      WHERE product_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM inventory_movements
          WHERE order_nsu = ? AND product_id = ?
        )
    `).bind(quantity, timestamp, productId, orderNsu, productId));

    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO inventory_movements (order_nsu, product_id, quantity, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(orderNsu, productId, quantity, timestamp));
  }

  await env.DB.batch(statements);
}

function validateOrderInput(body) {
  const customer = {
    name: clean(body.customer?.name, 120),
    email: clean(body.customer?.email, 160).toLowerCase(),
    phone: digits(body.customer?.phone),
    document: digits(body.customer?.document),
  };
  const address = {
    cep: digits(body.postalCode || body.address?.cep),
    street: clean(body.address?.street, 180),
    neighborhood: clean(body.address?.neighborhood, 120),
    number: clean(body.address?.number, 30),
    complement: clean(body.address?.complement, 120),
    city: clean(body.address?.city, 120),
    state: clean(body.address?.state, 2).toUpperCase(),
  };

  if (!customer.name || !/^\S+@\S+\.\S+$/.test(customer.email)) throw httpError(400, "Informe nome e e-mail válidos.");
  if (customer.phone.length < 10 || customer.phone.length > 13) throw httpError(400, "Informe um telefone válido.");
  if (!isValidCpf(customer.document)) throw httpError(400, "Informe um CPF válido para a entrega.");
  if (address.cep.length !== 8 || !address.street || !address.neighborhood || !address.number || !address.city || !/^[A-Z]{2}$/.test(address.state)) {
    throw httpError(400, "Preencha o endereço completo para entrega.");
  }
  return { customer, address };
}

function resolveCart(items, catalog) {
  if (!Array.isArray(items) || !items.length) throw httpError(400, "O carrinho está vazio.");
  const map = new Map(catalog.map((product) => [product.id, product]));
  const seen = new Set();

  return items.map((item) => {
    const id = clean(item?.id, 100);
    if (!id || seen.has(id)) throw httpError(400, "Carrinho inválido.");
    seen.add(id);
    const product = map.get(id);
    if (!product) throw httpError(400, `Produto não encontrado: ${id}`);
    const quantity = Number(item?.quantity || 1);
    const stock = Number(product.estoque ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > stock) {
      throw httpError(409, `${product.nome} não possui essa quantidade disponível.`);
    }
    for (const field of ["largura", "altura", "comprimento", "peso"]) {
      if (!(Number(product.frete?.[field]) > 0)) throw httpError(503, `As medidas de frete de ${product.nome} ainda não foram configuradas.`);
    }
    return { product, quantity };
  });
}

function cartSubtotal(cart) {
  return cart.reduce((sum, item) => sum + Number(item.product.preco_centavos) * item.quantity, 0);
}

async function quoteShipping(env, cart, destinationPostalCode) {
  requireConfig("MELHOR_ENVIO_TOKEN", env.MELHOR_ENVIO_TOKEN);
  const fromPostalCode = digits(env.MELHOR_ENVIO_FROM_POSTAL_CODE);
  if (fromPostalCode.length !== 8) throw httpError(503, "MELHOR_ENVIO_FROM_POSTAL_CODE não configurado.");
  const cep = digits(destinationPostalCode);
  if (cep.length !== 8) throw httpError(400, "Informe um CEP válido com 8 dígitos.");

  const body = {
    from: { postal_code: fromPostalCode },
    to: { postal_code: cep },
    products: cart.map(({ product, quantity }) => ({
      id: product.id,
      width: Number(product.frete.largura),
      height: Number(product.frete.altura),
      length: Number(product.frete.comprimento),
      weight: Number(product.frete.peso),
      insurance_value: Number(product.preco_centavos) / 100,
      quantity,
    })),
    options: { receipt: false, own_hand: false },
  };
  if (clean(env.MELHOR_ENVIO_SERVICES, 100)) body.services = clean(env.MELHOR_ENVIO_SERVICES, 100);

  const base = String(env.MELHOR_ENVIO_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.melhorenvio.com.br"
    : "https://melhorenvio.com.br";

  const data = await fetchJson(`${base}/api/v2/me/shipment/calculate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MELHOR_ENVIO_TOKEN}`,
      "User-Agent": clean(env.MELHOR_ENVIO_USER_AGENT, 180) || "Silly Cat Croche (contato@sillycatcroche.shop)",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!Array.isArray(data)) throw httpError(502, "Resposta inesperada do Melhor Envio.");

  // A Silly Cat só oferece as transportadoras definidas em
  // MELHOR_ENVIO_ALLOWED_CARRIERS. Por padrão: Correios e Jadlog.
  // A filtragem é feita no backend para que outras transportadoras nunca
  // sejam aceitas nem no cálculo exibido nem na validação final do checkout.
  const allowedCarriers = allowedCarrierKeys(env);
  const validQuotes = data.filter((item) => item && !item.error && (item.custom_price ?? item.price) != null);
  const carrierFilteredQuotes = allowedCarriers === null
    ? validQuotes
    : validQuotes.filter((item) => allowedCarriers.has(normalizeCarrierKey(item.company?.name)));

  const options = carrierFilteredQuotes
    .map((item) => ({
      id: String(item.id),
      nome: String(item.name || "Frete"),
      transportadora: String(item.company?.name || "Transportadora"),
      preco_centavos: moneyToCents(item.custom_price ?? item.price),
      prazo_dias: Number(item.custom_delivery_time ?? item.delivery_time ?? 0) || null,
      packages: normalizeQuotePackages(item.packages),
    }))
    .filter((item) => Number.isInteger(item.preco_centavos) && item.preco_centavos >= 0)
    .sort((a, b) => a.preco_centavos - b.preco_centavos);

  if (!options.length) {
    const errors = data.filter((item) => item?.error).map((item) => item.error).filter(Boolean);
    if (validQuotes.length && allowedCarriers !== null) {
      throw httpError(422, `Nenhuma opção das transportadoras permitidas foi encontrada para esse CEP. Transportadoras permitidas: ${allowedCarrierNames(env).join(", ")}.`);
    }
    throw httpError(422, errors[0] || "Nenhuma opção de frete foi encontrada para esse CEP.");
  }

  return {
    options,
    provisionalProducts: cart.filter((item) => item.product.frete?.provisorio).map((item) => item.product.nome),
  };
}

async function savePendingOrder(env, data) {
  await ensureShippingSchema(env);
  const created = nowIso();
  const orderStatement = env.DB.prepare(`
    INSERT INTO orders (
      order_nsu, status, created_at, updated_at,
      customer_name, customer_email, customer_phone, customer_document,
      postal_code, street, number, complement, neighborhood, city, state,
      shipping_service_id, shipping_service_name, shipping_company, shipping_deadline_days,
      subtotal_cents, shipping_cents, total_cents
    ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    data.orderNsu, created, created,
    data.customer.name, data.customer.email, data.customer.phone, data.customer.document,
    data.address.cep, data.address.street, data.address.number, data.address.complement || null,
    data.address.neighborhood, data.address.city, data.address.state,
    String(data.shipping.id), data.shipping.nome, data.shipping.transportadora, data.shipping.prazo_dias,
    data.subtotal, data.shipping.preco_centavos, data.total
  );

  const itemStatements = data.cart.map(({ product, quantity }) => env.DB.prepare(`
    INSERT INTO order_items (order_nsu, product_id, product_name, quantity, unit_price_cents, shipping_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(data.orderNsu, product.id, product.nome, quantity, Number(product.preco_centavos), JSON.stringify(product.frete || {})));

  const labelStatement = env.DB.prepare(`
    INSERT INTO shipping_labels (
      order_nsu, status, auto_eligible, quote_json, created_at, updated_at
    ) VALUES (?, 'waiting_payment', 1, ?, ?, ?)
    ON CONFLICT(order_nsu) DO UPDATE SET
      quote_json = excluded.quote_json,
      auto_eligible = 1,
      updated_at = excluded.updated_at
  `).bind(data.orderNsu, JSON.stringify(data.shipping), created, created);

  await env.DB.batch([orderStatement, ...itemStatements, labelStatement]);
}

async function createInfinitePayCheckout(env, { orderNsu, cart, shipping, customer, address, apiOrigin }) {
  requireConfig("INFINITEPAY_HANDLE", env.INFINITEPAY_HANDLE);
  const items = cart.map(({ product, quantity }) => ({
    quantity,
    price: Number(product.preco_centavos),
    description: product.nome,
  }));
  items.push({
    quantity: 1,
    price: Number(shipping.preco_centavos),
    description: `Frete - ${shipping.transportadora} ${shipping.nome}`,
  });

  const storeUrl = String(env.STORE_URL || env.STORE_ORIGIN || "https://www.sillycatcroche.shop").replace(/\/$/, "");
  const payload = {
    handle: String(env.INFINITEPAY_HANDLE).replace(/^\$/, "").trim(),
    redirect_url: `${storeUrl}/pedido.html`,
    webhook_url: `${apiOrigin}/api/infinitepay/webhook`,
    order_nsu: orderNsu,
    customer: {
      name: customer.name,
      email: customer.email,
      phone_number: normalizePhone(customer.phone),
    },
    address: {
      cep: address.cep,
      street: address.street,
      neighborhood: address.neighborhood,
      number: address.number,
      complement: address.complement || undefined,
    },
    items,
  };

  const response = await fetchJson("https://api.checkout.infinitepay.io/links", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response?.url) throw httpError(502, "A InfinitePay não retornou a URL de pagamento.");
  return { url: response.url };
}

async function verifyAndRecordPayment(env, { orderNsu, transactionNsu, slug, receiptUrl }) {
  const order = await getOrder(env, orderNsu);
  if (!order) throw httpError(404, "Pedido não encontrado.");

  if (order.status === "paid") {
    // A baixa de estoque é idempotente. Se uma execução anterior confirmou o
    // pagamento mas falhou antes de atualizar o estoque, esta nova consulta
    // tenta novamente sem descontar duas vezes.
    try { await applyStockForPaidOrder(env, orderNsu); }
    catch (error) { console.error("[estoque]", error?.message || error); }
    return publicOrderStatus(order);
  }

  requireConfig("INFINITEPAY_HANDLE", env.INFINITEPAY_HANDLE);
  const payment = await fetchJson("https://api.checkout.infinitepay.io/payment_check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      handle: String(env.INFINITEPAY_HANDLE).replace(/^\$/, "").trim(),
      order_nsu: orderNsu,
      transaction_nsu: transactionNsu,
      slug,
    }),
  });

  if (!payment?.paid) return { ...publicOrderStatus(order), paid: false };
  if (Number(payment.amount) !== Number(order.total_cents)) {
    await env.DB.prepare("UPDATE orders SET status = 'payment_mismatch', raw_payment_json = ?, updated_at = ? WHERE order_nsu = ?")
      .bind(JSON.stringify(payment), nowIso(), orderNsu).run();
    throw httpError(409, "O valor confirmado pela InfinitePay não corresponde ao valor do pedido.");
  }

  const timestamp = nowIso();
  await env.DB.prepare(`
    UPDATE orders SET
      status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ?,
      transaction_nsu = ?, invoice_slug = ?, capture_method = ?, installments = ?,
      paid_amount_cents = ?, receipt_url = COALESCE(?, receipt_url), raw_payment_json = ?
    WHERE order_nsu = ?
  `).bind(
    timestamp, timestamp, transactionNsu, slug,
    clean(payment.capture_method, 40) || null, Number(payment.installments || 1),
    Number(payment.paid_amount || payment.amount || order.total_cents), receiptUrl || null,
    JSON.stringify(payment), orderNsu
  ).run();

  try { await applyStockForPaidOrder(env, orderNsu); }
  catch (error) {
    // O pagamento não deixa de ser válido se a baixa de estoque tiver uma
    // falha transitória. A próxima verificação do pedido tenta novamente.
    console.error("[estoque]", error?.message || error);
  }

  return publicOrderStatus(await getOrder(env, orderNsu));
}

async function getOrder(env, orderNsu) {
  return env.DB.prepare("SELECT * FROM orders WHERE order_nsu = ? LIMIT 1").bind(orderNsu).first();
}

async function getOrderItems(env, orderNsu) {
  const result = await env.DB.prepare("SELECT * FROM order_items WHERE order_nsu = ? ORDER BY id").bind(orderNsu).all();
  return result.results || [];
}

function publicOrderStatus(order) {
  return {
    order_nsu: order.order_nsu,
    status: order.status,
    paid: order.status === "paid",
    amount: Number(order.total_cents),
    total_centavos: Number(order.total_cents),
    capture_method: order.capture_method || null,
    installments: order.installments || null,
    receipt_url: order.receipt_url || null,
  };
}


async function ensureShippingSchema(env) {
  if (shippingSchemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`
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
      )
    `),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_shipping_labels_status ON shipping_labels(status)`),
  ]);
  shippingSchemaReady = true;
}

function autoLabelEnabled(env) {
  return /^(1|true|yes|on)$/i.test(String(env.MELHOR_ENVIO_AUTO_LABEL || "false").trim());
}

function labelPrintMode(env) {
  return String(env.MELHOR_ENVIO_LABEL_PRINT_MODE || "private").toLowerCase() === "public" ? "public" : "private";
}

function shipmentMode(env) {
  return String(env.MELHOR_ENVIO_SHIPMENT_MODE || "").trim().toLowerCase();
}

function senderConfigured(env) {
  if (!configured(env.MELHOR_ENVIO_SENDER_JSON)) return false;
  try {
    const sender = JSON.parse(String(env.MELHOR_ENVIO_SENDER_JSON));
    return Boolean(sender?.name && sender?.email && sender?.phone && sender?.document && sender?.address && sender?.number && sender?.district && sender?.city && sender?.postal_code && sender?.state_abbr);
  } catch {
    return false;
  }
}

function parseSender(env) {
  requireConfig("MELHOR_ENVIO_SENDER_JSON", env.MELHOR_ENVIO_SENDER_JSON);
  let raw;
  try { raw = JSON.parse(String(env.MELHOR_ENVIO_SENDER_JSON)); }
  catch { throw httpError(503, "MELHOR_ENVIO_SENDER_JSON não contém um JSON válido."); }

  const sender = {
    name: clean(raw.name, 120),
    email: clean(raw.email, 160).toLowerCase(),
    phone: digits(raw.phone),
    document: digits(raw.document),
    address: clean(raw.address, 180),
    complement: clean(raw.complement, 120),
    number: clean(raw.number, 30),
    district: clean(raw.district, 120),
    city: clean(raw.city, 120),
    postal_code: digits(raw.postal_code),
    state_abbr: clean(raw.state_abbr, 2).toUpperCase(),
    country_id: "BR",
  };

  if (!sender.name || !/^\S+@\S+\.\S+$/.test(sender.email)) throw httpError(503, "Nome/e-mail do remetente inválidos em MELHOR_ENVIO_SENDER_JSON.");
  if (sender.phone.length < 10 || sender.phone.length > 13) throw httpError(503, "Telefone do remetente inválido em MELHOR_ENVIO_SENDER_JSON.");
  if (!isValidCpf(sender.document)) throw httpError(503, "CPF do remetente inválido em MELHOR_ENVIO_SENDER_JSON.");
  if (sender.postal_code.length !== 8 || !sender.address || !sender.number || !sender.district || !sender.city || !/^[A-Z]{2}$/.test(sender.state_abbr)) {
    throw httpError(503, "Endereço do remetente incompleto em MELHOR_ENVIO_SENDER_JSON.");
  }
  return sender;
}

function validateAutomaticShipmentMode(env) {
  const mode = shipmentMode(env);
  if (mode !== "non_commercial") {
    throw httpError(503, "Defina MELHOR_ENVIO_SHIPMENT_MODE=non_commercial somente se a remessa puder legalmente usar Declaração de Conteúdo. Envios comerciais exigem NF-e e não são automatizados por este patch.");
  }
}

function melhorEnvioBase(env) {
  return String(env.MELHOR_ENVIO_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.melhorenvio.com.br"
    : "https://melhorenvio.com.br";
}

function melhorEnvioHeaders(env) {
  requireConfig("MELHOR_ENVIO_TOKEN", env.MELHOR_ENVIO_TOKEN);
  return {
    Authorization: `Bearer ${env.MELHOR_ENVIO_TOKEN}`,
    "User-Agent": clean(env.MELHOR_ENVIO_USER_AGENT, 180) || "Silly Cat Croche (contato@sillycatcroche.shop)",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function melhorEnvioJson(env, path, options = {}) {
  return fetchJson(`${melhorEnvioBase(env)}${path}`, {
    ...options,
    headers: { ...melhorEnvioHeaders(env), ...(options.headers || {}) },
  });
}

async function getShippingLabelState(env, orderNsu) {
  await ensureShippingSchema(env);
  return env.DB.prepare("SELECT * FROM shipping_labels WHERE order_nsu = ? LIMIT 1").bind(orderNsu).first();
}

async function ensureShippingLabelRow(env, orderNsu) {
  await ensureShippingSchema(env);
  const timestamp = nowIso();
  await env.DB.prepare(`
    INSERT INTO shipping_labels (order_nsu, status, auto_eligible, created_at, updated_at)
    VALUES (?, 'waiting_payment', 0, ?, ?)
    ON CONFLICT(order_nsu) DO NOTHING
  `).bind(orderNsu, timestamp, timestamp).run();
  return getShippingLabelState(env, orderNsu);
}

function publicShippingLabelState(state) {
  if (!state) return { status: "not_started", shipment_ids: [], print_urls: [], error: null };
  return {
    order_nsu: state.order_nsu,
    status: state.status,
    shipment_ids: parseJsonArray(state.shipments_json).map((x) => x?.id).filter(Boolean),
    print_urls: parseJsonArray(state.print_urls_json).filter((x) => typeof x === "string"),
    purchased_at: state.purchased_at || null,
    generated_at: state.generated_at || null,
    ready_at: state.ready_at || null,
    error: state.error || null,
  };
}

async function runPostPaymentAutomation(env, orderNsu) {
  let labelResult = null;
  try {
    labelResult = await maybeCreateShippingLabel(env, orderNsu, { force: false });
    if (labelResult?.busy) return;
  } catch (error) {
    console.error("[Melhor Envio etiqueta]", error?.message || error);
  }
  await maybeSendSaleNotification(env, orderNsu);
}

async function maybeCreateShippingLabel(env, orderNsu, { force = false } = {}) {
  const order = await getOrder(env, orderNsu);
  if (!order) throw httpError(404, "Pedido não encontrado.");
  if (order.status !== "paid") return { skipped: "not_paid" };

  let state = await ensureShippingLabelRow(env, orderNsu);
  if (state.status === "ready") return publicShippingLabelState(state);
  if (!force && !autoLabelEnabled(env)) return { skipped: "disabled" };
  if (!force && !Number(state.auto_eligible || 0)) return { skipped: "legacy_order" };

  const claimedAt = nowIso();
  const staleClaimBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const claim = await env.DB.prepare(`
    UPDATE shipping_labels
    SET claim_at = ?, error = NULL, updated_at = ?
    WHERE order_nsu = ? AND status != 'ready'
      AND (claim_at IS NULL OR claim_at < ?)
  `).bind(claimedAt, claimedAt, orderNsu, staleClaimBefore).run();

  if (!Number(claim?.meta?.changes || 0)) return { busy: true, ...publicShippingLabelState(await getShippingLabelState(env, orderNsu)) };

  try {
    validateAutomaticShipmentMode(env);
    const sender = parseSender(env); // valida antes de qualquer cobrança
    const quoteOrigin = digits(env.MELHOR_ENVIO_FROM_POSTAL_CODE);
    if (quoteOrigin && sender.postal_code !== quoteOrigin) {
      throw httpError(503, "O CEP do remetente em MELHOR_ENVIO_SENDER_JSON precisa ser igual a MELHOR_ENVIO_FROM_POSTAL_CODE para que a cotação e a etiqueta usem a mesma origem.");
    }

    state = await getShippingLabelState(env, orderNsu);
    let quote = parseJsonObject(state.quote_json);
    if (!Array.isArray(quote?.packages) || !quote.packages.length) {
      quote = await rebuildShippingQuoteForOrder(env, order);
      await updateShippingLabel(env, orderNsu, { quote_json: JSON.stringify(quote), status: "quoted" });
    }

    state = await getShippingLabelState(env, orderNsu);
    let shipmentRecords = parseJsonArray(state.shipments_json);
    shipmentRecords = await createMelhorEnvioCartEntries(env, order, quote, shipmentRecords);

    const shipmentIds = shipmentRecords.map((record) => record.id).filter(Boolean);
    if (!shipmentIds.length) throw httpError(502, "O Melhor Envio não retornou IDs de etiquetas no carrinho.");

    state = await getShippingLabelState(env, orderNsu);
    if (!state.purchased_at) {
      const checkoutResult = await melhorEnvioJson(env, "/api/v2/me/shipment/checkout", {
        method: "POST",
        body: JSON.stringify({ orders: shipmentIds }),
      });
      const timestamp = nowIso();
      await updateShippingLabel(env, orderNsu, {
        status: "purchased",
        purchased_at: timestamp,
        raw_checkout_json: JSON.stringify(checkoutResult),
      });
    }

    state = await getShippingLabelState(env, orderNsu);
    if (!state.generated_at) {
      const generateResult = await melhorEnvioJson(env, "/api/v2/me/shipment/generate", {
        method: "POST",
        body: JSON.stringify({ orders: shipmentIds }),
      });
      const timestamp = nowIso();
      await updateShippingLabel(env, orderNsu, {
        status: "generated",
        generated_at: timestamp,
        raw_generate_json: JSON.stringify(generateResult),
      });
    }

    state = await getShippingLabelState(env, orderNsu);
    let printUrls = parseJsonArray(state.print_urls_json).filter((x) => typeof x === "string" && x);
    if (!printUrls.length) {
      // A geração é assíncrona no Melhor Envio; um pequeno atraso reduz
      // respostas prematuras de impressão logo após /shipment/generate.
      await sleep(1800);
      let printResult = null;
      let lastError = null;
      for (const waitMs of [0, 2200, 4500]) {
        if (waitMs) await sleep(waitMs);
        try {
          printResult = await melhorEnvioJson(env, "/api/v2/me/shipment/print", {
            method: "POST",
            body: JSON.stringify({ mode: labelPrintMode(env), orders: shipmentIds }),
          });
          const found = collectHttpUrls(printResult);
          if (found.length) {
            printUrls = found;
            break;
          }
          lastError = new Error("O Melhor Envio não retornou um link de impressão.");
        } catch (error) {
          lastError = error;
        }
      }
      if (!printUrls.length) throw lastError || httpError(502, "Não foi possível obter o link de impressão da etiqueta.");

      await updateShippingLabel(env, orderNsu, {
        print_urls_json: JSON.stringify(printUrls),
        raw_print_json: JSON.stringify(printResult),
      });
    }

    const readyAt = nowIso();
    await updateShippingLabel(env, orderNsu, { status: "ready", ready_at: readyAt, error: null });
    await env.DB.prepare(`
      UPDATE orders SET label_status = 'ready', melhor_envio_shipment_id = COALESCE(melhor_envio_shipment_id, ?), updated_at = ?
      WHERE order_nsu = ?
    `).bind(shipmentIds[0], readyAt, orderNsu).run();

    return publicShippingLabelState(await getShippingLabelState(env, orderNsu));
  } catch (error) {
    const message = String(error?.message || error).slice(0, 800);
    await updateShippingLabel(env, orderNsu, { status: "error", error: message });
    await env.DB.prepare("UPDATE orders SET label_status = 'error', updated_at = ? WHERE order_nsu = ?")
      .bind(nowIso(), orderNsu).run();
    throw error;
  } finally {
    await env.DB.prepare("UPDATE shipping_labels SET claim_at = NULL, updated_at = ? WHERE order_nsu = ?")
      .bind(nowIso(), orderNsu).run().catch(() => {});
  }
}

async function rebuildShippingQuoteForOrder(env, order) {
  const items = await getOrderItems(env, order.order_nsu);
  if (!items.length) throw httpError(409, "O pedido não possui itens para gerar a etiqueta.");
  const cart = items.map((item) => {
    let frete = {};
    try { frete = JSON.parse(item.shipping_json || "{}"); } catch {}
    return {
      product: {
        id: item.product_id,
        nome: item.product_name,
        preco_centavos: Number(item.unit_price_cents),
        estoque: Number(item.quantity),
        frete,
      },
      quantity: Number(item.quantity),
    };
  });
  const quote = await quoteShipping(env, cart, order.postal_code);
  const selected = quote.options.find((option) => String(option.id) === String(order.shipping_service_id));
  if (!selected) throw httpError(409, "O serviço de frete original não está mais disponível para gerar a etiqueta.");
  return selected;
}

async function createMelhorEnvioCartEntries(env, order, quote, existingRecords = []) {
  const packages = Array.isArray(quote?.packages) ? quote.packages : [];
  if (!packages.length) throw httpError(409, "A cotação do Melhor Envio não retornou os volumes necessários para gerar a etiqueta.");

  const items = await getOrderItems(env, order.order_nsu);
  const requests = buildShipmentRequests(order, quote, items, packages);
  const records = [...existingRecords];

  for (const request of requests) {
    if (records.some((record) => record?.key === request.key && record?.id)) continue;
    const result = await melhorEnvioJson(env, "/api/v2/me/cart", {
      method: "POST",
      body: JSON.stringify(prepareShipmentPayload(env, request.payload)),
    });
    const id = extractShipmentId(result);
    if (!id) throw httpError(502, "O Melhor Envio não retornou o ID do envio adicionado ao carrinho.");
    records.push({ key: request.key, id, created_at: nowIso() });
    await updateShippingLabel(env, order.order_nsu, {
      status: "cart_created",
      shipments_json: JSON.stringify(records),
      cart_created_at: nowIso(),
    });
    await env.DB.prepare(`
      UPDATE orders SET melhor_envio_shipment_id = COALESCE(melhor_envio_shipment_id, ?), label_status = 'cart_created', updated_at = ?
      WHERE order_nsu = ?
    `).bind(id, nowIso(), order.order_nsu).run();
  }
  return records;
}

function buildShipmentRequests(order, quote, items, packages) {
  const service = Number(order.shipping_service_id);
  if (!Number.isInteger(service)) throw httpError(409, "ID do serviço do Melhor Envio inválido no pedido.");
  const carrierKey = normalizeCarrierKey(order.shipping_company);
  const mustSplit = packages.length > 1 && (carrierKey === "correios" || String(service) === "27");

  if (mustSplit) {
    return packages.map((pkg, index) => ({
      key: `package-${index}`,
      payloadFactory: true,
      packageIndexes: [index],
      package: pkg,
    })).map((entry) => ({
      key: entry.key,
      payload: buildShipmentPayloadFromParts(order, service, [entry.package], productsForPackage(items, entry.package)),
    }));
  }

  return [{
    key: "all",
    payload: buildShipmentPayloadFromParts(order, service, packages, items),
  }];
}

function buildShipmentPayloadFromParts(order, service, packages, items) {
  // O remetente é injetado mais adiante em prepareShipmentPayload, porque é
  // armazenado como secret do Worker e não no banco.
  const productList = items.map((item) => ({
    name: clean(item.product_name, 120),
    quantity: String(Math.max(1, Number(item.quantity || 1))),
    unitary_value: Number((Number(item.unit_price_cents) / 100).toFixed(2)),
  }));
  const insuranceValue = productList.reduce((sum, item) => sum + Number(item.unitary_value) * Number(item.quantity), 0);

  return {
    service,
    __needs_sender: true,
    to: {
      name: order.customer_name,
      email: order.customer_email,
      phone: order.customer_phone,
      document: order.customer_document,
      address: order.street,
      complement: order.complement || "",
      number: order.number,
      district: order.neighborhood,
      city: order.city,
      postal_code: order.postal_code,
      country_id: "BR",
      state_abbr: order.state,
    },
    products: productList,
    volumes: packages.map((pkg) => ({
      height: Number(pkg.height),
      width: Number(pkg.width),
      length: Number(pkg.length),
      weight: Number(pkg.weight),
    })),
    options: {
      platform: "Silly Cat Croche",
      reminder: `Pedido ${order.order_nsu}`,
      insurance_value: Number(insuranceValue.toFixed(2)),
      receipt: false,
      own_hand: false,
      reverse: false,
      tags: [{
        tag: order.order_nsu,
        url: null,
      }],
    },
  };
}

function productsForPackage(items, pkg) {
  const packageProducts = Array.isArray(pkg?.products) ? pkg.products : [];
  if (!packageProducts.length) return items;
  const quantities = new Map(packageProducts.map((item) => [String(item.id), Math.max(1, Number(item.quantity || 1))]));
  const selected = items
    .filter((item) => quantities.has(String(item.product_id)))
    .map((item) => ({ ...item, quantity: quantities.get(String(item.product_id)) }));
  return selected.length ? selected : items;
}

function prepareShipmentPayload(env, payload) {
  const prepared = structuredClone(payload);
  delete prepared.__needs_sender;
  prepared.from = parseSender(env);
  const storeUrl = String(env.STORE_URL || env.STORE_ORIGIN || "https://www.sillycatcroche.shop").replace(/\/$/, "");
  if (Array.isArray(prepared.options?.tags)) {
    prepared.options.tags = prepared.options.tags.map((tag) => ({ ...tag, url: `${storeUrl}/pedido.html?order_nsu=${encodeURIComponent(tag.tag)}` }));
  }
  return prepared;
}

async function updateShippingLabel(env, orderNsu, fields) {
  const allowed = new Set([
    "status", "quote_json", "shipments_json", "print_urls_json", "claim_at", "cart_created_at",
    "purchased_at", "generated_at", "ready_at", "error", "raw_checkout_json", "raw_generate_json", "raw_print_json",
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  entries.push(["updated_at", nowIso()]);
  const setSql = entries.map(([key]) => `${key} = ?`).join(", ");
  await env.DB.prepare(`UPDATE shipping_labels SET ${setSql} WHERE order_nsu = ?`)
    .bind(...entries.map(([, value]) => value ?? null), orderNsu).run();
}

function normalizeQuotePackages(packages) {
  if (!Array.isArray(packages)) return [];
  return packages.map((pkg) => ({
    height: Number(pkg?.dimensions?.height ?? pkg?.height),
    width: Number(pkg?.dimensions?.width ?? pkg?.width),
    length: Number(pkg?.dimensions?.length ?? pkg?.length),
    weight: Number(pkg?.weight),
    insurance_value: Number(pkg?.insurance_value || 0),
    products: Array.isArray(pkg?.products)
      ? pkg.products.map((item) => ({ id: String(item?.id || ""), quantity: Number(item?.quantity || 1) })).filter((item) => item.id)
      : [],
  })).filter((pkg) => pkg.height > 0 && pkg.width > 0 && pkg.length > 0 && pkg.weight > 0);
}

function publicShippingOption(option) {
  const { packages, ...safe } = option;
  return safe;
}

function extractShipmentId(data) {
  const candidates = [data?.id, data?.order?.id, data?.data?.id, data?.uuid];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function collectHttpUrls(value, found = new Set()) {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) found.add(value);
    return [...found];
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpUrls(item, found);
    return [...found];
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectHttpUrls(item, found);
  }
  return [...found];
}

function parseJsonArray(value) {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function parseJsonObject(value) {
  try { const parsed = JSON.parse(value || "null"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireAdmin(request, env) {
  requireConfig("ADMIN_API_KEY", env.ADMIN_API_KEY);
  const provided = String(request.headers.get("X-Admin-Key") || "");
  const expected = String(env.ADMIN_API_KEY || "");
  if (!constantTimeEqual(provided, expected)) throw httpError(401, "Não autorizado.");
}

function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function maybeSendSaleNotification(env, orderNsu) {
  if (!smtpConfigured(env)) {
    console.warn("[SMTP] Configuração ausente; venda foi registrada sem e-mail de notificação.");
    return;
  }

  const claimedAt = nowIso();
  const staleClaimBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const claim = await env.DB.prepare(`
    UPDATE orders SET notification_claimed_at = ?, notification_error = NULL
    WHERE order_nsu = ? AND status = 'paid' AND notification_sent_at IS NULL
      AND (notification_claimed_at IS NULL OR notification_claimed_at < ?)
  `).bind(claimedAt, orderNsu, staleClaimBefore).run();

  if (!Number(claim?.meta?.changes || 0)) return;

  try {
    const order = await getOrder(env, orderNsu);
    const items = await getOrderItems(env, orderNsu);
    const label = await getShippingLabelState(env, orderNsu).catch(() => null);
    const message = buildSaleEmail(order, items, label);
    await sendSmtpMail(env, message);
    await env.DB.prepare(`
      UPDATE orders SET notification_sent_at = ?, notification_claimed_at = NULL, notification_error = NULL, updated_at = ?
      WHERE order_nsu = ?
    `).bind(nowIso(), nowIso(), orderNsu).run();
  } catch (error) {
    await env.DB.prepare(`
      UPDATE orders SET notification_claimed_at = NULL, notification_error = ?, updated_at = ? WHERE order_nsu = ?
    `).bind(String(error?.message || error).slice(0, 500), nowIso(), orderNsu).run();
    console.error("[SMTP]", error?.message || error);
  }
}

function buildSaleEmail(order, items, label) {
  const productLines = items.map((item) => `${item.quantity}x ${item.product_name} — ${brl(Number(item.unit_price_cents) * Number(item.quantity))}`).join("\n");
  const productHtml = items.map((item) => `<li>${escapeHtml(item.quantity)}x ${escapeHtml(item.product_name)} — <b>${escapeHtml(brl(Number(item.unit_price_cents) * Number(item.quantity)))}</b></li>`).join("");
  const payment = order.capture_method === "pix" ? "Pix" : order.capture_method === "credit_card" ? "Cartão de crédito" : (order.capture_method || "Confirmado");
  const subject = `Nova venda Silly Cat — ${order.order_nsu}`;
  const addressLine = `${order.street}, ${order.number}${order.complement ? `, ${order.complement}` : ""} — ${order.neighborhood}`;
  const receiptText = order.receipt_url ? `\nComprovante: ${order.receipt_url}` : "";
  const labelUrls = parseJsonArray(label?.print_urls_json).filter((url) => typeof url === "string" && url);
  const labelText = label?.status === "ready"
    ? `\n\nETIQUETA MELHOR ENVIO\nPronta para impressão.${labelUrls.length ? `\n${labelUrls.join("\n")}` : ""}`
    : label?.status === "error"
      ? `\n\nETIQUETA MELHOR ENVIO\nFalha na geração automática: ${label.error || "erro não informado"}`
      : `\n\nETIQUETA MELHOR ENVIO\nAinda não gerada automaticamente.`;

  const text = `Nova venda confirmada!\n\nPedido: ${order.order_nsu}\n\nPRODUTOS\n${productLines}\n\nFRETE\n${order.shipping_company} · ${order.shipping_service_name} — ${brl(order.shipping_cents)}\nPrazo estimado: ${order.shipping_deadline_days || "-"} dia(s) útil(eis)\n\nTOTAL: ${brl(order.total_cents)}\nPagamento: ${payment}\n\nDESTINATÁRIO\n${order.customer_name}\nCPF: ${formatCpf(order.customer_document)}\nTelefone: ${order.customer_phone}\nE-mail: ${order.customer_email}\n\nENDEREÇO\n${addressLine}\n${order.city} - ${order.state}\nCEP ${formatCep(order.postal_code)}${receiptText}${labelText}\n`;

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">
    <h2>🧶 Nova venda confirmada!</h2>
    <p><b>Pedido:</b> ${escapeHtml(order.order_nsu)}</p>
    <h3>Produtos</h3><ul>${productHtml}</ul>
    <p><b>Frete:</b> ${escapeHtml(order.shipping_company)} · ${escapeHtml(order.shipping_service_name)} — ${escapeHtml(brl(order.shipping_cents))}<br>
    <b>Prazo estimado:</b> ${escapeHtml(order.shipping_deadline_days || "-")} dia(s) útil(eis)</p>
    <p style="font-size:1.15em"><b>Total: ${escapeHtml(brl(order.total_cents))}</b><br>Pagamento: ${escapeHtml(payment)}</p>
    <h3>Destinatário</h3>
    <p>${escapeHtml(order.customer_name)}<br>CPF: ${escapeHtml(formatCpf(order.customer_document))}<br>Telefone: ${escapeHtml(order.customer_phone)}<br>E-mail: ${escapeHtml(order.customer_email)}</p>
    <h3>Endereço</h3>
    <p>${escapeHtml(addressLine)}<br>${escapeHtml(order.city)} - ${escapeHtml(order.state)}<br>CEP ${escapeHtml(formatCep(order.postal_code))}</p>
    ${order.receipt_url ? `<p><a href="${escapeHtml(order.receipt_url)}">Ver comprovante da InfinitePay</a></p>` : ""}
    ${label?.status === "ready" ? `<h3>Etiqueta Melhor Envio</h3><p>Pronta para impressão.</p>${labelUrls.map((url, index) => `<p><a href="${escapeHtml(url)}">Abrir etiqueta${labelUrls.length > 1 ? ` ${index + 1}` : ""}</a></p>`).join("")}` : ""}
    ${label?.status === "error" ? `<h3>Etiqueta Melhor Envio</h3><p><b>Falha na geração automática:</b> ${escapeHtml(label.error || "erro não informado")}</p>` : ""}
  </body></html>`;

  return { subject, text, html };
}

async function sendSmtpMail(env, { subject, text, html }) {
  const host = clean(env.SMTP_HOST, 180);
  const port = Number(env.SMTP_PORT || 465);
  const security = String(env.SMTP_SECURITY || "implicit").toLowerCase();
  const user = clean(env.SMTP_USER, 200);
  const password = String(env.SMTP_PASSWORD || "");
  const from = clean(env.SMTP_FROM || user, 240);
  const to = clean(env.SALE_NOTIFICATION_TO, 240);

  if (!host || !user || !password || !from || !to) throw new Error("SMTP incompleto.");
  if (![465, 587, 2525].includes(port)) throw new Error("Use uma porta SMTP de submissão como 465 ou 587; porta 25 não é permitida em Workers.");

  let socket = connect({ hostname: host, port }, { secureTransport: security === "starttls" ? "starttls" : "on" });
  await socket.opened;
  let io = smtpIo(socket);

  try {
    await smtpExpect(io, 220);
    await smtpCommand(io, `EHLO sillycatcroche.shop`, 250);

    if (security === "starttls") {
      await smtpCommand(io, "STARTTLS", 220);
      io.release();
      socket = socket.startTls();
      await socket.opened;
      io = smtpIo(socket);
      await smtpCommand(io, `EHLO sillycatcroche.shop`, 250);
    }

    await smtpCommand(io, "AUTH LOGIN", 334);
    await smtpCommand(io, base64Utf8(user), 334);
    await smtpCommand(io, base64Utf8(password), 235);

    const envelopeFrom = extractEmail(from);
    const envelopeTo = extractEmail(to);
    await smtpCommand(io, `MAIL FROM:<${envelopeFrom}>`, 250);
    await smtpCommand(io, `RCPT TO:<${envelopeTo}>`, [250, 251]);
    await smtpCommand(io, "DATA", 354);

    const boundary = `sillycat_${crypto.randomUUID().replace(/-/g, "")}`;
    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${base64Utf8(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@sillycatcroche.shop>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      html,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n").replace(/^\./gm, "..");

    await io.write(`${message}\r\n.\r\n`);
    await smtpExpect(io, 250);
    await smtpCommand(io, "QUIT", 221).catch(() => {});
  } finally {
    try { io.release(); } catch {}
    try { await socket.close(); } catch {}
  }
}

function smtpIo(socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  async function readLine() {
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        return line.replace(/\r?\n$/, "");
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("Servidor SMTP encerrou a conexão inesperadamente.");
      buffer += decoder.decode(value, { stream: true });
    }
  }

  async function readResponse() {
    const first = await readLine();
    const code = Number(first.slice(0, 3));
    const lines = [first];
    if (!Number.isInteger(code)) throw new Error(`Resposta SMTP inválida: ${first}`);
    if (first[3] === "-") {
      while (true) {
        const line = await readLine();
        lines.push(line);
        if (line.startsWith(`${code} `)) break;
      }
    }
    return { code, text: lines.join("\n") };
  }

  async function write(data) {
    await writer.write(encoder.encode(data));
  }

  function release() {
    try { reader.releaseLock(); } catch {}
    try { writer.releaseLock(); } catch {}
  }

  return { readResponse, write, release };
}

async function smtpExpect(io, expected) {
  const response = await io.readResponse();
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(response.code)) throw new Error(`SMTP ${response.code}: ${response.text}`);
  return response;
}

async function smtpCommand(io, command, expected) {
  await io.write(`${command}\r\n`);
  return smtpExpect(io, expected);
}

function smtpConfigured(env) {
  return Boolean(configured(env.SMTP_HOST) && configured(env.SMTP_USER) && configured(env.SMTP_PASSWORD) && configured(env.SALE_NOTIFICATION_TO));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.message || data?.error || data?.errors?.[0]?.message || `Erro HTTP ${response.status}`;
    throw httpError(response.status >= 500 ? 502 : response.status, message, data);
  }
  return data;
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 65536) throw httpError(413, "Requisição muito grande.");
  try { return await request.json(); }
  catch { throw httpError(400, "JSON inválido."); }
}

function json(request, env, status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request, env) },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const production = String(env.STORE_ORIGIN || env.STORE_URL || "https://www.sillycatcroche.shop").replace(/\/$/, "");
  const allowed = new Set([
    production,
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:8788",
    "http://localhost:8788",
  ]);
  if (!origin || !allowed.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function makeOrderNsu() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `SC-${stamp}-${random}`;
}

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function requireConfig(name, value) {
  if (!configured(value)) throw httpError(503, `Configuração ausente: ${name}`);
}

function configured(value) {
  return Boolean(value && !/^(cole_|seu_|sua_|exemplo|COLE_)/i.test(String(value).trim()));
}

function clean(value, max = 250) {
  return String(value || "").trim().slice(0, max);
}

function normalizeCarrierKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function allowedCarrierNames(env) {
  const raw = clean(env.MELHOR_ENVIO_ALLOWED_CARRIERS, 250) || "Correios,Jadlog";
  if (["*", "all", "todos"].includes(raw.trim().toLowerCase())) return ["Todas"];
  return raw.split(",").map((name) => name.trim()).filter(Boolean);
}

function allowedCarrierKeys(env) {
  const names = allowedCarrierNames(env);
  if (names.length === 1 && names[0] === "Todas") return null;
  return new Set(names.map(normalizeCarrierKey).filter(Boolean));
}

function digits(value) { return String(value || "").replace(/\D/g, ""); }

function moneyToCents(value) {
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function normalizePhone(value) {
  const phone = digits(value);
  return phone.startsWith("55") ? `+${phone}` : `+55${phone}`;
}

function isValidCpf(value) {
  const cpf = digits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(cpf[i]) * (length + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

function nowIso() { return new Date().toISOString(); }

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function brl(cents) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents || 0) / 100);
}

function formatCpf(value) {
  const d = digits(value);
  return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : d;
}

function formatCep(value) {
  const d = digits(value);
  return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, "$1-$2") : d;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function extractEmail(value) {
  const match = String(value).match(/<([^<>]+)>/);
  const email = (match ? match[1] : String(value)).trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || /[\r\n]/.test(email)) throw new Error("Endereço SMTP inválido.");
  return email;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;",
  })[char]);
}
