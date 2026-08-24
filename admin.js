(() => {
  "use strict";

  const TOKEN_KEY = "sillycat_admin_session";
  let PRODUCTS = [];
  let IMAGE_UPLOAD_ENABLED = false;
  let PRODUCTION_ORDERS = [];
  let COUPONS = [];
  let REVIEWS = [];
  let EXTERNAL_REVIEW_LINKS = [];
  let CATEGORIES = [];
  let editingId = null;
  let editingCouponId = null;
  let editingCategoryId = null;
  let selectCategoryAfterSave = false;
  let IMAGE_ITEMS = [];
  let draggingImageKey = null;

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
      await loadCategories();
      await loadProducts();
      await Promise.all([loadProductionOrders(), loadCoupons(), loadReviews(), loadExternalReviewLinks()]);
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
    syncReviewProductOptions();
    $("imageNotice").hidden = IMAGE_UPLOAD_ENABLED;
    if (!IMAGE_UPLOAD_ENABLED) {
      $("imageNotice").textContent = "Upload direto de imagens ainda não está configurado. Você pode continuar usando caminhos img/... ou URLs HTTPS. Para upload pelo painel, configure o bucket R2 PRODUCT_IMAGES.";
    }
    setStatus(`Atualizado agora · ${PRODUCTS.length} produto(s) cadastrado(s)`);
  }

  function syncProductCategoryOptions(selected = "") {
    const select = $("productCategory");
    if (!select) return;
    const current = selected || select.value;
    const available = CATEGORIES.filter((category) => category.active && !category.archived);
    const currentCategory = CATEGORIES.find((category) => category.slug === current);
    const options = currentCategory && !available.some((category) => category.slug === current)
      ? [currentCategory, ...available]
      : available;
    select.innerHTML = options.map((category) => `<option value="${escapeHtml(category.slug)}">${escapeHtml(category.name)}${category.active && !category.archived ? "" : " · indisponível"}</option>`).join("");
    const fallback = options.find((category) => category.slug === "outros") || options[0];
    select.value = options.some((category) => category.slug === current) ? current : (fallback?.slug || "");
  }

  async function loadCategories() {
    const { data } = await api("/api/admin/categories");
    CATEGORIES = data.categories || [];
    renderCategories();
    syncProductCategoryOptions();
  }

  function filteredCategories() {
    const query = $("categorySearch").value.trim().toLowerCase();
    const status = $("categoryStatusFilter").value;
    return CATEGORIES.filter((category) => {
      if (query && !`${category.name} ${category.slug}`.toLowerCase().includes(query)) return false;
      if (status === "active") return category.active && !category.archived;
      if (status === "inactive") return !category.active && !category.archived;
      if (status === "archived") return category.archived;
      return true;
    });
  }

  function renderCategories() {
    const list = $("categoryList"), items = filteredCategories();
    $("categoryEmpty").hidden = items.length > 0;
    list.innerHTML = items.map((category) => {
      const status = category.archived ? "ARQUIVADA" : category.active ? "ATIVA" : "INATIVA";
      const statusClass = category.archived ? "archived" : category.active ? "available" : "provisional";
      const locked = Number(category.product_count || 0) > 0 || category.slug === "outros";
      const archiveTitle = category.slug === "outros" ? "A categoria Outros é protegida." : locked ? "Mova os produtos para outra categoria antes de arquivar." : "Arquivar categoria";
      return `<article class="category-admin-card">
        <div><div class="category-admin-head"><strong>${escapeHtml(category.name)}</strong><span class="badge ${statusClass}">${status}</span></div><code>${escapeHtml(category.slug)}</code><small>Ordem ${category.sort_order}</small></div>
        <div class="category-product-count"><strong>${Number(category.product_count || 0)}</strong><span>produto(s)</span></div>
        <div class="row-actions">${category.archived ? `<button class="mini-btn" type="button" data-restore-category="${category.id}">Restaurar</button>` : `<button class="mini-btn" type="button" data-edit-category="${category.id}">Editar</button><button class="mini-btn danger-text" type="button" data-archive-category="${category.id}" title="${escapeHtml(archiveTitle)}" ${locked ? "disabled" : ""}>Arquivar</button>`}</div>
      </article>`;
    }).join("");
    list.querySelectorAll("[data-edit-category]").forEach((button) => button.addEventListener("click", () => openCategoryEditor(Number(button.dataset.editCategory))));
    list.querySelectorAll("[data-archive-category]").forEach((button) => button.addEventListener("click", () => archiveCategory(Number(button.dataset.archiveCategory))));
    list.querySelectorAll("[data-restore-category]").forEach((button) => button.addEventListener("click", () => restoreCategory(Number(button.dataset.restoreCategory))));
  }

  function categorySlug(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  }

  function openCategoryEditor(id = null, { selectAfterSave = false } = {}) {
    editingCategoryId = id;
    selectCategoryAfterSave = selectAfterSave;
    const category = id ? CATEGORIES.find((item) => item.id === id) : null;
    $("categoryDialogTitle").textContent = category ? `Editar ${category.name}` : "Nova categoria";
    $("categoryName").value = category?.name || "";
    $("categorySlug").value = category?.slug || "";
    $("categorySlug").readOnly = Boolean(category);
    delete $("categorySlug").dataset.touched;
    const orderedCategories = CATEGORIES.filter((item) => !item.archived && item.slug !== "outros");
    $("categorySortOrder").value = category?.sort_order ?? (orderedCategories.length ? Math.max(...orderedCategories.map((item) => Number(item.sort_order || 0))) + 10 : 10);
    $("categoryActive").checked = category ? category.active : true;
    setCategoryMessage("");
    $("categoryDialog").showModal();
  }

  function setCategoryMessage(message, ok = false) {
    const element = $("categoryAdminMessage");
    element.textContent = message || "";
    element.style.color = ok ? "#2d6a4f" : "";
  }

  async function saveCategory(event) {
    event.preventDefault();
    const button = $("saveCategoryButton"); button.disabled = true; setCategoryMessage("Salvando…", true);
    const payload = { name: $("categoryName").value.trim(), slug: $("categorySlug").value.trim(), sort_order: Math.trunc(Number($("categorySortOrder").value || 0)), active: $("categoryActive").checked };
    try {
      const { data } = await api(editingCategoryId ? `/api/admin/categories/${editingCategoryId}` : "/api/admin/categories", { method: editingCategoryId ? "PUT" : "POST", body: JSON.stringify(payload) });
      const shouldSelect = selectCategoryAfterSave && data.active && !data.archived;
      $("categoryDialog").close();
      await loadCategories();
      if (shouldSelect) {
        syncProductCategoryOptions(data.slug);
        $("productCategory").value = data.slug;
      }
      setStatus(`Categoria ${data.name} salva.`);
    } catch (error) { setCategoryMessage(error.message); }
    finally { button.disabled = false; }
  }

  async function archiveCategory(id) {
    const category = CATEGORIES.find((item) => item.id === id);
    if (!category || !confirm(`Arquivar a categoria “${category.name}”?`)) return;
    try { await api(`/api/admin/categories/${id}`, { method: "DELETE" }); await loadCategories(); setStatus("Categoria arquivada."); }
    catch (error) { setStatus(error.message, true); }
  }

  async function restoreCategory(id) {
    try { await api(`/api/admin/categories/${id}/restore`, { method: "POST" }); await loadCategories(); setStatus("Categoria restaurada como inativa. Edite-a para ativar."); }
    catch (error) { setStatus(error.message, true); }
  }

  function localDateTimeValue(value) {
    if (!value) return "";
    const date = new Date(value); if (Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  async function loadCoupons() {
    const params = new URLSearchParams();
    const query = $("couponSearch").value.trim();
    const status = $("couponStatusFilter").value;
    if (query) params.set("q", query); if (status && status !== "all") params.set("status", status);
    const { data } = await api(`/api/admin/coupons?${params}`);
    COUPONS = data.coupons || [];
    renderCoupons();
  }

  function couponDiscountLabel(coupon) {
    return coupon.discount_type === "percent" ? `${coupon.discount_value}%` : money(coupon.discount_value);
  }

  function couponValidity(coupon) {
    const parts = [];
    if (coupon.starts_at) parts.push(`desde ${new Date(coupon.starts_at).toLocaleString("pt-BR")}`);
    if (coupon.ends_at) parts.push(`até ${new Date(coupon.ends_at).toLocaleString("pt-BR")}`);
    return parts.join(" · ") || "sem período definido";
  }

  function renderCoupons() {
    const list = $("couponList"), empty = $("couponEmpty");
    empty.hidden = COUPONS.length > 0;
    list.innerHTML = COUPONS.map((coupon) => {
      const status = coupon.archived ? "ARQUIVADO" : coupon.active ? "ATIVO" : "INATIVO";
      const statusClass = coupon.archived ? "archived" : coupon.active ? "available" : "provisional";
      return `<article class="coupon-admin-card">
        <div><div class="coupon-admin-head"><strong>${escapeHtml(coupon.code)}</strong><span class="badge ${statusClass}">${status}</span></div><p>${escapeHtml(couponDiscountLabel(coupon))} de desconto · mínimo ${money(coupon.min_order_cents)}</p><small>${escapeHtml(couponValidity(coupon))}</small></div>
        <div class="coupon-usage"><strong>${coupon.used_count}</strong><span>utilizado(s)</span><small>${coupon.reserved_count} reservado(s) · ${coupon.remaining_count} restante(s)</small></div>
        <div class="row-actions"><button class="mini-btn" type="button" data-edit-coupon="${coupon.id}">Editar</button>${coupon.archived ? `<button class="mini-btn" type="button" data-restore-coupon="${coupon.id}">Restaurar</button>` : `<button class="mini-btn danger-text" type="button" data-archive-coupon="${coupon.id}">Arquivar</button>`}</div>
      </article>`;
    }).join("");
    list.querySelectorAll("[data-edit-coupon]").forEach((button) => button.addEventListener("click", () => openCouponEditor(Number(button.dataset.editCoupon))));
    list.querySelectorAll("[data-archive-coupon]").forEach((button) => button.addEventListener("click", () => archiveCoupon(Number(button.dataset.archiveCoupon))));
    list.querySelectorAll("[data-restore-coupon]").forEach((button) => button.addEventListener("click", () => restoreCoupon(Number(button.dataset.restoreCoupon))));
  }

  function openCouponEditor(id = null) {
    editingCouponId = id;
    const coupon = id ? COUPONS.find((item) => item.id === id) : null;
    $("couponDialogTitle").textContent = coupon ? `Editar ${coupon.code}` : "Novo cupom";
    $("couponCodeAdmin").value = coupon?.code || "";
    $("couponDiscountType").value = coupon?.discount_type || "percent";
    $("couponDiscountValue").value = coupon ? (coupon.discount_type === "fixed" ? (coupon.discount_value / 100).toFixed(2) : coupon.discount_value) : "";
    $("couponMaxUses").value = coupon?.max_uses || 1;
    $("couponMinOrder").value = coupon ? (coupon.min_order_cents / 100).toFixed(2) : "0.00";
    $("couponStartsAt").value = localDateTimeValue(coupon?.starts_at);
    $("couponEndsAt").value = localDateTimeValue(coupon?.ends_at);
    $("couponActive").checked = coupon ? coupon.active : true;
    setCouponMessage(""); syncCouponValueLabel(); $("couponDialog").showModal();
  }

  function syncCouponValueLabel() {
    $("couponValueLabel").firstChild.textContent = $("couponDiscountType").value === "fixed" ? "Valor (R$)" : "Percentual (%)";
    $("couponDiscountValue").max = $("couponDiscountType").value === "percent" ? "100" : "";
    $("couponDiscountValue").step = $("couponDiscountType").value === "percent" ? "1" : "0.01";
  }

  function setCouponMessage(message, ok = false) { const el = $("couponAdminMessage"); el.textContent = message || ""; el.style.color = ok ? "#2d6a4f" : ""; }

  async function saveCoupon(event) {
    event.preventDefault(); const button = $("saveCouponButton"); button.disabled = true; setCouponMessage("Salvando…", true);
    const type = $("couponDiscountType").value;
    const rawValue = Number($("couponDiscountValue").value);
    const payload = {
      code: $("couponCodeAdmin").value.trim().toUpperCase(), discount_type: type,
      discount_value: type === "fixed" ? Math.round(rawValue * 100) : Math.round(rawValue),
      max_uses: Math.floor(Number($("couponMaxUses").value)), min_order_cents: Math.round(Number($("couponMinOrder").value || 0) * 100),
      starts_at: $("couponStartsAt").value ? new Date($("couponStartsAt").value).toISOString() : null,
      ends_at: $("couponEndsAt").value ? new Date($("couponEndsAt").value).toISOString() : null,
      active: $("couponActive").checked,
    };
    try {
      await api(editingCouponId ? `/api/admin/coupons/${editingCouponId}` : "/api/admin/coupons", { method: editingCouponId ? "PUT" : "POST", body: JSON.stringify(payload) });
      $("couponDialog").close(); await loadCoupons(); setStatus(`Cupom ${payload.code} salvo.`);
    } catch (error) { setCouponMessage(error.message); }
    finally { button.disabled = false; }
  }

  async function archiveCoupon(id) {
    const coupon = COUPONS.find((item) => item.id === id); if (!confirm(`Arquivar o cupom ${coupon?.code || id}?`)) return;
    try { await api(`/api/admin/coupons/${id}`, { method: "DELETE" }); await loadCoupons(); setStatus("Cupom arquivado."); }
    catch (error) { setStatus(error.message, true); }
  }

  async function restoreCoupon(id) {
    try { await api(`/api/admin/coupons/${id}/restore`, { method: "POST" }); await loadCoupons(); setStatus("Cupom restaurado como inativo. Revise e ative quando quiser."); }
    catch (error) { setStatus(error.message, true); }
  }

  function syncReviewProductOptions() {
    const products = PRODUCTS.filter((product) => product.active);
    const options = products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.nome)}</option>`).join("");
    const external = $("externalReviewProduct"), filter = $("reviewProductFilter");
    const previousExternal = external.value, previousFilter = filter.value;
    external.innerHTML = `<option value="">Escolha um produto</option>${options}`;
    filter.innerHTML = `<option value="">Todos os produtos</option>${options}`;
    if (products.some((product) => product.id === previousExternal)) external.value = previousExternal;
    if (products.some((product) => product.id === previousFilter)) filter.value = previousFilter;
    syncExternalVariants();
  }

  function syncExternalVariants() {
    const product = PRODUCTS.find((item) => item.id === $("externalReviewProduct").value);
    const variants = product?.variacoes || [];
    $("externalReviewVariant").innerHTML = variants.length
      ? `<option value="">Escolha uma variação</option>${variants.map((variant) => `<option value="${escapeHtml(variant.id)}">${escapeHtml(variant.nome)}</option>`).join("")}`
      : `<option value="">Sem variação</option>`;
    $("externalReviewVariant").required = variants.length > 0;
  }

  async function generateExternalReviewLink(event) {
    event.preventDefault(); const button = $("generateReviewLinkButton"); button.disabled = true; button.textContent = "Gerando…";
    $("externalReviewMessage").textContent = ""; $("generatedReviewLink").hidden = true;
    try {
      const { data } = await api("/api/admin/review-links", { method: "POST", body: JSON.stringify({ product_id: $("externalReviewProduct").value, variant_id: $("externalReviewVariant").value || undefined, buyer_first_name: $("externalBuyerName").value.trim() || undefined }) });
      $("generatedReviewUrl").value = data.url; $("generatedReviewLink").hidden = false;
      $("externalReviewMessage").textContent = "Link criado. Ele funciona mesmo depois que o navegador for fechado e autoriza uma única avaliação para o item selecionado.";
      await loadExternalReviewLinks();
    } catch (error) { $("externalReviewMessage").textContent = error.message; }
    finally { button.disabled = false; button.textContent = "Gerar link seguro"; }
  }

  async function copyGeneratedReviewLink() {
    const value = $("generatedReviewUrl").value; if (!value) return;
    try { await navigator.clipboard.writeText(value); $("externalReviewMessage").textContent = "Link copiado."; }
    catch { $("generatedReviewUrl").select(); document.execCommand("copy"); $("externalReviewMessage").textContent = "Link copiado."; }
  }

  async function loadExternalReviewLinks() {
    const { data } = await api("/api/admin/review-links"); EXTERNAL_REVIEW_LINKS = data.links || []; renderExternalReviewLinks();
  }

  function renderExternalReviewLinks() {
    $("externalReviewLinks").innerHTML = EXTERNAL_REVIEW_LINKS.length ? EXTERNAL_REVIEW_LINKS.map((link) => `<div class="external-link-row"><span><b>${escapeHtml(link.product_name)}</b>${link.variant_name ? ` · ${escapeHtml(link.variant_name)}` : ""}<small>${link.buyer_first_name ? `${escapeHtml(link.buyer_first_name)} · ` : ""}${new Date(link.created_at).toLocaleString("pt-BR")}</small></span><span class="badge ${link.used ? "available" : link.active ? "provisional" : "archived"}">${link.used ? "USADO" : link.active ? "ABERTO" : "REVOGADO"}</span>${link.active && !link.used ? `<button class="mini-btn" type="button" data-revoke-review-link="${link.id}">Revogar</button>` : ""}</div>`).join("") : `<p>Nenhum link externo gerado.</p>`;
    $("externalReviewLinks").querySelectorAll("[data-revoke-review-link]").forEach((button) => button.addEventListener("click", () => revokeExternalReviewLink(Number(button.dataset.revokeReviewLink))));
  }

  async function revokeExternalReviewLink(id) {
    if (!confirm("Revogar este link? Ele deixará de aceitar uma avaliação.")) return;
    try { await api(`/api/admin/review-links/${id}`, { method: "DELETE" }); await loadExternalReviewLinks(); }
    catch (error) { setStatus(error.message, true); }
  }

  async function loadReviews() {
    const params = new URLSearchParams();
    if ($("reviewProductFilter").value) params.set("product_id", $("reviewProductFilter").value);
    if ($("reviewRatingFilter").value) params.set("rating", $("reviewRatingFilter").value);
    if ($("reviewStatusFilter").value) params.set("status", $("reviewStatusFilter").value);
    const { data } = await api(`/api/admin/reviews?${params}`); REVIEWS = data.reviews || []; renderAdminReviews();
  }

  function renderAdminReviews() {
    const list = $("reviewAdminList"), empty = $("reviewAdminEmpty"); empty.hidden = REVIEWS.length > 0;
    list.innerHTML = REVIEWS.map((review) => `<article class="review-admin-card ${review.status === "hidden" ? "hidden-review" : ""}"><div class="review-admin-head"><div><strong>${escapeHtml(review.product_name)}</strong>${review.variant_name ? `<small> · ${escapeHtml(review.variant_name)}</small>` : ""}</div><span class="review-admin-stars">${"★".repeat(review.rating)}${"☆".repeat(5-review.rating)}</span></div><p>${escapeHtml(review.comment)}</p><footer>${review.reviewer_name ? escapeHtml(review.reviewer_name) : "Nome não exibido"} · ${review.source === "external" ? "compra externa" : "pedido online"} · ${new Date(review.created_at).toLocaleString("pt-BR")}</footer><button class="mini-btn" type="button" data-moderate-review="${review.id}" data-status="${review.status === "published" ? "hidden" : "published"}">${review.status === "published" ? "Ocultar" : "Publicar"}</button></article>`).join("");
    list.querySelectorAll("[data-moderate-review]").forEach((button) => button.addEventListener("click", () => moderateReview(Number(button.dataset.moderateReview), button.dataset.status)));
  }

  async function moderateReview(id, status) {
    try { await api(`/api/admin/reviews/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); await loadReviews(); }
    catch (error) { setStatus(error.message, true); }
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

  function imageItemKey() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function releasePendingImageUrls() {
    IMAGE_ITEMS.filter((item) => item.kind === "file" && item.previewUrl?.startsWith("blob:"))
      .forEach((item) => URL.revokeObjectURL(item.previewUrl));
  }

  function existingImageRefs() {
    return IMAGE_ITEMS.filter((item) => item.kind === "existing").map((item) => item.ref);
  }

  function moveImageItem(key, direction) {
    const index = IMAGE_ITEMS.findIndex((item) => item.key === key);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= IMAGE_ITEMS.length) return;
    [IMAGE_ITEMS[index], IMAGE_ITEMS[destination]] = [IMAGE_ITEMS[destination], IMAGE_ITEMS[index]];
    renderImageManager();
  }

  function removeImageItem(key) {
    const index = IMAGE_ITEMS.findIndex((item) => item.key === key);
    if (index < 0) return;
    const [removed] = IMAGE_ITEMS.splice(index, 1);
    if (removed.kind === "file" && removed.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(removed.previewUrl);
    renderImageManager();
  }

  function reorderImageItem(sourceKey, targetKey, insertAfter) {
    const sourceIndex = IMAGE_ITEMS.findIndex((item) => item.key === sourceKey);
    const targetIndex = IMAGE_ITEMS.findIndex((item) => item.key === targetKey);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const [moved] = IMAGE_ITEMS.splice(sourceIndex, 1);
    const updatedTargetIndex = IMAGE_ITEMS.findIndex((item) => item.key === targetKey);
    IMAGE_ITEMS.splice(updatedTargetIndex + (insertAfter ? 1 : 0), 0, moved);
    renderImageManager();
  }

  function renderImageManager() {
    const preview = $("imagePreview");
    if (!IMAGE_ITEMS.length) {
      preview.innerHTML = '<div class="image-gallery-empty"><strong>Sem imagem</strong><small>Adicione arquivos ou caminhos ao lado.</small></div>';
      return;
    }
    preview.innerHTML = IMAGE_ITEMS.map((item, index) => `
      <article class="admin-image-tile" draggable="true" data-image-key="${escapeHtml(item.key)}">
        <div class="admin-image-frame">
          <img src="${escapeHtml(item.previewUrl || item.ref)}" alt="Imagem ${index + 1} do produto">
          <span class="image-position-badge">${index === 0 ? "CAPA" : index + 1}</span>
          ${item.kind === "file" ? '<span class="image-pending-badge">NOVA</span>' : ""}
          <span class="image-drag-handle" aria-hidden="true">⠿</span>
        </div>
        <div class="image-tile-actions">
          <button type="button" class="image-tile-button" data-image-move="-1" aria-label="Mover imagem para a esquerda" title="Mover para a esquerda" ${index === 0 ? "disabled" : ""}>←</button>
          <button type="button" class="image-tile-button" data-image-move="1" aria-label="Mover imagem para a direita" title="Mover para a direita" ${index === IMAGE_ITEMS.length - 1 ? "disabled" : ""}>→</button>
          <button type="button" class="image-tile-button remove" data-image-remove aria-label="Remover imagem" title="Remover imagem">✕</button>
        </div>
      </article>`).join("");

    preview.querySelectorAll(".admin-image-tile").forEach((tile) => {
      const key = tile.dataset.imageKey;
      tile.querySelectorAll("[data-image-move]").forEach((button) => button.addEventListener("click", () => moveImageItem(key, Number(button.dataset.imageMove))));
      tile.querySelector("[data-image-remove]").addEventListener("click", () => removeImageItem(key));
      tile.addEventListener("dragstart", (event) => {
        draggingImageKey = key;
        tile.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", key);
      });
      tile.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (!draggingImageKey || draggingImageKey === key) return;
        const rect = tile.getBoundingClientRect();
        const after = event.clientX > rect.left + rect.width / 2;
        tile.classList.toggle("drop-after", after);
        tile.classList.toggle("drop-before", !after);
      });
      tile.addEventListener("dragleave", () => tile.classList.remove("drop-before", "drop-after"));
      tile.addEventListener("drop", (event) => {
        event.preventDefault();
        const rect = tile.getBoundingClientRect();
        reorderImageItem(draggingImageKey || event.dataTransfer.getData("text/plain"), key, event.clientX > rect.left + rect.width / 2);
      });
      tile.addEventListener("dragend", () => {
        draggingImageKey = null;
        preview.querySelectorAll(".admin-image-tile").forEach((item) => item.classList.remove("dragging", "drop-before", "drop-after"));
      });
    });
  }

  function addManualImageRefs() {
    const input = $("productImageRefs");
    const refs = input.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!refs.length) return;
    const known = new Set(IMAGE_ITEMS.filter((item) => item.kind === "existing").map((item) => item.ref));
    const additions = [...new Set(refs)].filter((ref) => !known.has(ref));
    if (IMAGE_ITEMS.length + additions.length > 20) {
      setProductMessage("Cada produto pode ter no máximo 20 imagens.");
      return;
    }
    additions.forEach((ref) => IMAGE_ITEMS.push({ key: imageItemKey(), kind: "existing", ref, previewUrl: ref }));
    input.value = "";
    setProductMessage(additions.length ? "Imagem adicionada à galeria. Salve o produto para aplicar." : "Essas imagens já estão na galeria.", true);
    renderImageManager();
  }

  function addPendingImageFiles(files) {
    if (!files.length) return;
    if (!IMAGE_UPLOAD_ENABLED) {
      setProductMessage("Configure o R2 para enviar arquivos diretamente pelo painel.");
      return;
    }
    if (IMAGE_ITEMS.length + files.length > 20) {
      setProductMessage("Cada produto pode ter no máximo 20 imagens.");
      return;
    }
    for (const file of files) {
      if (file.size > 6 * 1024 * 1024) {
        setProductMessage(`A imagem “${file.name}” ultrapassa 6 MB.`);
        continue;
      }
      IMAGE_ITEMS.push({ key: imageItemKey(), kind: "file", file, previewUrl: URL.createObjectURL(file) });
    }
    $("productImageFile").value = "";
    renderImageManager();
  }

  function openEditor(id = null) {
    editingId = id;
    const product = id ? PRODUCTS.find((item) => item.id === id) : null;
    $("dialogEyebrow").textContent = product ? "Editar produto" : "Novo produto";
    $("dialogTitle").textContent = product ? product.nome : "Cadastrar produto";
    $("productId").value = product?.id || ""; $("productId").readOnly = Boolean(product);
    $("productName").value = product?.nome || ""; $("productDescription").value = product?.desc || "";
    $("productPrice").value = product ? (Number(product.preco_centavos) / 100).toFixed(2) : "";
    $("productStock").value = product?.estoque ?? 1; syncProductCategoryOptions(product?.categoria || "outros");
    $("productTag").value = String(product?.tag || "").toLowerCase() === "novo" ? "Novo" : "";
    $("productSortOrder").value = product?.sort_order ?? (PRODUCTS.length ? Math.max(...PRODUCTS.map((p) => Number(p.sort_order || 0))) + 1 : 0);
    $("productActive").checked = product ? Boolean(product.active) : true;
    $("productWidth").value = product?.frete?.largura ?? ""; $("productHeight").value = product?.frete?.altura ?? ""; $("productLength").value = product?.frete?.comprimento ?? ""; $("productWeight").value = product?.frete?.peso ?? "";
    $("productProvisional").checked = Boolean(product?.frete?.provisorio);
    releasePendingImageUrls();
    const refs = Array.isArray(product?.image_refs) ? product.image_refs : (product?.image_ref ? [product.image_ref] : []);
    const resolvedImages = Array.isArray(product?.images) ? product.images : (product?.img ? [product.img] : []);
    IMAGE_ITEMS = refs.map((ref, index) => ({ key: imageItemKey(), kind: "existing", ref, previewUrl: resolvedImages[index] || ref }));
    $("productImageRefs").value = ""; $("productImageFile").value = ""; $("productImageFile").disabled = !IMAGE_UPLOAD_ENABLED;
    $("imageUploadHelp").textContent = IMAGE_UPLOAD_ENABLED ? "JPG, PNG, WebP ou GIF, até 6 MB por imagem. Máximo de 20 imagens no total." : "Configure o R2 para enviar arquivos diretamente pelo painel.";
    $("variantRows").innerHTML = ""; (product?.variacoes || []).forEach(addVariantRow); syncVariantStockMode();
    $("dangerZone").style.visibility = product ? "visible" : "hidden"; $("archiveProductButton").textContent = product?.active === false ? "Produto arquivado" : "Arquivar produto"; $("archiveProductButton").disabled = product?.active === false; $("historyButton").disabled = !product;
    setProductMessage(""); renderImageManager(); $("productDialog").showModal();
  }

  function setProductMessage(message, ok = false) { const el = $("productMessage"); el.textContent = message || ""; el.style.color = ok ? "#2d6a4f" : ""; }

  function productPayload() {
    const variants=collectVariants();
    const payload = {
      id: $("productId").value.trim(), name: $("productName").value.trim(), description: $("productDescription").value.trim(), price_cents: Math.round(Number($("productPrice").value || 0) * 100),
      tag: $("productTag").value, category: $("productCategory").value, sort_order: Math.trunc(Number($("productSortOrder").value || 0)), active: $("productActive").checked,
      width_cm: Number($("productWidth").value), height_cm: Number($("productHeight").value), length_cm: Number($("productLength").value), weight_kg: Number($("productWeight").value), shipping_provisional: $("productProvisional").checked,
      image_refs: existingImageRefs(), variants, stock_reason: editingId ? "Edição do produto pelo painel" : "Cadastro inicial",
    };
    if(!variants.length) payload.stock=Math.max(0,Math.floor(Number($("productStock").value||0)));
    return payload;
  }

  async function saveProduct(event) {
    event.preventDefault(); const button=$("saveProductButton"); button.disabled=true; setProductMessage("Salvando…",true);
    try {
      const desiredItems=[...IMAGE_ITEMS];
      const payload=productPayload(); const path=editingId?`/api/admin/products/${encodeURIComponent(editingId)}`:"/api/admin/products"; const method=editingId?"PUT":"POST";
      let {data}=await api(path,{method,body:JSON.stringify(payload)}); const id=data.id;
      editingId=id; $("productId").readOnly=true;
      const pendingItems=desiredItems.filter((item)=>item.kind==="file");
      const knownRefs=new Set(existingImageRefs());
      if(pendingItems.length && !IMAGE_UPLOAD_ENABLED) throw new Error("O R2 ainda não está configurado para upload de imagens.");
      for(let i=0;i<pendingItems.length;i++){
        const item=pendingItems[i]; setProductMessage(`Produto salvo. Enviando imagem ${i+1}/${pendingItems.length}…`,true);
        const result=await api(`/api/admin/products/${encodeURIComponent(id)}/images`,{method:"POST",headers:{"Content-Type":item.file.type},body:await item.file.arrayBuffer()});
        data=result.data;
        const returnedRefs=Array.isArray(data.image_refs)?data.image_refs:[];
        const newRef=returnedRefs.find((ref)=>!knownRefs.has(ref)) || returnedRefs.at(-1);
        if(!newRef) throw new Error("A imagem foi enviada, mas o backend não devolveu sua referência.");
        const resolvedIndex=returnedRefs.indexOf(newRef);
        if(item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
        item.kind="existing"; item.ref=newRef; item.previewUrl=(Array.isArray(data.images)?data.images[resolvedIndex]:"") || newRef; delete item.file;
        knownRefs.add(newRef);
      }
      IMAGE_ITEMS=desiredItems;
      if(pendingItems.length){
        const finalRefs=desiredItems.map((item)=>item.ref).filter(Boolean);
        const finalResult=await api(`/api/admin/products/${encodeURIComponent(id)}`,{method:"PUT",body:JSON.stringify({image_refs:finalRefs})});
        data=finalResult.data;
      }
      $("productDialog").close(); await Promise.all([loadProducts(), loadCategories()]); setStatus(`${data.nome || payload.name} salvo com sucesso.`);
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
        const detail = item.kind === "sale" ? `Pedido ${escapeHtml(item.ref)}${String(item.reason || "").includes("Variação") ? ` · ${escapeHtml(String(item.reason).split("·").pop().trim())}` : ""}` : escapeHtml(item.reason || "Ajuste manual");
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
  $("refreshButton").addEventListener("click", () => Promise.all([loadProducts(), loadCategories(), loadProductionOrders(), loadCoupons(), loadReviews(), loadExternalReviewLinks()]).catch((e) => setStatus(e.message, true)));
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
  $("newCategoryButton").addEventListener("click", () => openCategoryEditor());
  $("quickNewCategoryButton").addEventListener("click", () => openCategoryEditor(null, { selectAfterSave: true }));
  $("refreshCategoriesButton").addEventListener("click", () => loadCategories().catch((e) => setStatus(e.message, true)));
  $("categorySearch").addEventListener("input", renderCategories);
  $("categoryStatusFilter").addEventListener("change", renderCategories);
  $("categoryForm").addEventListener("submit", saveCategory);
  $("closeCategoryDialog").addEventListener("click", () => $("categoryDialog").close());
  $("cancelCategoryButton").addEventListener("click", () => $("categoryDialog").close());
  $("categoryName").addEventListener("input", () => { if (!editingCategoryId && !$("categorySlug").dataset.touched) $("categorySlug").value = categorySlug($("categoryName").value); });
  $("categorySlug").addEventListener("input", () => { $("categorySlug").dataset.touched = "1"; $("categorySlug").value = categorySlug($("categorySlug").value); });
  $("newCouponButton").addEventListener("click", () => openCouponEditor());
  $("refreshCouponsButton").addEventListener("click", () => loadCoupons().catch((e) => setStatus(e.message, true)));
  $("couponSearch").addEventListener("input", () => loadCoupons().catch((e) => setStatus(e.message, true)));
  $("couponStatusFilter").addEventListener("change", () => loadCoupons().catch((e) => setStatus(e.message, true)));
  $("couponForm").addEventListener("submit", saveCoupon);
  $("closeCouponDialog").addEventListener("click", () => $("couponDialog").close());
  $("cancelCouponButton").addEventListener("click", () => $("couponDialog").close());
  $("couponDiscountType").addEventListener("change", syncCouponValueLabel);
  $("refreshReviewsButton").addEventListener("click", () => Promise.all([loadReviews(), loadExternalReviewLinks()]).catch((e) => setStatus(e.message, true)));
  $("reviewProductFilter").addEventListener("change", () => loadReviews().catch((e) => setStatus(e.message, true)));
  $("reviewRatingFilter").addEventListener("change", () => loadReviews().catch((e) => setStatus(e.message, true)));
  $("reviewStatusFilter").addEventListener("change", () => loadReviews().catch((e) => setStatus(e.message, true)));
  $("externalReviewProduct").addEventListener("change", syncExternalVariants);
  $("externalReviewForm").addEventListener("submit", generateExternalReviewLink);
  $("copyReviewLinkButton").addEventListener("click", copyGeneratedReviewLink);
  $("addImageRefsButton").addEventListener("click", addManualImageRefs);
  $("productImageFile").addEventListener("change", () => {
    const files = [...($("productImageFile").files || [])];
    addPendingImageFiles(files);
  });
  $("productDialog").addEventListener("close", releasePendingImageUrls);
  $("productName").addEventListener("input", () => {
    if (editingId || $("productId").value.trim()) return;
    const slug = $("productName").value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
    $("productId").value = slug;
  });

  if (token()) showDashboard();
})();
