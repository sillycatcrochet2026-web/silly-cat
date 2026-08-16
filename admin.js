(() => {
  "use strict";

  const TOKEN_KEY = "sillycat_admin_session";
  let PRODUCTS = [];
  let IMAGE_UPLOAD_ENABLED = false;
  let PRODUCTION_ORDERS = [];
  let editingId = null;

  const $ = (id) => document.getElementById(id);
  const apiBaseUrl = () => String(window.SILLY_CAT_ECOMMERCE?.apiBaseUrl || "").replace(/\/$/, "");
  const apiUrl = (path) => `${apiBaseUrl()}${path}`;
  const token = () => sessionStorage.getItem(TOKEN_KEY) || "";
  const money = (cents) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents || 0) / 100);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (token()) headers.set("Authorization", `Bearer ${token()}`);
    if (options.body && !(options.body instanceof ArrayBuffer) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(apiUrl(path), { ...options, headers, cache: "no-store" });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/admin/login") logout(false);
      throw new Error(typeof data === "object" ? (data.error || data.message || `Erro ${response.status}`) : data || `Erro ${response.status}`);
    }
    return { data, response };
  }

  function setLoginMessage(message, ok = false) {
    const el = $("loginMessage");
    el.textContent = message || "";
    el.style.color = ok ? "#2d6a4f" : "";
  }

  function setStatus(message, isError = false) {
    const el = $("statusLine");
    el.textContent = message || "";
    el.style.color = isError ? "#9e1b13" : "";
  }

  async function login(key) {
    const button = $("loginButton");
    button.disabled = true;
    setLoginMessage("Entrando…", true);
    try {
      const { data } = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ key }) });
      sessionStorage.setItem(TOKEN_KEY, data.token);
      $("adminKey").value = "";
      await showDashboard();
    } catch (error) {
      setLoginMessage(error.message || "Não foi possível entrar.");
    } finally {
      button.disabled = false;
    }
  }

  async function logout(callApi = true) {
    if (callApi && token()) {
      try { await api("/api/admin/logout", { method: "POST" }); } catch {}
    }
    sessionStorage.removeItem(TOKEN_KEY);
    $("dashboard").hidden = true;
    $("loginPanel").hidden = false;
    setLoginMessage("");
  }

  async function showDashboard() {
    $("loginPanel").hidden = true;
    $("dashboard").hidden = false;
    try {
      await Promise.all([loadProducts(), loadProductionOrders()]);
    } catch (error) {
      if (!token()) return;
      setStatus(error.message, true);
    }
  }

  async function loadProducts() {
    setStatus("Carregando inventário…");
    const { data } = await api("/api/admin/products?include_archived=1");
    PRODUCTS = data.products || [];
    IMAGE_UPLOAD_ENABLED = Boolean(data.image_upload_enabled);
    renderSummary(data.summary || {});
    renderProducts();
    $("imageNotice").hidden = IMAGE_UPLOAD_ENABLED;
    if (!IMAGE_UPLOAD_ENABLED) {
      $("imageNotice").textContent = "Upload direto de imagens ainda não está configurado. Você pode continuar usando caminhos img/... ou URLs HTTPS. Para upload pelo painel, configure o bucket R2 PRODUCT_IMAGES.";
    }
    setStatus(`Atualizado agora · ${PRODUCTS.length} produto(s) cadastrado(s)`);
  }

  function renderSummary(summary) {
    $("metricActive").textContent = summary.active ?? 0;
    $("metricUnits").textContent = summary.units ?? 0;
    $("metricSoldOut").textContent = summary.sold_out ?? 0;
    $("metricArchived").textContent = summary.archived ?? 0;
  }

  async function loadProductionOrders() {
    const { data } = await api("/api/admin/orders/production-pending");
    PRODUCTION_ORDERS = Array.isArray(data.orders) ? data.orders : [];
    $("metricProduction").textContent = PRODUCTION_ORDERS.length;
    renderProductionOrders();
  }

  function renderProductionOrders() {
    const list = $("productionOrders");
    const empty = $("productionEmpty");
    if (!list || !empty) return;
    empty.hidden = PRODUCTION_ORDERS.length > 0;
    list.innerHTML = PRODUCTION_ORDERS.map((order) => {
      const items = (order.items || []).map((item) => {
        const needed = Number(item.production_quantity || 0);
        return `<li>${escapeHtml(item.quantity)}x ${escapeHtml(item.product_name)}${item.variant_name ? ` · <em>${escapeHtml(item.variant_name)}</em>` : ""}${needed > 0 ? ` · <b>produzir ${needed}</b>` : ""}</li>`;
      }).join("");
      const paidAt = order.paid_at ? new Date(order.paid_at).toLocaleString("pt-BR") : "—";
      const productionReady = order.production_status === "ready";
      return `<article class="production-order-card">
        <div class="production-order-main">
          <div class="production-order-head"><strong>${escapeHtml(order.order_nsu)}</strong><span>${escapeHtml(paidAt)}</span></div>
          <p><b>${escapeHtml(order.customer_name || "Cliente")}</b> · ${money(order.total_cents)}</p>
          <ul>${items}</ul>
          <p class="production-order-shipping">${escapeHtml(order.shipping_company || "")} · ${escapeHtml(order.shipping_service_name || "")} · prazo de envio ${escapeHtml(order.shipping_deadline_days || "-")} dia(s)</p>
          ${productionReady ? `<p class="production-order-ready">✓ Produção concluída; etiqueta ainda pendente.</p>` : ""}
        </div>
        <button class="primary-btn production-ready-btn" type="button" data-production-ready="${escapeHtml(order.order_nsu)}">${productionReady ? "Tentar gerar etiqueta" : "Produção concluída + gerar etiqueta"}</button>
      </article>`;
    }).join("");

    list.querySelectorAll("[data-production-ready]").forEach((button) => {
      button.addEventListener("click", () => finishProduction(button.dataset.productionReady, button));
    });
  }

  async function finishProduction(orderNsu, button) {
    if (!confirm(`Confirmar que toda a produção do pedido ${orderNsu} foi concluída? A etiqueta do Melhor Envio será gerada agora e poderá consumir saldo.`)) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Gerando etiqueta…";
    try {
      const { data } = await api(`/api/admin/orders/${encodeURIComponent(orderNsu)}/production-ready`, { method: "POST" });
      const urls = data?.label?.print_urls || [];
      setStatus(urls.length ? `Produção concluída. Etiqueta pronta: ${urls[0]}` : "Produção concluída. Etiqueta processada pelo Melhor Envio.");
      await loadProductionOrders();
    } catch (error) {
      setStatus(`Produção marcada como concluída, mas a etiqueta não pôde ser finalizada: ${error.message}`, true);
      await loadProductionOrders().catch(() => {});
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function filteredProducts() {
    const query = $("searchInput").value.trim().toLowerCase();
    const filter = $("statusFilter").value;
    return PRODUCTS.filter((product) => {
      const variantText = (product.variacoes || []).map((v) => v.nome).join(" ");
      const matchText = !query || `${product.nome} ${product.id} ${product.categoria || ""} ${variantText}`.toLowerCase().includes(query);
      if (!matchText) return false;
      if (filter === "active") return product.active;
      if (filter === "available") return product.active && Number(product.estoque) > 0;
      if (filter === "soldout") return product.active && Number(product.estoque) <= 0;
      if (filter === "archived") return !product.active;
      return true;
    });
  }

  function statusBadge(product) {
    if (!product.active) return `<span class="badge archived">ARQUIVADO</span>`;
    if (Number(product.estoque) <= 0) return `<span class="badge soldout">ESGOTADO</span>`;
    return `<span class="badge available">DISPONÍVEL</span>`;
  }

  function renderProducts() {
    const list = $("productList");
    const items = filteredProducts();
    $("emptyState").hidden = items.length > 0;
    list.innerHTML = items.map((product) => {
      const provisional = product.frete?.provisorio ? `<span class="badge provisional">MEDIDAS PROVISÓRIAS</span>` : "";
      const image = product.img ? `<img class="product-thumb" src="${escapeHtml(product.img)}" alt="">` : `<div class="product-thumb thumb-placeholder">sem imagem</div>`;
      const variants = Array.isArray(product.variacoes) ? product.variacoes : [];
      const variantInfo = variants.length ? `<div class="product-variant-summary">${variants.length} variação(ões) · estoque total ${Number(product.estoque || 0)}</div>` : "";
      const category = `<span class="badge category">${escapeHtml(product.categoria_label || product.categoria || "Outros")}</span>`;
      const stockControl = variants.length
        ? `<div class="stock-control variant-stock-readonly"><span>${Number(product.estoque || 0)}</span><small>pelas variações</small></div>`
        : `<div class="stock-control" aria-label="Estoque de ${escapeHtml(product.nome)}"><button type="button" data-stock-minus="${escapeHtml(product.id)}">−</button><input type="number" min="0" max="9999" value="${Number(product.estoque || 0)}" data-stock-input="${escapeHtml(product.id)}" aria-label="Quantidade em estoque"><button type="button" data-stock-plus="${escapeHtml(product.id)}">+</button></div>`;
      return `<article class="product-row" data-id="${escapeHtml(product.id)}">
        ${image}
        <div class="product-main"><h3>${escapeHtml(product.nome)}</h3><div class="product-id">${escapeHtml(product.id)}</div>${statusBadge(product)}${provisional}${category}${variantInfo}</div>
        <div class="product-price">${money(product.preco_centavos)}</div>
        ${stockControl}
        <div class="product-shipping">${Number(product.frete?.largura)} × ${Number(product.frete?.altura)} × ${Number(product.frete?.comprimento)} cm<br>${Number(product.frete?.peso)} kg</div>
        <div class="row-actions">${variants.length ? "" : `<button class="mini-btn primary" type="button" data-save-stock="${escapeHtml(product.id)}">Salvar estoque</button>`}<button class="mini-btn" type="button" data-edit="${escapeHtml(product.id)}">Editar</button>${product.active ? "" : `<button class="mini-btn" type="button" data-restore="${escapeHtml(product.id)}">Restaurar</button>`}</div>
      </article>`;
    }).join("");
    list.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => openEditor(btn.dataset.edit)));
    list.querySelectorAll("[data-restore]").forEach((btn) => btn.addEventListener("click", () => restoreProduct(btn.dataset.restore)));
    list.querySelectorAll("[data-stock-minus]").forEach((btn) => btn.addEventListener("click", () => nudgeStock(btn.dataset.stockMinus, -1)));
    list.querySelectorAll("[data-stock-plus]").forEach((btn) => btn.addEventListener("click", () => nudgeStock(btn.dataset.stockPlus, 1)));
    list.querySelectorAll("[data-save-stock]").forEach((btn) => btn.addEventListener("click", () => saveQuickStock(btn.dataset.saveStock)));
  }

  function nudgeStock(id, delta) {
    const input = document.querySelector(`[data-stock-input="${CSS.escape(id)}"]`); if (!input) return;
    input.value = Math.max(0, Number(input.value || 0) + delta);
  }

  async function saveQuickStock(id) {
    const input = document.querySelector(`[data-stock-input="${CSS.escape(id)}"]`);
    const stock = Math.max(0, Math.floor(Number(input?.value || 0)));
    setStatus(`Atualizando estoque de ${id}…`);
    try { await api(`/api/admin/products/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ stock, stock_reason: "Ajuste rápido pelo painel" }) }); await loadProducts(); }
    catch (error) { setStatus(error.message, true); }
  }

  function variantSlug(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0,80);
  }

  function addVariantRow(variant = {}) {
    const rows = $("variantRows");
    const row = document.createElement("div"); row.className = "variant-row";
    row.innerHTML = `<label>Nome<input class="variant-name" type="text" maxlength="100" value="${escapeHtml(variant.nome || variant.name || "")}" placeholder="Amarelo" required></label><label>ID<input class="variant-id" type="text" maxlength="80" value="${escapeHtml(variant.id || "")}" placeholder="amarelo" required></label><label>Estoque<input class="variant-stock" type="number" min="0" max="9999" step="1" value="${Number(variant.estoque ?? variant.stock ?? 0)}" required></label><label>Preço próprio (R$)<input class="variant-price" type="number" min="0" step="0.01" value="${variant.preco_proprio_centavos != null ? (Number(variant.preco_proprio_centavos)/100).toFixed(2) : ""}" placeholder="herda o base"></label><button class="icon-btn variant-remove" type="button" aria-label="Remover variação">×</button>`;
    const nameInput=row.querySelector(".variant-name"), idInput=row.querySelector(".variant-id");
    nameInput.addEventListener("input",()=>{ if(!idInput.dataset.touched) idInput.value=variantSlug(nameInput.value); });
    idInput.addEventListener("input",()=>{ idInput.dataset.touched="1"; idInput.value=variantSlug(idInput.value); });
    row.querySelector(".variant-remove").addEventListener("click",()=>{row.remove();syncVariantStockMode();});
    rows.appendChild(row); syncVariantStockMode();
  }

  function syncVariantStockMode() {
    const has = $("variantRows").children.length > 0;
    $("variantEmptyHelp").hidden = has;
    $("productStock").disabled = has;
    if (has) $("productStock").title = "O estoque é definido individualmente nas variações."; else $("productStock").title = "";
  }

  function collectVariants() {
    return [...$("variantRows").querySelectorAll(".variant-row")].map(row=>{
      const priceText=row.querySelector(".variant-price").value.trim();
      return { id:variantSlug(row.querySelector(".variant-id").value), name:row.querySelector(".variant-name").value.trim(), stock:Math.max(0,Math.floor(Number(row.querySelector(".variant-stock").value||0))), price_cents:priceText===""?null:Math.round(Number(priceText)*100), active:true };
    });
  }

  function currentImageRefs() {
    return $("productImageRefs").value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
  }

  function updateImagePreview(sources = []) {
    const preview = $("imagePreview"); const list = Array.isArray(sources) ? sources.filter(Boolean) : (sources ? [sources] : []);
    if (!list.length) { preview.innerHTML = "<span>Sem imagem</span>"; return; }
    preview.innerHTML = list.map((src,index)=>`<div class="admin-image-tile"><img src="${escapeHtml(src)}" alt="Prévia ${index+1}"><span>${index===0?"CAPA":index+1}</span></div>`).join("");
  }

  function openEditor(id = null) {
    editingId = id;
    const product = id ? PRODUCTS.find((item) => item.id === id) : null;
    $("dialogEyebrow").textContent = product ? "Editar produto" : "Novo produto";
    $("dialogTitle").textContent = product ? product.nome : "Cadastrar produto";
    $("productId").value = product?.id || ""; $("productId").readOnly = Boolean(product);
    $("productName").value = product?.nome || ""; $("productDescription").value = product?.desc || "";
    $("productPrice").value = product ? (Number(product.preco_centavos) / 100).toFixed(2) : "";
    $("productStock").value = product?.estoque ?? 1; $("productCategory").value = product?.categoria || "outros";
    $("productTag").value = String(product?.tag || "").toLowerCase() === "novo" ? "Novo" : "";
    $("productSortOrder").value = product?.sort_order ?? (PRODUCTS.length ? Math.max(...PRODUCTS.map((p) => Number(p.sort_order || 0))) + 1 : 0);
    $("productActive").checked = product ? Boolean(product.active) : true;
    $("productWidth").value = product?.frete?.largura ?? ""; $("productHeight").value = product?.frete?.altura ?? ""; $("productLength").value = product?.frete?.comprimento ?? ""; $("productWeight").value = product?.frete?.peso ?? "";
    $("productProvisional").checked = Boolean(product?.frete?.provisorio);
    const refs = Array.isArray(product?.image_refs) ? product.image_refs : (product?.image_ref ? [product.image_ref] : []);
    $("productImageRefs").value = refs.join("\n"); $("productImageFile").value = ""; $("productImageFile").disabled = !IMAGE_UPLOAD_ENABLED;
    $("imageUploadHelp").textContent = IMAGE_UPLOAD_ENABLED ? "JPG, PNG, WebP ou GIF, até 6 MB por imagem." : "Configure o R2 para enviar arquivos diretamente pelo painel.";
    $("variantRows").innerHTML = ""; (product?.variacoes || []).forEach(addVariantRow); syncVariantStockMode();
    $("dangerZone").style.visibility = product ? "visible" : "hidden"; $("archiveProductButton").textContent = product?.active === false ? "Produto arquivado" : "Arquivar produto"; $("archiveProductButton").disabled = product?.active === false; $("historyButton").disabled = !product;
    setProductMessage(""); updateImagePreview(product?.images || (product?.img ? [product.img] : [])); $("productDialog").showModal();
  }

  function setProductMessage(message, ok = false) { const el = $("productMessage"); el.textContent = message || ""; el.style.color = ok ? "#2d6a4f" : ""; }

  function productPayload() {
    const variants=collectVariants();
    const payload = {
      id: $("productId").value.trim(), name: $("productName").value.trim(), description: $("productDescription").value.trim(), price_cents: Math.round(Number($("productPrice").value || 0) * 100),
      tag: $("productTag").value, category: $("productCategory").value, sort_order: Math.trunc(Number($("productSortOrder").value || 0)), active: $("productActive").checked,
      width_cm: Number($("productWidth").value), height_cm: Number($("productHeight").value), length_cm: Number($("productLength").value), weight_kg: Number($("productWeight").value), shipping_provisional: $("productProvisional").checked,
      image_refs: currentImageRefs(), variants, stock_reason: editingId ? "Edição do produto pelo painel" : "Cadastro inicial",
    };
    if(!variants.length) payload.stock=Math.max(0,Math.floor(Number($("productStock").value||0)));
    return payload;
  }

  async function saveProduct(event) {
    event.preventDefault(); const button=$("saveProductButton"); button.disabled=true; setProductMessage("Salvando…",true);
    try {
      const payload=productPayload(); const path=editingId?`/api/admin/products/${encodeURIComponent(editingId)}`:"/api/admin/products"; const method=editingId?"PUT":"POST";
      const {data}=await api(path,{method,body:JSON.stringify(payload)}); const id=data.id;
      const files=[...($("productImageFile").files||[])];
      if(files.length){
        if(!IMAGE_UPLOAD_ENABLED) throw new Error("O R2 ainda não está configurado para upload de imagens.");
        for(let i=0;i<files.length;i++){
          const file=files[i]; setProductMessage(`Produto salvo. Enviando imagem ${i+1}/${files.length}…`,true);
          await api(`/api/admin/products/${encodeURIComponent(id)}/images`,{method:"POST",headers:{"Content-Type":file.type},body:await file.arrayBuffer()});
        }
      }
      $("productDialog").close(); await loadProducts(); setStatus(`${data.nome || payload.name} salvo com sucesso.`);
    } catch(error){ setProductMessage(error.message || "Não foi possível salvar."); }
    finally { button.disabled=false; }
  }


  async function archiveProduct() {
    if (!editingId) return;
    const product = PRODUCTS.find((item) => item.id === editingId);
    if (!confirm(`Arquivar “${product?.nome || editingId}”? Ele sairá da loja, mas o histórico de vendas será preservado.`)) return;
    try {
      await api(`/api/admin/products/${encodeURIComponent(editingId)}`, { method: "DELETE" });
      $("productDialog").close();
      await loadProducts();
      setStatus("Produto arquivado.");
    } catch (error) { setProductMessage(error.message); }
  }

  async function restoreProduct(id) {
    try {
      await api(`/api/admin/products/${encodeURIComponent(id)}/restore`, { method: "POST" });
      await loadProducts();
      setStatus("Produto restaurado para a loja.");
    } catch (error) { setStatus(error.message, true); }
  }

  async function showHistory() {
    if (!editingId) return;
    const product = PRODUCTS.find((item) => item.id === editingId);
    $("historyTitle").textContent = `Estoque · ${product?.nome || editingId}`;
    $("historyList").innerHTML = "<p>Carregando…</p>";
    $("historyDialog").showModal();
    try {
      const { data } = await api(`/api/admin/products/${encodeURIComponent(editingId)}/inventory-history`);
      const history = data.history || [];
      $("historyList").innerHTML = history.length ? history.map((item) => {
        const delta = Number(item.delta || 0);
        const sign = delta > 0 ? "+" : "";
        const klass = delta > 0 ? "positive" : delta < 0 ? "negative" : "";
        const detail = item.kind === "sale" ? `Pedido ${escapeHtml(item.ref)}` : escapeHtml(item.reason || "Ajuste manual");
        return `<div class="history-item"><time>${new Date(item.created_at).toLocaleString("pt-BR")}</time><span>${detail}</span><strong class="${klass}">${sign}${delta}</strong></div>`;
      }).join("") : "<p>Nenhuma movimentação registrada.</p>";
    } catch (error) { $("historyList").innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
  }

  async function exportCatalog() {
    try {
      const { data } = await api("/api/admin/catalog/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `catalogo-silly-cat-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) { setStatus(error.message, true); }
  }

  $("loginForm").addEventListener("submit", (event) => { event.preventDefault(); login($("adminKey").value); });
  $("togglePassword").addEventListener("click", () => { $("adminKey").type = $("adminKey").type === "password" ? "text" : "password"; });
  $("logoutButton").addEventListener("click", () => logout(true));
  $("refreshButton").addEventListener("click", () => Promise.all([loadProducts(), loadProductionOrders()]).catch((e) => setStatus(e.message, true)));
  $("refreshProductionButton").addEventListener("click", () => loadProductionOrders().catch((e) => setStatus(e.message, true)));
  $("exportButton").addEventListener("click", exportCatalog);
  $("newProductButton").addEventListener("click", () => openEditor());
  $("searchInput").addEventListener("input", renderProducts);
  $("statusFilter").addEventListener("change", renderProducts);
  $("productForm").addEventListener("submit", saveProduct);
  $("closeProductDialog").addEventListener("click", () => $("productDialog").close());
  $("cancelProductButton").addEventListener("click", () => $("productDialog").close());
  $("archiveProductButton").addEventListener("click", archiveProduct);
  $("historyButton").addEventListener("click", showHistory);
  $("closeHistoryDialog").addEventListener("click", () => $("historyDialog").close());
  $("addVariantButton").addEventListener("click", () => addVariantRow());
  $("productImageRefs").addEventListener("input", () => updateImagePreview(currentImageRefs().filter(ref => !ref.startsWith("r2:"))));
  $("productImageFile").addEventListener("change", () => {
    const files = [...($("productImageFile").files || [])];
    if (files.length) updateImagePreview(files.map(file => URL.createObjectURL(file)));
  });
  $("productName").addEventListener("input", () => {
    if (editingId || $("productId").value.trim()) return;
    const slug = $("productName").value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
    $("productId").value = slug;
  });

  if (token()) showDashboard();
})();
