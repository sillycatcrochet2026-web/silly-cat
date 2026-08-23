(() => {
  "use strict";
  const root = document.getElementById("reviewAccess");
  const token = new URLSearchParams(location.search).get("token") || "";
  const apiBase = () => String(window.SILLY_CAT_ECOMMERCE?.apiBaseUrl || "").replace(/\/$/, "");
  const apiUrl = (path) => `${apiBase()}${path}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));

  async function request(path, options = {}) {
    const response = await fetch(apiUrl(path), { cache: "no-store", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível acessar esta avaliação.");
    return data;
  }

  function stars(productId, disabled = false) {
    return `<div class="review-stars" role="radiogroup" aria-label="Nota de 1 a 5 estrelas">
      ${[1,2,3,4,5].map((rating) => `<button type="button" class="review-star" data-rating="${rating}" data-for="${escapeHtml(productId)}" aria-label="${rating} estrela${rating > 1 ? "s" : ""}" aria-pressed="false" ${disabled ? "disabled" : ""}>★</button>`).join("")}
    </div><input type="hidden" name="rating" value="">`;
  }

  function render(data) {
    const salutation = data.buyer_first_name ? `, ${escapeHtml(data.buyer_first_name)}` : "";
    const items = Array.isArray(data.items) ? data.items : [];
    root.innerHTML = `<div class="review-welcome"><h2>Olá${salutation}!</h2><p>Avalie somente os produtos que desejar. Cada produto deste link aceita uma avaliação.</p></div>
      <div class="review-product-list">${items.map((item) => item.reviewed ? completedCard(item) : formCard(item)).join("")}</div>`;
    root.querySelectorAll(".review-star").forEach((button) => button.addEventListener("click", selectRating));
    root.querySelectorAll(".review-product-form").forEach((form) => form.addEventListener("submit", submitReview));
  }

  function productHeading(item) {
    return `<div class="review-product-head">${item.image ? `<img src="${escapeHtml(item.image)}" alt="">` : `<div class="review-product-placeholder">🧶</div>`}<div><h3>${escapeHtml(item.product_name)}</h3>${item.variant_name ? `<p>Variação: <b>${escapeHtml(item.variant_name)}</b></p>` : ""}</div></div>`;
  }

  function completedCard(item) {
    return `<article class="review-product-card completed">${productHeading(item)}<div class="review-completed">✓ Avaliação registrada. Obrigada!</div></article>`;
  }

  function formCard(item) {
    return `<article class="review-product-card">${productHeading(item)}<form class="review-product-form" data-product="${escapeHtml(item.product_id)}" data-variant="${escapeHtml(item.variant_id || "")}">
      <label>Sua nota</label>${stars(`${item.product_id}::${item.variant_id || ""}`)}
      <label>Comentário<textarea name="comment" rows="4" maxlength="1500" minlength="3" placeholder="Conte o que você achou da peça…" required></textarea></label>
      <button class="soft-btn" type="submit">Enviar avaliação</button>
      <p class="review-form-message" aria-live="polite"></p>
    </form></article>`;
  }

  function selectRating(event) {
    const button = event.currentTarget;
    const group = button.closest(".review-stars");
    const value = Number(button.dataset.rating);
    group.querySelectorAll(".review-star").forEach((star) => {
      const selected = Number(star.dataset.rating) <= value;
      star.classList.toggle("selected", selected);
      star.setAttribute("aria-pressed", String(Number(star.dataset.rating) === value));
    });
    group.nextElementSibling.value = String(value);
  }

  async function submitReview(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = form.querySelector(".review-form-message");
    const button = form.querySelector("button[type=submit]");
    const rating = Number(form.elements.rating.value);
    if (!rating) { message.textContent = "Escolha de 1 a 5 estrelas."; message.className = "review-form-message error"; return; }
    button.disabled = true; button.textContent = "Enviando…"; message.textContent = "";
    try {
      await request("/api/reviews", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, product_id: form.dataset.product, variant_id: form.dataset.variant || undefined, rating, comment: form.elements.comment.value.trim() }),
      });
      const card = form.closest(".review-product-card");
      form.remove();
      card.classList.add("completed");
      card.insertAdjacentHTML("beforeend", `<div class="review-completed">✓ Avaliação registrada. Obrigada!</div>`);
    } catch (error) {
      message.textContent = error.message; message.className = "review-form-message error";
      button.disabled = false; button.textContent = "Enviar avaliação";
    }
  }

  async function init() {
    document.getElementById("year").textContent = new Date().getFullYear();
    if (!token) { root.innerHTML = `<div class="review-invalid"><h2>Link de avaliação ausente</h2><p>Abra o link completo que você recebeu da Silly Cat.</p></div>`; return; }
    try { render(await request(`/api/reviews/access?token=${encodeURIComponent(token)}`)); }
    catch (error) { root.innerHTML = `<div class="review-invalid"><h2>Não foi possível abrir este link</h2><p>${escapeHtml(error.message)}</p><a class="soft-btn" href="produtos.html">Voltar à loja</a></div>`; }
  }
  init();
})();
