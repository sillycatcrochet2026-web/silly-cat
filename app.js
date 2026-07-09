const LINKS = {
  catalogo: "https://app.moirabr.com.br/perfil/silly-cat/",
  instagram: "https://www.instagram.com/sillycat_croche/",

  // Link geral do WhatsApp para pedidos de São Carlos.
  // Exemplo: "https://wa.me/5516999999999"
  whatsapp: "https://wa.me/5567993349695"
};

const PRODUTOS = [
  { nome:"Pompompurin", preco:"R$ 65,90", precoSemTaxa:"R$ 45,90", desc:"Pompompurin feito de linha amigurumi. Altura: 11cm; Largura mão a mão 14cm", img:"img/pompompurin.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-4841989959-pompompurin-de-croch-_JM", tag:"Novo" },
  { nome:"Chaveiro gatinho amarelo", preco:"R$ 44,90", precoSemTaxa:"R$ 39,90", desc:"Chaveiro gatinho amarelo feito de linha amigurumi. Altura: 8cm.", img:"img/gatinho_amarelo.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-4867134163-gatinho-amarelo-croch-_JM", tag:"Novo" },
  { nome:"Ursinha Rosa De Crochê Com Lacinhos", preco:"R$ 149,90", precoSemTaxa:"R$ 119,90", desc:"Ursinha Rosa De Crochê Com Lacinhos. Altura: 22cm", img:"img/ursinharosa.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-4825305923-ursinha-rosa-de-croch-com-lacinhos-_JM", tag:"Novo" },
  { nome:"Sylvanian Coelho Chocolate", preco:"R$ 189,90", precoSemTaxa:"R$ 152,90", desc:"Feito com linha chenille, macio e perfeito para presentear. Altura: 37 cm", img:"img/coelho_choc.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-4825137483-sylvanian-coelho-chocolate-amigurumi-37cm-_JM", tag:"Novo" },
  { nome:"Ursinho Amarelo", preco:"R$ 149,90", precoSemTaxa:"R$ 119,90", desc:"Ursinho amarelo com roupinha feito com linha chenille. Altura: 22cm.", img:"img/ursinhoamarelo.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-4825320109-ursinho-amarelo-croch-_JM", tag:"Novo" },
  { nome:"Jiji (Kiki's Delivery Service)", preco:"R$ 119,90", precoSemTaxa:"R$ 89,90", desc:"Feito com linha Chenille, com detalhes em feltro. Altura: 24 cm.", img:"img/Jiji.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-4825115459-jiji-amigurumi-kikis-delivery-service-_JM", tag:"Novo" },
  { nome:"Coelhinha Rosa", preco:"R$ 159,90", precoSemTaxa:"R$ 129,90", desc:"Coelhinha com vestido rosa e lacinhos feito com linha chenille. Altura: 22cm.", img:"img/coelha.jpg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-4825321417-coelhinha-de-vestido-rosa-de-croch-_JM", tag:"Novo" },
  { nome:"Miffy tomatinho", preco:"R$ 99,00", precoSemTaxa:"R$ 74,90", desc:"Miffy tomatinho feito de linha amigurumi soft. Altura: 17 cm.", img:"img/miffy.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-7057391270-miffy-tomatinho-de-croch-_JM", tag:"Novo"}
  { nome:"Gatinho Silly Milkshake", preco:"R$ 58,00", precoSemTaxa:"R$ 45,00", desc:"Amigurumi da nossa mascote em versão chaveiro, feito à mão com carinho.", img:"img/gatorosa.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-7054796944-gatinho-de-croch-rosa-_JM", tag:"Esgotado" },
  { nome:"Snoopy Chaveiro", preco:"R$ 75,00", precoSemTaxa:"R$ 54,90", desc:"Chaveiro Snoopy feito de linha amigurumi. Altura: 13 cm", img:"img/snoopy.jpeg", mercadoLivre:"https://produto.mercadolivre.com.br/MLB-4825260713-snoopy-de-croch-_JM", tag:"Esgotado" },
];

const PLACEHOLDER = /COLE_AQUI/;

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

function openProduct(url){
  if(!url || PLACEHOLDER.test(url)){
    showToast("Esse link ainda está sendo preparado 🧶");
    return;
  }
  window.open(url,"_blank","noopener");
}

function buildWhatsAppLink(product){
  const base = LINKS.whatsapp;
  if(!base || PLACEHOLDER.test(base)) return base;

  const mensagem = `Olá! Quero comprar ${product.nome} para entrega em São Carlos (SP). Preço sem taxa: ${product.precoSemTaxa || product.preco}. Podemos combinar o frete?`;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}text=${encodeURIComponent(mensagem)}`;
}

function productCard(product, index){
  const hasImage = product.img && !PLACEHOLDER.test(product.img);
  const media = hasImage
    ? `<img src="${escapeHtml(product.img)}" alt="${escapeHtml(product.nome)}" loading="lazy" onerror="this.closest('.product-media').innerHTML='<div class=&quot;product-placeholder&quot;>${sillyCatSvg().replaceAll('"','&quot;')}</div><span class=&quot;product-badge&quot;>${escapeHtml(product.tag || 'Silly')}</span>'">`
    : `<div class="product-placeholder">${sillyCatSvg()}</div>`;

  const optionsId = `shipping-options-${index}`;
  const whatsappLink = buildWhatsAppLink(product);
  const mercadoLivreLink = product.mercadoLivre;
  const precoSemTaxa = product.precoSemTaxa || product.preco;

  return `<article class="product-card reveal" style="--i:${index}">
    <div class="product-media" style="background:${['#e6edf8','#fffddc','#dbe5f5','#ffffff'][index%4]}">
      ${media}
      <span class="product-badge">${escapeHtml(product.tag || 'Silly')}</span>
    </div>
    <div class="product-body">
      <h3 class="product-name">${escapeHtml(product.nome)}</h3>
      <p class="product-desc">${escapeHtml(product.desc)} <span class="free-shipping">Frete grátis</span></p>
      <p class="price">${escapeHtml(product.preco)}</p>
      <div class="product-actions">
        <button class="soft-btn buy-toggle" type="button" data-buy-toggle aria-expanded="false" aria-controls="${optionsId}">Comprar</button>
      </div>
      <div class="shipping-options" id="${optionsId}" aria-hidden="true">
        <p class="shipping-title">Envios para:</p>
        <button class="shipping-option" type="button" data-shipping-link="${escapeHtml(whatsappLink)}">
          <span class="shipping-number">1</span>
          <span><b>São Carlos (SP)</b><small>${escapeHtml(precoSemTaxa)} + frete a combinar</small></span>
        </button>
        <button class="shipping-option" type="button" data-shipping-link="${escapeHtml(mercadoLivreLink)}">
          <span class="shipping-number">2</span>
          <span><b>Outras cidades</b><small>Mercado Livre (Frete Grátis)</small></span>
        </button>
      </div>
    </div>
  </article>`;
}

function renderProducts(){
  document.querySelectorAll("[data-products]").forEach(grid=>{
    const mode = grid.dataset.products;
    const items = mode === "launches" ? PRODUTOS.slice(0,3) : PRODUTOS;
    grid.innerHTML = items.map(productCard).join("");
  });

  document.querySelectorAll("[data-buy-toggle]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const card = btn.closest(".product-card");
      const options = card?.querySelector(".shipping-options");
      if(!card || !options) return;
      const open = card.classList.toggle("buy-open");
      btn.setAttribute("aria-expanded", String(open));
      options.setAttribute("aria-hidden", String(!open));
    });
  });

  document.querySelectorAll("[data-shipping-link]").forEach(btn=>{
    btn.addEventListener("click",()=>openProduct(btn.dataset.shippingLink));
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

document.addEventListener("DOMContentLoaded",()=>{
  const year = document.getElementById("year");
  if(year) year.textContent = new Date().getFullYear();
  renderProducts();
  initNav();
  initActiveNav();
  initReveal();
});
