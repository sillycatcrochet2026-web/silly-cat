(() => {
  "use strict";

  const TOKEN_KEY = "sillycat_admin_session";
  let PRODUCTS = [];
  let IMAGE_UPLOAD_ENABLED = false;
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
      await loadProducts();
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

  function filteredProducts() {
    const query = $("searchInput").value.trim().toLowerCase();
    const filter = $("statusFilter").value;
    return PRODUCTS.filter((product) => {
      const matchText = !query || `${product.nome} ${product.id}`.toLowerCase().includes(query);
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
      return `<article class="product-row" data-id="${escapeHtml(product.id)}">
        ${image}
        <div class="product-main">
          <h3>${escapeHtml(product.nome)}</h3>
          <div class="product-id">${escapeHtml(product.id)}</div>
          ${statusBadge(product)}${provisional}
        </div>
        <div class="product-price">${money(product.preco_centavos)}</div>
        <div class="stock-control" aria-label="Estoque de ${escapeHtml(product.nome)}">
          <button type="button" data-stock-minus="${escapeHtml(product.id)}">−</button>
          <input type="number" min="0" max="9999" value="${Number(product.estoque || 0)}" data-stock-input="${escapeHtml(product.id)}" aria-label="Quantidade em estoque">
          <button type="button" data-stock-plus="${escapeHtml(product.id)}">+</button>
        </div>
        <div class="product-shipping">${Number(product.frete?.largura)} × ${Number(product.frete?.altura)} × ${Number(product.frete?.comprimento)} cm<br>${Number(product.frete?.peso)} kg</div>
        <div class="row-actions">
          <button class="mini-btn primary" type="button" data-save-stock="${escapeHtml(product.id)}">Salvar estoque</button>
          <button class="mini-btn" type="button" data-edit="${escapeHtml(product.id)}">Editar</button>
          ${product.active ? "" : `<button class="mini-btn" type="button" data-restore="${escapeHtml(product.id)}">Restaurar</button>`}
        </div>
      </article>`;
    }).join("");

    list.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => openEditor(btn.dataset.edit)));
    list.querySelectorAll("[data-restore]").forEach((btn) => btn.addEventListener("click", () => restoreProduct(btn.dataset.restore)));
    list.querySelectorAll("[data-stock-minus]").forEach((btn) => btn.addEventListener("click", () => nudgeStock(btn.dataset.stockMinus, -1)));
    list.querySelectorAll("[data-stock-plus]").forEach((btn) => btn.addEventListener("click", () => nudgeStock(btn.dataset.stockPlus, 1)));
    list.querySelectorAll("[data-save-stock]").forEach((btn) => btn.addEventListener("click", () => saveQuickStock(btn.dataset.saveStock)));
  }

  function nudgeStock(id, delta) {
    const input = document.querySelector(`[data-stock-input="${CSS.escape(id)}"]`);
    if (!input) return;
    input.value = Math.max(0, Number(input.value || 0) + delta);
  }

  async function saveQuickStock(id) {
    const input = document.querySelector(`[data-stock-input="${CSS.escape(id)}"]`);
    const stock = Math.max(0, Math.floor(Number(input?.value || 0)));
    setStatus(`Atualizando estoque de ${id}…`);
    try {
      await api(`/api/admin/products/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ stock, stock_reason: "Ajuste rápido pelo painel" }),
      });
      await loadProducts();
    } catch (error) { setStatus(error.message, true); }
  }

  function openEditor(id = null) {
    editingId = id;
    const product = id ? PRODUCTS.find((item) => item.id === id) : null;
    $("dialogEyebrow").textContent = product ? "Editar produto" : "Novo produto";
    $("dialogTitle").textContent = product ? product.nome : "Cadastrar produto";
    $("productId").value = product?.id || "";
    $("productId").readOnly = Boolean(product);
    $("productName").value = product?.nome || "";
    $("productDescription").value = product?.desc || "";
    $("productPrice").value = product ? (Number(product.preco_centavos) / 100).toFixed(2) : "";
    $("productStock").value = product?.estoque ?? 1;
    $("productTag").value = String(product?.tag || "").toLowerCase() === "novo" ? "Novo" : "";
    $("productSortOrder").value = product?.sort_order ?? (PRODUCTS.length ? Math.max(...PRODUCTS.map((p) => Number(p.sort_order || 0))) + 1 : 0);
    $("productActive").checked = product ? Boolean(product.active) : true;
    $("productWidth").value = product?.frete?.largura ?? "";
    $("productHeight").value = product?.frete?.altura ?? "";
    $("productLength").value = product?.frete?.comprimento ?? "";
    $("productWeight").value = product?.frete?.peso ?? "";
    $("productProvisional").checked = Boolean(product?.frete?.provisorio);
    $("productImageRef").value = product?.image_ref || "";
    $("productImageFile").value = "";
    $("productImageFile").disabled = !IMAGE_UPLOAD_ENABLED;
    $("imageUploadHelp").textContent = IMAGE_UPLOAD_ENABLED ? "JPG, PNG, WebP ou GIF, até 6 MB." : "Configure o R2 para enviar arquivos diretamente pelo painel.";
    $("dangerZone").style.visibility = product ? "visible" : "hidden";
    $("archiveProductButton").textContent = product?.active === false ? "Produto arquivado" : "Arquivar produto";
    $("archiveProductButton").disabled = product?.active === false;
    $("historyButton").disabled = !product;
    setProductMessage("");
    updateImagePreview(product?.img || "");
    $("productDialog").showModal();
  }

  function updateImagePreview(src) {
    const preview = $("imagePreview");
    if (!src) { preview.innerHTML = "<span>Sem imagem</span>"; return; }
    preview.innerHTML = `<img src="${escapeHtml(src)}" alt="Prévia da imagem">`;
  }

  function setProductMessage(message, ok = false) {
    const el = $("productMessage");
    el.textContent = message || "";
    el.style.color = ok ? "#2d6a4f" : "";
  }

  function productPayload() {
    return {
      id: $("productId").value.trim(),
      name: $("productName").value.trim(),
      description: $("productDescription").value.trim(),
      price_cents: Math.round(Number($("productPrice").value || 0) * 100),
      stock: Math.max(0, Math.floor(Number($("productStock").value || 0))),
      tag: $("productTag").value,
      sort_order: Math.trunc(Number($("productSortOrder").value || 0)),
      active: $("productActive").checked,
      width_cm: Number($("productWidth").value),
      height_cm: Number($("productHeight").value),
      length_cm: Number($("productLength").value),
      weight_kg: Number($("productWeight").value),
      shipping_provisional: $("productProvisional").checked,
      image_ref: $("productImageRef").value.trim(),
      stock_reason: editingId ? "Edição do produto pelo painel" : "Cadastro inicial",
    };
  }

  async function saveProduct(event) {
    event.preventDefault();
    const button = $("saveProductButton");
    button.disabled = true;
    setProductMessage("Salvando…", true);
    try {
      const payload = productPayload();
      const path = editingId ? `/api/admin/products/${encodeURIComponent(editingId)}` : "/api/admin/products";
      const method = editingId ? "PUT" : "POST";
      const { data } = await api(path, { method, body: JSON.stringify(payload) });
      const id = data.id;
      const file = $("productImageFile").files?.[0];
      if (file) {
        if (!IMAGE_UPLOAD_ENABLED) throw new Error("O R2 ainda não está configurado para upload de imagens.");
        setProductMessage("Produto salvo. Enviando imagem…", true);
        await api(`/api/admin/products/${encodeURIComponent(id)}/image`, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: await file.arrayBuffer(),
        });
      }
      $("productDialog").close();
      await loadProducts();
      setStatus(`${data.nome || payload.name} salvo com sucesso.`);
    } catch (error) {
      setProductMessage(error.message || "Não foi possível salvar.");
    } finally { button.disabled = false; }
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
  $("refreshButton").addEventListener("click", () => loadProducts().catch((e) => setStatus(e.message, true)));
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
  $("productImageRef").addEventListener("input", () => {
    const ref = $("productImageRef").value.trim();
    if (ref && !ref.startsWith("r2:")) updateImagePreview(ref); else if (!ref) updateImagePreview("");
  });
  $("productImageFile").addEventListener("change", () => {
    const file = $("productImageFile").files?.[0];
    if (file) updateImagePreview(URL.createObjectURL(file));
  });
  $("productName").addEventListener("input", () => {
    if (editingId || $("productId").value.trim()) return;
    const slug = $("productName").value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
    $("productId").value = slug;
  });

  if (token()) showDashboard();
})();
