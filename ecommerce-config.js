(function(){
  const localHosts = new Set(["localhost", "127.0.0.1"]);
  const isLocal = localHosts.has(window.location.hostname);

  window.SILLY_CAT_ECOMMERCE = {
    // Desenvolvimento: frontend em :8000 e Cloudflare Worker local em :8787.
    // Produção: após o primeiro `wrangler deploy`, troque a URL abaixo pela URL *.workers.dev retornada.
    apiBaseUrl: isLocal
      ? "http://127.0.0.1:8787"
      : "https://silly-cat-api.sillycatmanager.workers.dev"
  };
})();
