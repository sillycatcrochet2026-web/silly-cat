const PLACEHOLDER = /COLE_AQUI/;
const CART_STORAGE_KEY = "silly-cat-cart-v1";
let PRODUTOS = [];
let CART = loadCart();
let SHIPPING_QUOTES = [];
let SELECTED_SHIPPING_ID = null;
let QUOTED_CEP = "";
let CHECKOUT_DATA = {
  cep:"", name:"", email:"", phone:"", document:"", street:"", neighborhood:"", number:"", complement:"", city:"", state:""
};

function apiBaseUrl(){
  return String(window.SILLY_CAT_ECOMMERCE?.apiBaseUrl || "").replace(/\/$/, "");
}

function apiUrl(path){
  const base = apiBaseUrl();
  return `${base}${path}`;
}

function formatBRL(cents){
  return new Intl.NumberFormat("pt-BR", {style:"currency", currency:"BRL"}).format(Number(cents || 0) / 100);
}

function sillyCatSvg(){
  return `<svg viewBox="0 0 240 250" aria-hidden="true"><use href="#sillycat"></use></svg>`;
}

function escapeHtml(value){
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(msg){
  const toast = document.getElementById("toast");
  if(!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(()=>toast.classList.remove("show"), 3200);
}

function normalizeProductTag(product){
  const tag = String(product.tag || "").trim().toLowerCase();
  if(tag === "novo") return "NOVO";
  if(tag === "esgotado" || Number(product.estoque) <= 0) return "ESGOTADO";
  return "";
}

async function loadCatalog(){
  // Em produção o catálogo vem da API porque ela combina os dados do
  // catalogo.json com o estoque vivo armazenado no D1. Assim uma venda
  // confirmada aparece imediatamente como ESGOTADO sem precisar alterar
  // o arquivo estático no GitHub. Se a API estiver indisponível, usamos
  // catalogo.json como fallback de leitura para não deixar a vitrine vazia.
  const sources = [apiUrl("/api/catalog"), "catalogo.json"].filter(Boolean);
  let lastError = null;

  for(const source of sources){
    try{
      const response = await fetch(source, {cache:"no-store"});
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if(!Array.isArray(data)) throw new Error("Catálogo inválido");
      PRODUTOS = data;
      return;
    }catch(error){
      lastError = error;
      console.warn(`Não foi possível carregar o catálogo de ${source}`, error);
    }
  }

  console.error("Não foi possível carregar o catálogo", lastError);
  PRODUTOS = [];
  document.querySelectorAll("[data-products]").forEach(grid => {
    grid.innerHTML = `<div class="catalog-error">Não conseguimos carregar o catálogo agora. Tente atualizar a página.</div>`;
  });
}

function productById(id){
  return PRODUTOS.find(product => product.id === id);
}

function productCard(product, index){
  const hasImage = product.img && !PLACEHOLDER.test(product.img);
  const tagLabel = normalizeProductTag(product);
  const tagClass = tagLabel ? ` product-badge--${tagLabel.toLowerCase()}` : "";
  const badge = tagLabel ? `<span class="product-badge${tagClass}">${escapeHtml(tagLabel)}</span>` : "";
  const fallbackMedia = `<div class="product-placeholder">${sillyCatSvg()}</div>${badge}`;
  const media = hasImage
    ? `<img src="${escapeHtml(product.img)}" alt="${escapeHtml(product.nome)}" loading="lazy" onerror="this.closest('.product-media').innerHTML='${fallbackMedia.replaceAll('"','&quot;')}'">`
    : fallbackMedia;
  const soldOut = tagLabel === "ESGOTADO" || Number(product.estoque) <= 0;
  const alreadyInCart = CART.some(item => item.id === product.id);

  return `<article class="product-card reveal" style="--i:${index}">
    <div class="product-media" style="background:${['#e6edf8','#fffddc','#dbe5f5','#ffffff'][index%4]}">
      ${media}
      ${hasImage ? badge : ""}
    </div>
    <div class="product-body">
      <h3 class="product-name">${escapeHtml(product.nome)}</h3>
      <p class="product-desc">${escapeHtml(product.desc)}</p>
      <p class="price">${formatBRL(product.preco_centavos)}</p>
      <div class="product-actions">
        <button class="soft-btn add-cart-btn" type="button" data-add-cart="${escapeHtml(product.id)}" ${soldOut ? "disabled" : ""}>
          ${soldOut ? "Esgotado" : alreadyInCart ? "No carrinho ✓" : "Adicionar ao carrinho"}
        </button>
      </div>
    </div>
  </article>`;
}

function renderProducts(){
  const pageAlreadyRevealed = document.body.classList.contains("reveal-ready");

  document.querySelectorAll("[data-products]").forEach(grid=>{
    const mode = grid.dataset.products;
    const items = mode === "launches" ? PRODUTOS.slice(0,3) : PRODUTOS;
    if(!items.length && !grid.innerHTML) grid.innerHTML = `<div class="catalog-error">Catálogo indisponível.</div>`;
    else grid.innerHTML = items.map(productCard).join("");

    // renderProducts() também é chamado depois de adicionar/remover itens
    // do carrinho. Nessa altura o efeito reveal inicial já terminou; sem
    // a classe .in, os cards recém-recriados ficavam opacity:0 e pareciam
    // ter sumido da página.
    if(pageAlreadyRevealed){
      grid.querySelectorAll(".reveal").forEach(item=>item.classList.add("in"));
    }
  });

  document.querySelectorAll("[data-add-cart]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      addToCart(btn.dataset.addCart);
    });
  });
}

function loadCart(){
  try{
    const value = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || "[]");
    if(!Array.isArray(value)) return [];
    return value.filter(item => item && typeof item.id === "string").map(item => ({id:item.id, quantity:1}));
  }catch{
    return [];
  }
}

function saveCart(){
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(CART));
}

function sanitizeCart(){
  const valid = new Set(PRODUTOS.filter(p => Number(p.estoque) > 0).map(p => p.id));
  CART = CART.filter(item => valid.has(item.id));
  saveCart();
}

function addToCart(id){
  const product = productById(id);
  if(!product || Number(product.estoque) <= 0){
    showToast("Essa peça está esgotada 🧶");
    return;
  }
  if(!CART.some(item => item.id === id)){
    CART.push({id, quantity:1});
    saveCart();
    resetShipping();
    showToast(`${product.nome} foi para o carrinho ♡`);
  }
  renderProducts();
  renderCart();
  openCart();
}

function removeFromCart(id){
  CART = CART.filter(item => item.id !== id);
  saveCart();
  resetShipping();
  renderProducts();
  renderCart();
}

function cartDetailed(){
  return CART.map(item => ({...item, product:productById(item.id)})).filter(item => item.product);
}

function cartSubtotal(){
  return cartDetailed().reduce((sum,item)=>sum + Number(item.product.preco_centavos) * item.quantity, 0);
}

function cartPayload(){
  return CART.map(item => ({id:item.id, quantity:1}));
}

function resetShipping(){
  SHIPPING_QUOTES = [];
  SELECTED_SHIPPING_ID = null;
  QUOTED_CEP = "";
}

function captureCheckoutData(){
  const mappings = {
    cep:"checkoutCep", name:"checkoutName", email:"checkoutEmail", phone:"checkoutPhone", document:"checkoutDocument",
    street:"checkoutStreet", neighborhood:"checkoutNeighborhood", number:"checkoutNumber", complement:"checkoutComplement",
    city:"checkoutCity", state:"checkoutState"
  };
  for(const [key,id] of Object.entries(mappings)){
    const element = document.getElementById(id);
    if(element) CHECKOUT_DATA[key] = String(element.value || "");
  }
}

function selectedShipping(){
  return SHIPPING_QUOTES.find(option => String(option.id) === String(SELECTED_SHIPPING_ID));
}

function ensureCartUI(){
  if(document.getElementById("cartDrawer")) return;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <div class="cart-backdrop" id="cartBackdrop" hidden></div>
    <aside class="cart-drawer" id="cartDrawer" aria-hidden="true" aria-label="Carrinho de compras">
      <div class="cart-drawer-head">
        <div>
          <span class="cart-eyebrow">Silly Cat</span>
          <h2>Seu carrinho</h2>
        </div>
        <button class="cart-close" id="cartCloseButton" type="button" aria-label="Fechar carrinho">×</button>
      </div>

      <div class="cart-scroll">
        <div id="cartItems"></div>
        <div id="cartCheckoutArea"></div>
      </div>
    </aside>`;
  document.body.append(...wrapper.children);

  document.getElementById("cartBackdrop")?.addEventListener("click", closeCart);
  document.getElementById("cartCloseButton")?.addEventListener("click", closeCart);
  document.addEventListener("keydown", event => {
    if(event.key === "Escape") closeCart();
  });
}

function openCart(){
  ensureCartUI();
  const drawer = document.getElementById("cartDrawer");
  const backdrop = document.getElementById("cartBackdrop");
  if(!drawer || !backdrop) return;
  backdrop.hidden = false;
  requestAnimationFrame(()=>{
    backdrop.classList.add("show");
    drawer.classList.add("open");
  });
  drawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("cart-open");
}

function closeCart(){
  const drawer = document.getElementById("cartDrawer");
  const backdrop = document.getElementById("cartBackdrop");
  if(!drawer || !backdrop) return;
  drawer.classList.remove("open");
  backdrop.classList.remove("show");
  drawer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("cart-open");
  setTimeout(()=>{ if(!backdrop.classList.contains("show")) backdrop.hidden = true; }, 220);
}

function renderCart(){
  ensureCartUI();
  const itemsEl = document.getElementById("cartItems");
  const checkoutEl = document.getElementById("cartCheckoutArea");
  const countEls = document.querySelectorAll("[data-cart-count]");
  countEls.forEach(el => {
    el.textContent = String(CART.length);
    el.toggleAttribute("hidden", CART.length === 0);
  });

  if(!itemsEl || !checkoutEl) return;
  captureCheckoutData();
  const detailed = cartDetailed();

  if(!detailed.length){
    itemsEl.innerHTML = `<div class="cart-empty">
      <span class="cart-empty-icon">🧶</span>
      <h3>Seu carrinho está vazio</h3>
      <p>Escolha uma peça feita à mão para começar.</p>
    </div>`;
    checkoutEl.innerHTML = "";
    return;
  }

  itemsEl.innerHTML = `<div class="cart-item-list">${detailed.map(({product}) => `
    <article class="cart-item">
      <img src="${escapeHtml(product.img)}" alt="" loading="lazy">
      <div class="cart-item-copy">
        <strong>${escapeHtml(product.nome)}</strong>
        <span>${formatBRL(product.preco_centavos)}</span>
      </div>
      <button type="button" class="cart-remove" data-remove-cart="${escapeHtml(product.id)}" aria-label="Remover ${escapeHtml(product.nome)}">×</button>
    </article>`).join("")}</div>`;

  checkoutEl.innerHTML = checkoutMarkup();

  document.querySelectorAll("[data-remove-cart]").forEach(btn => {
    btn.addEventListener("click",()=>removeFromCart(btn.dataset.removeCart));
  });

  document.getElementById("shippingForm")?.addEventListener("submit", calculateShipping);
  document.getElementById("checkoutButton")?.addEventListener("click", createCheckout);
  document.getElementById("checkoutCep")?.addEventListener("input", formatCepInput);
  document.getElementById("checkoutPhone")?.addEventListener("input", formatPhoneInput);
  document.getElementById("checkoutDocument")?.addEventListener("input", formatCpfInput);
  document.getElementById("checkoutState")?.addEventListener("input", event => {
    event.target.value = event.target.value.replace(/[^a-zA-Z]/g, "").slice(0,2).toUpperCase();
    CHECKOUT_DATA.state = event.target.value;
  });
  document.querySelectorAll("input[name='shipping-option']").forEach(input => {
    input.addEventListener("change",()=>{
      SELECTED_SHIPPING_ID = input.value;
      renderCart();
    });
  });
}

function checkoutMarkup(){
  const subtotal = cartSubtotal();
  const freight = selectedShipping();
  const total = subtotal + Number(freight?.preco_centavos || 0);
  const quoteList = SHIPPING_QUOTES.length ? `
    <div class="shipping-choice-list" role="radiogroup" aria-label="Opções de frete">
      ${SHIPPING_QUOTES.map(option => {
        const checked = String(option.id) === String(SELECTED_SHIPPING_ID);
        const deadline = option.prazo_dias ? `${option.prazo_dias} dia${option.prazo_dias === 1 ? "" : "s"} úteis` : "Prazo informado pela transportadora";
        return `<label class="shipping-choice ${checked ? "selected" : ""}">
          <input type="radio" name="shipping-option" value="${escapeHtml(option.id)}" ${checked ? "checked" : ""}>
          <span>
            <b>${escapeHtml(option.transportadora)} · ${escapeHtml(option.nome)}</b>
            <small>${escapeHtml(deadline)}</small>
          </span>
          <strong>${formatBRL(option.preco_centavos)}</strong>
        </label>`;
      }).join("")}
    </div>` : "";

  return `<div class="cart-checkout">
    <div class="cart-summary-row"><span>Subtotal</span><strong>${formatBRL(subtotal)}</strong></div>

    <form class="shipping-form" id="shippingForm">
      <label for="checkoutCep">Calcular frete</label>
      <div class="shipping-cep-row">
        <input id="checkoutCep" name="cep" inputmode="numeric" autocomplete="postal-code" maxlength="9" placeholder="00000-000" value="${escapeHtml(CHECKOUT_DATA.cep)}" required>
        <button type="submit" class="soft-btn secondary" id="shippingCalculateButton">Calcular</button>
      </div>
      <p class="cart-form-note" id="shippingMessage">Informe o CEP para ver as opções do Melhor Envio.</p>
    </form>

    ${quoteList}

    <div class="delivery-data ${freight ? "visible" : ""}">
      <h3>Dados para entrega</h3>
      <div class="checkout-field-grid">
        <label class="full">Nome
          <input id="checkoutName" autocomplete="name" placeholder="Seu nome" value="${escapeHtml(CHECKOUT_DATA.name)}" required>
        </label>
        <label class="full">E-mail
          <input id="checkoutEmail" type="email" autocomplete="email" placeholder="voce@email.com" value="${escapeHtml(CHECKOUT_DATA.email)}" required>
        </label>
        <label>Telefone
          <input id="checkoutPhone" inputmode="tel" autocomplete="tel" placeholder="(16) 99999-9999" value="${escapeHtml(CHECKOUT_DATA.phone)}" required>
        </label>
        <label>CPF
          <input id="checkoutDocument" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="000.000.000-00" value="${escapeHtml(CHECKOUT_DATA.document)}" required>
        </label>
        <label class="full">Rua
          <input id="checkoutStreet" autocomplete="address-line1" placeholder="Rua / Avenida" value="${escapeHtml(CHECKOUT_DATA.street)}" required>
        </label>
        <label class="full">Bairro
          <input id="checkoutNeighborhood" autocomplete="address-level3" placeholder="Bairro" value="${escapeHtml(CHECKOUT_DATA.neighborhood)}" required>
        </label>
        <label>Número
          <input id="checkoutNumber" autocomplete="address-line2" placeholder="123" value="${escapeHtml(CHECKOUT_DATA.number)}" required>
        </label>
        <label>Complemento
          <input id="checkoutComplement" placeholder="Apto, bloco..." value="${escapeHtml(CHECKOUT_DATA.complement)}">
        </label>
        <label>Cidade
          <input id="checkoutCity" autocomplete="address-level2" placeholder="Cidade" value="${escapeHtml(CHECKOUT_DATA.city)}" required>
        </label>
        <label>UF
          <input id="checkoutState" autocomplete="address-level1" maxlength="2" placeholder="SP" value="${escapeHtml(CHECKOUT_DATA.state)}" required>
        </label>
      </div>
    </div>

    <div class="cart-total-box">
      <div><span>Produtos</span><strong>${formatBRL(subtotal)}</strong></div>
      <div><span>Frete</span><strong>${freight ? formatBRL(freight.preco_centavos) : "—"}</strong></div>
      <div class="cart-total-line"><span>Total</span><strong>${freight ? formatBRL(total) : formatBRL(subtotal)}</strong></div>
    </div>

    <button class="soft-btn checkout-pay-btn" id="checkoutButton" type="button" ${freight ? "" : "disabled"}>
      Pagar com InfinitePay
    </button>
    <p class="checkout-security-note">Pix ou cartão. O valor do frete é recalculado no servidor antes de criar o pagamento.</p>
  </div>`;
}

function formatCepInput(event){
  const digits = event.target.value.replace(/\D/g, "").slice(0,8);
  event.target.value = digits.length > 5 ? `${digits.slice(0,5)}-${digits.slice(5)}` : digits;
  CHECKOUT_DATA.cep = event.target.value;
  if(SHIPPING_QUOTES.length && digits !== QUOTED_CEP){
    SHIPPING_QUOTES = [];
    SELECTED_SHIPPING_ID = null;
    QUOTED_CEP = "";
    renderCart();
    const cep = document.getElementById("checkoutCep");
    if(cep){ cep.focus(); cep.setSelectionRange(cep.value.length, cep.value.length); }
  }
}

function formatPhoneInput(event){
  const value = event.target.value.replace(/\D/g, "").slice(0,11);
  if(value.length <= 2) event.target.value = value;
  else if(value.length <= 7) event.target.value = `(${value.slice(0,2)}) ${value.slice(2)}`;
  else event.target.value = `(${value.slice(0,2)}) ${value.slice(2, value.length === 11 ? 7 : 6)}-${value.slice(value.length === 11 ? 7 : 6)}`;
  CHECKOUT_DATA.phone = event.target.value;
}

function formatCpfInput(event){
  const value = event.target.value.replace(/\D/g, "").slice(0,11);
  let formatted = value;
  if(value.length > 3) formatted = `${value.slice(0,3)}.${value.slice(3)}`;
  if(value.length > 6) formatted = `${value.slice(0,3)}.${value.slice(3,6)}.${value.slice(6)}`;
  if(value.length > 9) formatted = `${value.slice(0,3)}.${value.slice(3,6)}.${value.slice(6,9)}-${value.slice(9)}`;
  event.target.value = formatted;
  CHECKOUT_DATA.document = formatted;
}

function setShippingMessage(message, kind=""){
  const el = document.getElementById("shippingMessage");
  if(!el) return;
  el.textContent = message;
  el.className = `cart-form-note ${kind}`.trim();
}

async function apiPost(path, payload){
  const response = await fetch(apiUrl(path), {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)
  });
  const data = await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
  return data;
}

async function calculateShipping(event){
  event.preventDefault();
  const cepInput = document.getElementById("checkoutCep");
  const button = document.getElementById("shippingCalculateButton");
  const postalCode = String(cepInput?.value || "").replace(/\D/g, "");
  if(postalCode.length !== 8){
    setShippingMessage("Digite um CEP válido com 8 dígitos.", "error");
    return;
  }

  if(button){ button.disabled = true; button.textContent = "Calculando..."; }
  setShippingMessage("Consultando transportadoras...", "loading");

  try{
    const data = await apiPost("/api/shipping/quote", {postalCode, items:cartPayload()});
    SHIPPING_QUOTES = Array.isArray(data.options) ? data.options : [];
    SELECTED_SHIPPING_ID = SHIPPING_QUOTES[0]?.id || null;
    QUOTED_CEP = postalCode;
    CHECKOUT_DATA.cep = `${postalCode.slice(0,5)}-${postalCode.slice(5)}`;
    renderCart();
    const warning = data.provisionalProducts?.length
      ? " Cotação de teste: algumas medidas de embalagem ainda estão marcadas como provisórias."
      : "";
    setShippingMessage(`Encontramos ${SHIPPING_QUOTES.length} opção(ões) de frete.${warning}`, data.provisionalProducts?.length ? "warning" : "success");
  }catch(error){
    resetShipping();
    renderCart();
    const message = document.getElementById("shippingMessage");
    if(message){
      message.textContent = error.message;
      message.className = "cart-form-note error";
    }
  }finally{
    const newButton = document.getElementById("shippingCalculateButton");
    if(newButton){ newButton.disabled = false; newButton.textContent = "Calcular"; }
  }
}

function checkoutField(id){
  return String(document.getElementById(id)?.value || "").trim();
}

async function createCheckout(){
  const shipping = selectedShipping();
  if(!shipping){
    showToast("Escolha uma opção de frete primeiro.");
    return;
  }

  const postalCode = checkoutField("checkoutCep").replace(/\D/g, "");
  const fields = {
    name: checkoutField("checkoutName"),
    email: checkoutField("checkoutEmail"),
    phone: checkoutField("checkoutPhone"),
    document: checkoutField("checkoutDocument"),
    street: checkoutField("checkoutStreet"),
    neighborhood: checkoutField("checkoutNeighborhood"),
    number: checkoutField("checkoutNumber"),
    complement: checkoutField("checkoutComplement"),
    city: checkoutField("checkoutCity"),
    state: checkoutField("checkoutState").toUpperCase()
  };

  if(postalCode.length !== 8 || !fields.name || !fields.email || !fields.phone || !fields.document || !fields.street || !fields.neighborhood || !fields.number || !fields.city || fields.state.length !== 2){
    showToast("Preencha os dados de entrega antes de continuar.");
    return;
  }

  const button = document.getElementById("checkoutButton");
  if(button){ button.disabled = true; button.textContent = "Criando pagamento..."; }

  try{
    const data = await apiPost("/api/checkout", {
      postalCode,
      shippingServiceId: shipping.id,
      items: cartPayload(),
      customer: {name:fields.name, email:fields.email, phone:fields.phone, document:fields.document},
      address: {
        cep: postalCode,
        street: fields.street,
        neighborhood: fields.neighborhood,
        number: fields.number,
        complement: fields.complement,
        city: fields.city,
        state: fields.state
      }
    });
    sessionStorage.setItem("silly-cat-last-order", JSON.stringify({
      order_nsu:data.order_nsu,
      total_centavos:data.total_centavos,
      created_at:new Date().toISOString()
    }));
    window.location.href = data.url;
  }catch(error){
    showToast(error.message);
    if(button){ button.disabled = false; button.textContent = "Pagar com InfinitePay"; }
  }
}

function initCartButtons(){
  document.querySelectorAll("[data-open-cart]").forEach(button => {
    button.addEventListener("click",()=>{
      renderCart();
      openCart();
    });
  });
}

function initNav(){
  const toggle = document.getElementById("navToggle");
  const links = document.getElementById("navLinks");
  if(!toggle || !links) return;
  toggle.addEventListener("click",()=>{
    const open = links.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  links.querySelectorAll("a").forEach(link=>link.addEventListener("click",()=>{
    links.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  }));
}

function initActiveNav(){
  const page = document.body.dataset.page;
  document.querySelectorAll(".nav-links a").forEach(a=>{
    if(a.dataset.nav === page) a.classList.add("active");
  });
}

function initReveal(){
  document.body.classList.add("reveal-ready");
  const items = document.querySelectorAll(".reveal");
  if(!("IntersectionObserver" in window)){
    items.forEach(item=>item.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver(entries=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting){
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
    });
  },{threshold:.1});
  items.forEach(item=>io.observe(item));
}

async function initPaymentResult(){
  const result = document.getElementById("paymentResult");
  if(!result) return;

  const params = new URLSearchParams(window.location.search);
  const orderNsu = params.get("order_nsu");
  const transactionNsu = params.get("transaction_nsu");
  const slug = params.get("slug");
  const receiptUrl = params.get("receipt_url");

  if(!orderNsu || !transactionNsu || !slug){
    result.innerHTML = `<div class="payment-state pending">
      <span class="payment-state-icon">♡</span>
      <h2>Pedido recebido</h2>
      <p>Quando o pagamento for concluído pela InfinitePay, você poderá voltar a esta página para conferir os dados.</p>
      <a class="soft-btn" href="produtos.html">Voltar aos produtos</a>
    </div>`;
    return;
  }

  result.innerHTML = `<div class="payment-state pending"><span class="payment-state-icon">…</span><h2>Conferindo pagamento</h2><p>Estamos verificando a confirmação da InfinitePay.</p></div>`;

  try{
    const data = await apiPost("/api/payment-status", {
      order_nsu:orderNsu,
      transaction_nsu:transactionNsu,
      slug,
      receipt_url: receiptUrl
    });
    if(data.paid){
      CART = [];
      saveCart();
      const receiptLink = data.receipt_url || receiptUrl;
      const receipt = receiptLink ? `<a class="soft-btn secondary" href="${escapeHtml(receiptLink)}" target="_blank" rel="noopener">Ver comprovante</a>` : "";
      result.innerHTML = `<div class="payment-state success">
        <span class="payment-state-icon">✓</span>
        <h2>Pagamento confirmado!</h2>
        <p>Pedido <b>${escapeHtml(orderNsu)}</b>. Obrigada por comprar uma peça da Silly Cat ♡</p>
        <p>Valor confirmado: <b>${formatBRL(data.amount)}</b></p>
        <div class="payment-state-actions">${receipt}<a class="soft-btn" href="produtos.html">Continuar navegando</a></div>
      </div>`;
    }else{
      result.innerHTML = `<div class="payment-state pending"><span class="payment-state-icon">⌛</span><h2>Pagamento em processamento</h2><p>O pedido ${escapeHtml(orderNsu)} ainda não consta como pago. Se você acabou de pagar via Pix, tente atualizar a página em alguns segundos.</p></div>`;
    }
  }catch(error){
    result.innerHTML = `<div class="payment-state pending"><span class="payment-state-icon">♡</span><h2>Pedido criado</h2><p>Não conseguimos consultar a InfinitePay neste momento, mas seu pagamento pode ter sido concluído normalmente.</p><p class="payment-error-detail">${escapeHtml(error.message)}</p></div>`;
  }
}

document.addEventListener("DOMContentLoaded", async ()=>{
  const year = document.getElementById("year");
  if(year) year.textContent = new Date().getFullYear();
  initNav();
  initActiveNav();
  ensureCartUI();
  initCartButtons();
  await loadCatalog();
  sanitizeCart();
  renderProducts();
  renderCart();
  initReveal();
  initPaymentResult();
});
