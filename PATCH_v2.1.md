# Aplicar correções v2.1 sobre a instalação atual

1. Substitua no seu projeto pelos arquivos desta versão:
   - `app.js`
   - `styles.css`
   - `worker/src/index.js`
   - `worker/schema.sql`
2. Preserve o seu `worker/wrangler.jsonc`, `ecommerce-config.js` e secrets já configurados.
3. Na pasta `worker/`, rode:

```bash
npx wrangler d1 execute silly-cat-orders --remote --file=./schema.sql
npx wrangler deploy
```

4. Faça commit/push de `app.js` e `styles.css` no GitHub Pages.
5. Abra `https://SEU-WORKER.workers.dev/api/catalog` e confira o produto vendido.

A venda de teste que já estava com status `paid` antes desta atualização é reconciliada automaticamente e deve aparecer com `estoque: 0`.
