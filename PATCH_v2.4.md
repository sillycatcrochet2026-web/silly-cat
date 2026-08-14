# Silly Cat v2.4 — Painel privado de inventário

Esta versão move o **catálogo mestre para o D1** e adiciona `admin.html` para gerenciar produtos sem editar `catalogo.json` ou fazer commit a cada alteração.

## O que muda

- `admin.html`: login privado e painel de produtos.
- Criar e editar produtos, preço, descrição, tag NOVO, ordem de exibição e medidas/peso.
- Ajustar estoque rapidamente; vendas continuam baixando o estoque automaticamente.
- Arquivar/restaurar produtos sem apagar o histórico de pedidos.
- Histórico de ajustes manuais e baixas por venda.
- Exportação do catálogo em JSON para backup.
- Sessão administrativa temporária de 12 horas. A `ADMIN_API_KEY` não fica salva no site.
- Upload de imagens por Cloudflare R2 (opcional). Sem R2, caminhos `img/...` e URLs HTTPS continuam funcionando.
- O storefront passa a usar somente `/api/catalog`, evitando mostrar um catálogo estático desatualizado.

## Arquivos do patch

Substitua:

- `app.js`
- `worker/src/index.js`

Adicione:

- `admin.html`
- `admin.css`
- `admin.js`
- `worker/migrations/004_admin_catalog.sql`

Não substitua seu `wrangler.jsonc` já configurado.

---

## 1. Banco D1

Dentro de `worker/`:

```powershell
npx wrangler d1 execute silly-cat-orders --remote --file=./migrations/004_admin_catalog.sql
```

A migração preserva pedidos, estoque e etiquetas existentes.

## 2. Chave administrativa

A v2.3 já usava `ADMIN_API_KEY` para os endpoints de etiqueta. Se você já criou esse secret, não faça nada.

Caso ainda não exista:

```powershell
npx wrangler secret put ADMIN_API_KEY
```

Use uma chave longa e aleatória. Ela **nunca** deve entrar em `admin.js`, `ecommerce-config.js`, GitHub ou `wrangler.jsonc`.

O painel envia a chave uma única vez ao Worker. O Worker cria uma sessão temporária e o navegador guarda apenas esse token durante a aba/sessão.

## 3. Upload direto de imagens (recomendado, opcional)

Para cadastrar imagens sem fazer commit no GitHub, crie um bucket R2:

```powershell
npx wrangler r2 bucket create silly-cat-product-images
```

Depois adicione **no nível principal** do seu `worker/wrangler.jsonc`, ao lado de `d1_databases`:

```json
"r2_buckets": [
  {
    "binding": "PRODUCT_IMAGES",
    "bucket_name": "silly-cat-product-images"
  }
]
```

Exemplo de estrutura:

```json
{
  "name": "silly-cat-api",
  "main": "src/index.js",
  "vars": { ... },
  "d1_databases": [ ... ],
  "r2_buckets": [
    {
      "binding": "PRODUCT_IMAGES",
      "bucket_name": "silly-cat-product-images"
    }
  ]
}
```

O bucket pode continuar privado: as imagens são servidas pelo próprio Worker em `/api/product-images/...`.

Se não quiser configurar R2 agora, pule esta etapa. O painel ainda permite informar `img/arquivo.jpeg` ou uma URL `https://...`.

## 4. Deploy do Worker

```powershell
npx wrangler deploy
```

Confira:

```text
https://SEU-WORKER.workers.dev/health
```

Você deve ver:

```json
"admin_configured": true
```

E, se configurou o R2:

```json
"product_images_configured": true
```

## 5. Primeiro carregamento / migração do catálogo atual

Após o deploy, abra uma vez:

```text
https://SEU-WORKER.workers.dev/api/catalog
```

Na primeira execução da v2.4, se a tabela de produtos ainda estiver vazia, o Worker importa automaticamente o `catalogo.json` que está publicado atualmente na Silly Cat.

**Importante:** o estoque vivo já existente no D1 é preservado. Uma peça que já foi baixada por uma venda não volta ao estoque durante a importação.

Depois dessa importação, o D1 passa a ser a fonte principal do catálogo. Alterações futuras devem ser feitas pelo painel.

## 6. Publicar o frontend

Faça commit/push destes arquivos:

```powershell
git add app.js admin.html admin.css admin.js
git commit -m "Adiciona painel privado de inventario"
git push
```

Depois abra:

```text
https://www.sillycatcroche.shop/admin.html
```

A página não é vinculada ao menu público e possui `noindex`, mas a segurança real está no Worker: nenhum dado administrativo pode ser lido ou alterado sem autenticação.

Use como senha a mesma `ADMIN_API_KEY` configurada como secret no Worker.

---

## Uso diário

A partir da v2.4, para atividades normais você não precisa mais editar `catalogo.json`, rodar `wrangler deploy` ou fazer commit para:

- alterar estoque;
- alterar preço;
- alterar dimensões/peso;
- editar nome/descrição;
- marcar como NOVO;
- arquivar/restaurar;
- cadastrar produtos.

Com R2 configurado, também não precisa de commit para novas imagens.

O botão **Exportar JSON** gera um backup no formato antigo do `catalogo.json`.

## Arquivamento em vez de exclusão

O painel usa **Arquivar produto**, não exclusão definitiva. Isso remove a peça da loja mas preserva referências históricas dos pedidos antigos. Produtos arquivados podem ser restaurados.

## `catalogo.json` depois da v2.4

Ele fica apenas como:

1. fonte para a importação inicial; e
2. backup legado.

O site público não usa mais o arquivo como fallback, porque isso poderia mostrar um estoque antigo se a API estivesse indisponível.
