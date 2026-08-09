import { connect } from "cloudflare:sockets";
import catalog from "../../catalogo.json" with { type: "json" };

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
      smtp_configured: smtpConfigured(env),
    });
  }

  if (request.method === "GET" && path === "/api/catalog") {
    const safe = catalog.map(({ frete, ...product }) => ({ ...product, frete_provisorio: Boolean(frete?.provisorio) }));
    return json(request, env, 200, safe);
  }

  if (request.method === "POST" && path === "/api/shipping/quote") {
    const body = await readJson(request);
    const cart = resolveCart(body.items);
    const result = await quoteShipping(env, cart, body.postalCode);
    return json(request, env, 200, { subtotal_centavos: cartSubtotal(cart), ...result });
  }

  if (request.method === "POST" && path === "/api/checkout") {
    const body = await readJson(request);
    const cart = resolveCart(body.items);
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
        frete: shipping,
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
      if (verified.paid) ctx.waitUntil(maybeSendSaleNotification(env, identifiers.orderNsu));
    } else if (!existing.notification_sent_at) {
      ctx.waitUntil(maybeSendSaleNotification(env, identifiers.orderNsu));
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
          if (verified.paid) await maybeSendSaleNotification(env, orderNsu);
        } catch (error) {
          console.error("[InfinitePay webhook verification]", error?.message || error);
        }
      })());
    }

    return json(request, env, 200, { success: true, message: null });
  }

  return json(request, env, 404, { error: "Rota não encontrada." });
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

function resolveCart(items) {
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
  const options = data
    .filter((item) => item && !item.error && (item.custom_price ?? item.price) != null)
    .map((item) => ({
      id: String(item.id),
      nome: String(item.name || "Frete"),
      transportadora: String(item.company?.name || "Transportadora"),
      preco_centavos: moneyToCents(item.custom_price ?? item.price),
      prazo_dias: Number(item.custom_delivery_time ?? item.delivery_time ?? 0) || null,
    }))
    .filter((item) => Number.isInteger(item.preco_centavos) && item.preco_centavos >= 0)
    .sort((a, b) => a.preco_centavos - b.preco_centavos);

  if (!options.length) {
    const errors = data.filter((item) => item?.error).map((item) => item.error).filter(Boolean);
    throw httpError(422, errors[0] || "Nenhuma opção de frete foi encontrada para esse CEP.");
  }

  return {
    options,
    provisionalProducts: cart.filter((item) => item.product.frete?.provisorio).map((item) => item.product.nome),
  };
}

async function savePendingOrder(env, data) {
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

  await env.DB.batch([orderStatement, ...itemStatements]);
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

  if (order.status === "paid") return publicOrderStatus(order);

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
    const message = buildSaleEmail(order, items);
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

function buildSaleEmail(order, items) {
  const productLines = items.map((item) => `${item.quantity}x ${item.product_name} — ${brl(Number(item.unit_price_cents) * Number(item.quantity))}`).join("\n");
  const productHtml = items.map((item) => `<li>${escapeHtml(item.quantity)}x ${escapeHtml(item.product_name)} — <b>${escapeHtml(brl(Number(item.unit_price_cents) * Number(item.quantity)))}</b></li>`).join("");
  const payment = order.capture_method === "pix" ? "Pix" : order.capture_method === "credit_card" ? "Cartão de crédito" : (order.capture_method || "Confirmado");
  const subject = `Nova venda Silly Cat — ${order.order_nsu}`;
  const addressLine = `${order.street}, ${order.number}${order.complement ? `, ${order.complement}` : ""} — ${order.neighborhood}`;
  const receiptText = order.receipt_url ? `\nComprovante: ${order.receipt_url}` : "";

  const text = `Nova venda confirmada!\n\nPedido: ${order.order_nsu}\n\nPRODUTOS\n${productLines}\n\nFRETE\n${order.shipping_company} · ${order.shipping_service_name} — ${brl(order.shipping_cents)}\nPrazo estimado: ${order.shipping_deadline_days || "-"} dia(s) útil(eis)\n\nTOTAL: ${brl(order.total_cents)}\nPagamento: ${payment}\n\nDESTINATÁRIO\n${order.customer_name}\nCPF: ${formatCpf(order.customer_document)}\nTelefone: ${order.customer_phone}\nE-mail: ${order.customer_email}\n\nENDEREÇO\n${addressLine}\n${order.city} - ${order.state}\nCEP ${formatCep(order.postal_code)}${receiptText}\n`;

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
