const LINKS = {
  catalogo: "https://app.moirabr.com.br/perfil/silly-cat/",
  instagram: "https://www.instagram.com/sillycat_croche/"
};

const PRODUTOS = [
  { nome:"Gatinho Silly Milkshake", preco:"R$ 45,00", desc:"Amigurumi da nossa mascote em versão chaveiro, feito à mão com carinho.", img:"img/gatorosa.jpeg", olx:"https://sp.olx.com.br/regiao-de-ribeirao-preto/para-a-sua-casa/decoracoes-para-casa/gatinho-chaveiro-rosa-1513574592?utm_medium=shared_link&utm_source=whatsapp", tag:"Novo" },
  { nome:"Snorlax", preco:"R$ 119,90", desc:"O dorminhoco mais fofo para deixar sua estante mais silly.", img:"", olx:"COLE_AQUI_O_LINK_DA_OLX", tag:"Hit" },
  { nome:"Ursinhos Casal", preco:"R$ 129,90", desc:"Dupla de ursinhos em fio chenille, macios e perfeitos para presentear.", img:"", olx:"COLE_AQUI_O_LINK_DA_OLX", tag:"Presente" },
  { nome:"Hello Kitty", preco:"R$ 110,00", desc:"Pelúcia em crochê cheia de charme, delicadeza e personalidade.", img:"", olx:"COLE_AQUI_O_LINK_DA_OLX", tag:"Fofo" },
  { nome:"Chaveiro Coração", preco:"R$ 24,90", desc:"O presentinho perfeito para levar um toque handmade para todo lugar.", img:"", olx:"COLE_AQUI_O_LINK_DA_OLX", tag:"Mini" },
  { nome:"Móbile Passarinhos", preco:"R$ 149,90", desc:"Decoração delicada e colorida para transformar cantinhos especiais.", img:"", olx:"COLE_AQUI_O_LINK_DA_OLX", tag:"Decor" }
];

const PLACEHOLDER = /COLE_AQUI/;

function sillyCatSvg(){
  return `<svg viewBox="0 0 240 250" aria-hidden="true"><use href="#sillycat"></use></svg>`;
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

function productCard(product, index){
  const hasImage = product.img && !PLACEHOLDER.test(product.img);
  const media = hasImage
    ? `<img src="${product.img}" alt="${product.nome}" loading="lazy" onerror="this.closest('.product-media').innerHTML='<div class=&quot;product-placeholder&quot;>${sillyCatSvg().replaceAll('"','&quot;')}</div><span class=&quot;product-badge&quot;>${product.tag || 'Silly'}</span>'">`
    : `<div class="product-placeholder">${sillyCatSvg()}</div>`;
  return `<article class="product-card reveal" style="--i:${index}">
    <div class="product-media" style="background:${['#e6edf8','#fffddc','#dbe5f5','#ffffff'][index%4]}">
      ${media}
      <span class="product-badge">${product.tag || 'Silly'}</span>
    </div>
    <div class="product-body">
      <h3 class="product-name">${product.nome}</h3>
      <p class="product-desc">${product.desc}</p>
      <p class="price">${product.preco}</p>
      <div class="product-actions">
        <button class="soft-btn" type="button" data-buy="${product.olx}">Comprar</button>
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
  document.querySelectorAll("[data-buy]").forEach(btn=>{
    btn.addEventListener("click",()=>openProduct(btn.dataset.buy));
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
