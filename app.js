const PLACEHOLDER = /COLE_AQUI/;
const CART_STORAGE_KEY = "silly-cat-cart-v2";
const LEGACY_CART_STORAGE_KEY = "silly-cat-cart-v1";
const MAX_CART_QUANTITY = 20;
const CATEGORY_LABELS = {
  todos:"Todos", gatos:"Gatos", snoopy:"Snoopy", galinhas:"Galinhas",
  flamulas:"Flâmulas", coelhos:"Coelhos", pokemons:"Pokémons", outros:"Outros"
};
let PRODUTOS = [];
let CART = loadCart();
let SHIPPING_QUOTES = [];
let SELECTED_SHIPPING_ID = null;
let QUOTED_CEP = "";
let SERVER_PRODUCTION_INFO = null;
let CATALOG_QUERY = "";
let CATALOG_CATEGORY = "todos";
let CHECKOUT_DATA = {
  cep:"", name:"", email:"", phone:"", document:"", street:"", neighborhood:"", number:"", complement:"", city:"", state:""
};

function apiBaseUrl(){ return String(window.SILLY_CAT_ECOMMERCE?.apiBaseUrl || "").replace(/\/$/, ""); }
function apiUrl(path){ return `${apiBaseUrl()}${path}`; }
function formatBRL(cents){ return new Intl.NumberFormat("pt-BR", {style:"currency", currency:"BRL"}).format(Number(cents || 0) / 100); }
function sillyCatSvg(){ return `<svg viewBox="0 0 240 250" aria-hidden="true"><use href="#sillycat"></use></svg>`; }
function escapeHtml(value){
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function showToast(msg){
  const toast = document.getElementById("toast"); if(!toast) return;
  toast.textContent = msg; toast.classList.add("show"); clearTimeout(toast._timer);
  toast._timer = setTimeout(()=>toast.classList.remove("show"), 3200);
}
function normalizeProductTag(product){
  const tag = String(product.tag || "").trim().toLowerCase();
  if(Number(product.estoque) <= 0) return "SOB ENCOMENDA";
  if(tag === "novo") return "NOVO";
  return "";
}
function formatProductDimensions(product){
  const frete = product?.frete || {};
  const width = Number(frete.largura || 0), height = Number(frete.altura || 0), length = Number(frete.comprimento || 0), weight = Number(frete.peso || 0);
  if(!(width > 0 && height > 0 && length > 0)) return "";
  const weightText = weight > 0 ? ` · ${String(weight).replace(".", ",")} kg` : "";
  return `${width} × ${height} × ${length} cm${weightText}`;
}
function productImages(product){
  const list = Array.isArray(product?.images) ? product.images.filter(Boolean) : [];
  if(list.length) return list;
  return product?.img ? [product.img] : [];
}
function productVariants(product){ return Array.isArray(product?.variacoes) ? product.variacoes.filter(v=>v && v.id) : []; }
function variantById(product, variantId){ return productVariants(product).find(v=>String(v.id)===String(variantId || "")) || null; }
function effectivePrice(product, variant){ return Number(variant?.preco_centavos ?? product?.preco_centavos ?? 0); }
function effectiveStock(product, variant){ return Math.max(0, Number(variant ? variant.estoque : product?.estoque || 0)); }
function cartLineKey(id, variantId=""){ return `${id}::${variantId || ""}`; }

async function loadCatalog(){
  try{
    const response = await fetch(apiUrl("/api/catalog"), {cache:"no-store"});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json(); if(!Array.isArray(data)) throw new Error("Catálogo inválido");
    PRODUTOS = data;
  }catch(error){
    console.error("Não foi possível carregar o catálogo", error); PRODUTOS = [];
    document.querySelectorAll("[data-products]").forEach(grid => { grid.innerHTML = `<div class="catalog-error">Não conseguimos carregar o catálogo agora. Tente atualizar a página.</div>`; });
  }
}
function productById(id){ return PRODUTOS.find(product => product.id === id); }

function carouselMarkup(product, index){
  const images = productImages(product);
  const badgeLabel = normalizeProductTag(product);
  const badgeClass = badgeLabel ? ` product-badge--${badgeLabel.toLowerCase().replace(/\s+/g, "-")}` : "";
  const badge = badgeLabel ? `<span class="product-badge${badgeClass}">${escapeHtml(badgeLabel)}</span>` : "";
  if(!images.length) return `<div class="product-media" style="background:${['#e6edf8','#fffddc','#dbe5f5','#ffffff'][index%4]}"><div class="product-placeholder">${sillyCatSvg()}</div>${badge}</div>`;
  const slides = images.map((src,i)=>`<img class="product-carousel-slide${i===0?" active":""}" src="${escapeHtml(src)}" alt="${escapeHtml(product.nome)}${images.length>1?` — foto ${i+1}`:""}" loading="lazy">`).join("");
  const controls = images.length > 1 ? `<button type="button" class="carousel-arrow prev" data-carousel-prev aria-label="Foto anterior">‹</button><button type="button" class="carousel-arrow next" data-carousel-next aria-label="Próxima foto">›</button><div class="carousel-dots">${images.map((_,i)=>`<button type="button" class="carousel-dot${i===0?" active":""}" data-carousel-dot="${i}" aria-label="Ver foto ${i+1}"></button>`).join("")}</div>` : "";
  return `<div class="product-media product-carousel" data-carousel-index="0" style="background:${['#e6edf8','#fffddc','#dbe5f5','#ffffff'][index%4]}">${slides}${controls}${badge}</div>`;
}

function productCard(product, index){
  const variants = productVariants(product);
  const prices = variants.length ? variants.map(v=>effectivePrice(product,v)) : [Number(product.preco_centavos)];
  const minPrice = Math.min(...prices), maxPrice = Math.max(...prices);
  const priceLabel = minPrice === maxPrice ? formatBRL(minPrice) : `A partir de ${formatBRL(minPrice)}`;
  const variantMarkup = variants.length ? `<label class="product-variant-field">Variação<select data-product-variant="${escapeHtml(product.id)}">${variants.map((v,i)=>`<option value="${escapeHtml(v.id)}" data-price="${effectivePrice(product,v)}" data-stock="${effectiveStock(product,v)}"${i===0?" selected":""}>${escapeHtml(v.nome)}${effectiveStock(product,v)<=0?" · sob encomenda":""}</option>`).join("")}</select></label>` : "";
  const madeToOrder = variants.length ? variants.every(v=>effectiveStock(product,v)<=0) : Number(product.estoque)<=0;
  return `<article class="product-card reveal" style="--i:${index}" data-product-card="${escapeHtml(product.id)}">
    ${carouselMarkup(product,index)}
    <div class="product-body">
      <h3 class="product-name">${escapeHtml(product.nome)}</h3>
      <p class="product-desc">${escapeHtml(product.desc)}</p>
      <p class="price" data-product-price>${priceLabel}</p>
      ${variantMarkup}
      <div class="product-actions"><button class="soft-btn add-cart-btn" type="button" data-add-cart="${escapeHtml(product.id)}">${madeToOrder ? "Encomendar" : "Adicionar ao carrinho"}</button></div>
    </div>
  </article>`;
}

function filteredProducts(items){
  const q = CATALOG_QUERY.trim().toLowerCase();
  return items.filter(product=>{
    const category = String(product.categoria || "outros").toLowerCase();
    if(CATALOG_CATEGORY !== "todos" && category !== CATALOG_CATEGORY) return false;
    if(!q) return true;
    const variants = productVariants(product).map(v=>v.nome).join(" ");
    return `${product.nome} ${product.desc || ""} ${variants}`.toLowerCase().includes(q);
  });
}

function ensureCatalogControls(){
  document.querySelectorAll('[data-products="all"]').forEach(grid=>{
    if(grid.previousElementSibling?.classList?.contains("catalog-browser")) return;
    const wrapper = document.createElement("section"); wrapper.className = "catalog-browser";
    wrapper.innerHTML = `<div class="catalog-search"><span aria-hidden="true">⌕</span><input type="search" data-catalog-search placeholder="Buscar por nome…" autocomplete="off"></div><div class="catalog-filters" role="group" aria-label="Filtrar produtos">${Object.entries(CATEGORY_LABELS).map(([value,label])=>`<button type="button" class="catalog-filter${value==="todos"?" active":""}" data-catalog-category="${value}">${label}</button>`).join("")}</div>`;
    grid.parentNode.insertBefore(wrapper, grid);
    wrapper.querySelector("[data-catalog-search]")?.addEventListener("input",e=>{ CATALOG_QUERY=e.target.value; renderProducts(); });
    wrapper.querySelectorAll("[data-catalog-category]").forEach(btn=>btn.addEventListener("click",()=>{ CATALOG_CATEGORY=btn.dataset.catalogCategory; wrapper.querySelectorAll(".catalog-filter").forEach(b=>b.classList.toggle("active",b===btn)); renderProducts(); }));
  });
}

function initCarousels(scope=document){
  scope.querySelectorAll(".product-carousel").forEach(carousel=>{
    const slides=[...carousel.querySelectorAll(".product-carousel-slide")], dots=[...carousel.querySelectorAll(".carousel-dot")];
    if(slides.length<2) return;
    const show=(index)=>{ const next=(index+slides.length)%slides.length; carousel.dataset.carouselIndex=String(next); slides.forEach((s,i)=>s.classList.toggle("active",i===next)); dots.forEach((d,i)=>d.classList.toggle("active",i===next)); };
    carousel.querySelector("[data-carousel-prev]")?.addEventListener("click",e=>{e.stopPropagation();show(Number(carousel.dataset.carouselIndex||0)-1);});
    carousel.querySelector("[data-carousel-next]")?.addEventListener("click",e=>{e.stopPropagation();show(Number(carousel.dataset.carouselIndex||0)+1);});
    dots.forEach(dot=>dot.addEventListener("click",e=>{e.stopPropagation();show(Number(dot.dataset.carouselDot));}));
    let startX=null; carousel.addEventListener("touchstart",e=>{startX=e.touches?.[0]?.clientX ?? null;},{passive:true});
    carousel.addEventListener("touchend",e=>{ if(startX===null) return; const dx=(e.changedTouches?.[0]?.clientX??startX)-startX; if(Math.abs(dx)>40) show(Number(carousel.dataset.carouselIndex||0)+(dx<0?1:-1)); startX=null;},{passive:true});
  });
}

function renderProducts(){
  const pageAlreadyRevealed = document.body.classList.contains("reveal-ready");
  document.querySelectorAll("[data-products]").forEach(grid=>{
    const mode=grid.dataset.products;
    const base = mode === "launches" ? PRODUTOS.slice(0,3) : PRODUTOS;
    const items = mode === "all" ? filteredProducts(base) : base;
    grid.innerHTML = items.length ? items.map(productCard).join("") : `<div class="catalog-empty">Nenhum produto encontrado para essa busca.</div>`;
    if(pageAlreadyRevealed) grid.querySelectorAll(".reveal").forEach(item=>item.classList.add("in"));
    initCarousels(grid);
  });
  document.querySelectorAll("[data-add-cart]").forEach(btn=>btn.addEventListener("click",()=>{
    const select=document.querySelector(`[data-product-variant="${CSS.escape(btn.dataset.addCart)}"]`);
    addToCart(btn.dataset.addCart, select?.value || "");
  }));
  document.querySelectorAll("[data-product-variant]").forEach(select=>select.addEventListener("change",()=>{
    const product=productById(select.dataset.productVariant), variant=variantById(product,select.value), card=select.closest("[data-product-card]");
    if(card) card.querySelector("[data-product-price]").textContent=formatBRL(effectivePrice(product,variant));
    const button=card?.querySelector("[data-add-cart]"); if(button) button.textContent=effectiveStock(product,variant)<=0?"Encomendar":"Adicionar ao carrinho";
  }));
}

function loadCart(){
  try{
    const raw=localStorage.getItem(CART_STORAGE_KEY) || localStorage.getItem(LEGACY_CART_STORAGE_KEY) || "[]";
    const value=JSON.parse(raw); if(!Array.isArray(value)) return [];
    return value.filter(item=>item&&typeof item.id==="string").map(item=>({id:item.id,variant_id:String(item.variant_id||""),quantity:Math.min(MAX_CART_QUANTITY,Math.max(1,Math.floor(Number(item.quantity||1))))}));
  }catch{return [];}
}
function saveCart(){ localStorage.setItem(CART_STORAGE_KEY,JSON.stringify(CART)); localStorage.removeItem(LEGACY_CART_STORAGE_KEY); }
function sanitizeCart(){
  CART=CART.flatMap(item=>{
    const product=productById(item.id); if(!product) return [];
    const variants=productVariants(product); let variantId=String(item.variant_id||"");
    if(variants.length && !variantById(product,variantId)) variantId=variants[0]?.id || "";
    if(!variants.length) variantId="";
    return [{id:item.id,variant_id:variantId,quantity:Math.min(MAX_CART_QUANTITY,Math.max(1,Math.floor(Number(item.quantity||1))))}];
  }); saveCart();
}
function addToCart(id, variantId=""){
  const product=productById(id); if(!product) return;
  const variants=productVariants(product); const variant=variants.length ? (variantById(product,variantId)||variants[0]) : null;
  const key=cartLineKey(id,variant?.id||"");
  const existing=CART.find(item=>cartLineKey(item.id,item.variant_id)===key);
  if(existing) existing.quantity=Math.min(MAX_CART_QUANTITY,existing.quantity+1);
  else CART.push({id,variant_id:variant?.id||"",quantity:1});
  saveCart(); resetShipping();
  showToast(`${product.nome}${variant?` · ${variant.nome}`:""} foi para o carrinho ♡`);
  renderProducts(); renderCart(); openCart();
}
function setCartQuantity(key,quantity){ const item=CART.find(entry=>cartLineKey(entry.id,entry.variant_id)===key); if(!item)return; const next=Math.min(MAX_CART_QUANTITY,Math.max(1,Math.floor(Number(quantity||1)))); if(next===item.quantity)return; item.quantity=next; saveCart(); resetShipping(); renderProducts(); renderCart(); }
function changeCartQuantity(key,delta){ const item=CART.find(entry=>cartLineKey(entry.id,entry.variant_id)===key); if(item)setCartQuantity(key,Number(item.quantity||1)+Number(delta||0)); }
function removeFromCart(key){ CART=CART.filter(item=>cartLineKey(item.id,item.variant_id)!==key); saveCart(); resetShipping(); renderProducts(); renderCart(); }
function cartDetailed(){
  return CART.map(item=>{ const product=productById(item.id); if(!product)return null; const variant=variantById(product,item.variant_id); return {...item,product,variant,unitPrice:effectivePrice(product,variant),stock:effectiveStock(product,variant),key:cartLineKey(item.id,item.variant_id)}; }).filter(Boolean);
}
function cartSubtotal(){ return cartDetailed().reduce((sum,item)=>sum+item.unitPrice*item.quantity,0); }
function cartPayload(){ return CART.map(item=>({id:item.id,variant_id:item.variant_id||undefined,quantity:Math.max(1,Number(item.quantity||1))})); }
function localProductionInfo(){
  const items=cartDetailed().map(item=>({id:item.product.id,nome:item.product.nome,variant_id:item.variant?.id||null,variant_name:item.variant?.nome||null,quantity:item.quantity,stock:item.stock,production_quantity:Math.max(0,item.quantity-item.stock)})).filter(item=>item.production_quantity>0);
  const units=items.reduce((s,i)=>s+i.production_quantity,0); return {required:units>0,units,production_days:units>0?7:0,dispatch_extra_days:units>0?3:0,items};
}
function currentProductionInfo(){ return SERVER_PRODUCTION_INFO || localProductionInfo(); }
function resetShipping(){ SHIPPING_QUOTES=[]; SELECTED_SHIPPING_ID=null; QUOTED_CEP=""; SERVER_PRODUCTION_INFO=null; }


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
  const itemsEl=document.getElementById("cartItems"), checkoutEl=document.getElementById("cartCheckoutArea");
  const cartUnitCount=CART.reduce((sum,item)=>sum+Math.max(1,Number(item.quantity||1)),0);
  document.querySelectorAll("[data-cart-count]").forEach(el=>{el.textContent=String(cartUnitCount);el.toggleAttribute("hidden",cartUnitCount===0);});
  if(!itemsEl||!checkoutEl)return;
  captureCheckoutData(); const detailed=cartDetailed();
  if(!detailed.length){
    itemsEl.innerHTML=`<div class="cart-empty"><span class="cart-empty-icon">🧶</span><h3>Seu carrinho está vazio</h3><p>Escolha uma peça feita à mão para começar.</p></div>`;
    checkoutEl.innerHTML=""; return;
  }
  itemsEl.innerHTML=`<div class="cart-item-list">${detailed.map(item=>{
    const {product,variant,quantity,key,unitPrice,stock}=item;
    const productionQuantity=Math.max(0,quantity-stock), dimensions=formatProductDimensions(product), image=productImages(product)[0]||"";
    const availability=productionQuantity>0
      ? `<small class="cart-item-availability warning">${productionQuantity} un. sob encomenda · ${Math.min(stock,quantity)} pronta(s)</small>`
      : `<small class="cart-item-availability">${quantity} un. em pronta entrega</small>`;
    return `<article class="cart-item">
      ${image?`<img src="${escapeHtml(image)}" alt="" loading="lazy">`:`<div class="cart-item-placeholder">🧶</div>`}
      <div class="cart-item-copy">
        <strong>${escapeHtml(product.nome)}</strong>
        ${variant?`<small class="cart-item-variant">Variação: <b>${escapeHtml(variant.nome)}</b></small>`:""}
        <span>${formatBRL(unitPrice)} cada</span>
        ${dimensions?`<small class="cart-item-dimensions"><b>Dimensões:</b> ${escapeHtml(dimensions)}</small>`:""}
        ${availability}
        <div class="cart-quantity" aria-label="Quantidade de ${escapeHtml(product.nome)}">
          <button type="button" data-cart-minus="${escapeHtml(key)}" aria-label="Diminuir quantidade">−</button>
          <input type="number" min="1" max="${MAX_CART_QUANTITY}" value="${Number(quantity)}" data-cart-quantity="${escapeHtml(key)}" aria-label="Quantidade">
          <button type="button" data-cart-plus="${escapeHtml(key)}" aria-label="Aumentar quantidade">+</button>
        </div>
      </div>
      <button type="button" class="cart-remove" data-remove-cart="${escapeHtml(key)}" aria-label="Remover ${escapeHtml(product.nome)}">×</button>
    </article>`;
  }).join("")}</div>`;

  checkoutEl.innerHTML=checkoutMarkup();
  document.querySelectorAll("[data-remove-cart]").forEach(btn=>btn.addEventListener("click",()=>removeFromCart(btn.dataset.removeCart)));
  document.querySelectorAll("[data-cart-minus]").forEach(btn=>btn.addEventListener("click",()=>changeCartQuantity(btn.dataset.cartMinus,-1)));
  document.querySelectorAll("[data-cart-plus]").forEach(btn=>btn.addEventListener("click",()=>changeCartQuantity(btn.dataset.cartPlus,1)));
  document.querySelectorAll("[data-cart-quantity]").forEach(input=>input.addEventListener("change",()=>setCartQuantity(input.dataset.cartQuantity,input.value)));
  document.getElementById("shippingForm")?.addEventListener("submit",calculateShipping);
  document.getElementById("checkoutButton")?.addEventListener("click",createCheckout);
  document.getElementById("checkoutCep")?.addEventListener("input",formatCepInput);
  document.getElementById("checkoutPhone")?.addEventListener("input",formatPhoneInput);
  document.getElementById("checkoutDocument")?.addEventListener("input",formatCpfInput);
  document.getElementById("checkoutState")?.addEventListener("input",event=>{event.target.value=event.target.value.replace(/[^a-zA-Z]/g,"").slice(0,2).toUpperCase();CHECKOUT_DATA.state=event.target.value;});
  document.querySelectorAll("input[name='shipping-option']").forEach(input=>input.addEventListener("change",()=>{SELECTED_SHIPPING_ID=input.value;renderCart();}));
}


function checkoutMarkup(){
  const subtotal = cartSubtotal();
  const freight = selectedShipping();
  const total = subtotal + Number(freight?.preco_centavos || 0);
  const production = currentProductionInfo();
  const productionNotice = production.required ? `
    <div class="production-notice" role="status">
      <strong>🧶 Parte do pedido será feita sob encomenda</strong>
      <p><b>${production.units}</b> ${production.units === 1 ? "item do seu carrinho será produzido" : "itens do seu carrinho serão produzidos"} primeiro. A produção pode levar até <b>${production.production_days || 7} dias</b>. Depois, o pedido inteiro será enviado junto.</p>
      <p>O prazo de envio exibido abaixo já recebe <b>+${production.dispatch_extra_days || 3} dias</b> de margem para preparação/postagem. A etiqueta só será gerada quando a produção estiver concluída.</p>
    </div>` : "";
  const quoteList = SHIPPING_QUOTES.length ? `
    <div class="shipping-choice-list" role="radiogroup" aria-label="Opções de frete">
      ${SHIPPING_QUOTES.map(option => {
        const checked = String(option.id) === String(SELECTED_SHIPPING_ID);
        const deadline = option.prazo_dias ? `${option.prazo_dias} dia${option.prazo_dias === 1 ? "" : "s"} úteis` : "Prazo informado pela transportadora";
        const baseDeadline = option.prazo_transportadora_dias && production.required
          ? `Envio: ${option.prazo_dias} dias úteis (${option.prazo_transportadora_dias} + ${production.dispatch_extra_days || 3})`
          : deadline;
        return `<label class="shipping-choice ${checked ? "selected" : ""}">
          <input type="radio" name="shipping-option" value="${escapeHtml(option.id)}" ${checked ? "checked" : ""}>
          <span>
            <b>${escapeHtml(option.transportadora)} · ${escapeHtml(option.nome)}</b>
            <small>${escapeHtml(baseDeadline)}</small>
          </span>
          <strong>${formatBRL(option.preco_centavos)}</strong>
        </label>`;
      }).join("")}
    </div>` : "";

  return `<div class="cart-checkout">
    <div class="cart-summary-row"><span>Subtotal</span><strong>${formatBRL(subtotal)}</strong></div>
    ${productionNotice}

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
    SERVER_PRODUCTION_INFO = data.production || localProductionInfo();
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
      const productionMessage = data.requires_production
        ? `<div class="payment-production-note"><b>🧶 Pedido com encomenda</b><br>${Number(data.production_units || 0)} ${Number(data.production_units || 0) === 1 ? "item será produzido" : "itens serão produzidos"} antes do envio. A produção pode levar até ${Number(data.production_days || 7)} dias; depois, tudo será enviado junto.</div>`
        : "";
      result.innerHTML = `<div class="payment-state success">
        <span class="payment-state-icon">✓</span>
        <h2>Pagamento confirmado!</h2>
        <p>Pedido <b>${escapeHtml(orderNsu)}</b>. Obrigada por comprar uma peça da Silly Cat ♡</p>
        <p>Valor confirmado: <b>${formatBRL(data.amount)}</b></p>
        ${productionMessage}
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
  ensureCatalogControls();
  renderProducts();
  renderCart();
  initReveal();
  initPaymentResult();
});
