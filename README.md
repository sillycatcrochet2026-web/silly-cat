# Silly Cat Crochê — e-commerce com Cloudflare Workers + D1

Esta versão mantém o site no **GitHub Pages** e move a API para **Cloudflare Workers**, com pedidos persistidos no **D1**.

Fluxo atual:

```text
GitHub Pages
   ↓
Carrinho
   ↓
Melhor Envio (frete)
   ↓
D1 salva o pedido como pending
   ↓
InfinitePay
   ↓
Webhook + payment_check
   ↓
D1 marca como paid
   ↓
E-mail SMTP de nova venda
   ↓
pedido.html mostra a confirmação
```

A geração de etiquetas de envio já está integrada ao Worker. Pedidos com produção pendente aguardam a conclusão no Admin antes de gerar a etiqueta.

## Versão v3.0 — categorias e etiquetas

- um produto pode pertencer a várias categorias;
- etiquetas são criadas e gerenciadas no mesmo painel das categorias;
- qualquer etiqueta pode ser marcada como **Principal**, exibindo seus produtos na página inicial;
- **Esgotado** bloqueia compra e encomenda no frontend e no Worker;
- **Sob encomenda** permite pedir além do estoque e ativa o prazo de produção;
- as regras críticas continuam sendo validadas pelo Worker.

Antes de publicar o frontend v3.0, aplique no D1 e publique o Worker atualizado:

```bash
npx wrangler d1 execute silly-cat-orders --remote --file=./migrations/010_product_taxonomy.sql
npx wrangler deploy
```

---

## 1. O que você precisa ter

- Node.js 18+;
- conta gratuita na Cloudflare;
- token do Melhor Envio de **produção**;
- sua InfiniteTag da InfinitePay;
- seu e-mail SMTP já usado em testes.

O envio de e-mail **não usa Resend**. O Worker envia diretamente pelo seu servidor SMTP. Não é `smtplib` porque o Worker roda JavaScript, mas usa a mesma conta SMTP e a mesma senha de app que você já usa no Python.

Para Gmail, normalmente:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURITY=implicit
```

Se seu provedor usa porta 587, use:

```text
SMTP_PORT=587
SMTP_SECURITY=starttls
```

Não use porta 25.

---

## 2. Configurar o Worker

Abra um terminal dentro da pasta:

```bash
cd worker
npm install
npx wrangler login
```

Crie o banco:

```bash
npx wrangler d1 create silly-cat-orders
```

Copie o `database_id` retornado e substitua o UUID zerado em:

```text
worker/wrangler.jsonc
```

Depois edite nesse mesmo arquivo:

```text
INFINITEPAY_HANDLE
MELHOR_ENVIO_FROM_POSTAL_CODE
MELHOR_ENVIO_USER_AGENT
SMTP_HOST
SMTP_PORT
SMTP_SECURITY
SMTP_USER
SMTP_FROM
SALE_NOTIFICATION_TO
```

Exemplo de InfiniteTag:

```text
$viniciusfr  →  viniciusfr
```

Exemplo de User-Agent do Melhor Envio:

```text
Silly Cat Croche (seu-email@exemplo.com)
```

---

## 3. Criar as tabelas no D1

Ainda dentro de `worker/`:

```bash
npx wrangler d1 execute silly-cat-orders --remote --file=./schema.sql
```

Isso cria:

- `orders`;
- `order_items`.

O pedido guarda cliente, CPF, endereço, produtos, frete escolhido, total, status do pagamento e os campos que serão usados futuramente para a etiqueta.

---

## 4. Fazer o primeiro deploy

```bash
npx wrangler deploy
```

A Cloudflare retornará uma URL parecida com:

```text
https://silly-cat-api.SEUSUBDOMINIO.workers.dev
```

Guarde essa URL.

Não é necessário mudar o domínio da GoDaddy nem mover o GitHub Pages para a Cloudflare nesta etapa.

---

## 5. Configurar os segredos

Ainda em `worker/`:

```bash
npx wrangler secret put MELHOR_ENVIO_TOKEN
```

Cole o token de produção do Melhor Envio.

Depois:

```bash
npx wrangler secret put SMTP_PASSWORD
```

Cole a senha SMTP/senha de app do e-mail.

Esses valores ficam na Cloudflare e **não entram no GitHub**.

Para Gmail, use a senha de app, não a senha normal da conta.

---

## 6. Apontar o site para o Worker

Abra:

```text
ecommerce-config.js
```

Troque:

```javascript
"https://COLE-AQUI-SEU-WORKER.workers.dev"
```

pela URL retornada no deploy.

Depois faça commit/push normalmente no repositório do site.

Essa troca é feita uma única vez. Os links dos produtos deixam de depender do Mercado Livre.

---

## 7. Verificar se a API está pronta

Abra:

```text
https://SEU-WORKER.workers.dev/health
```

O esperado é algo semelhante a:

```json
{
  "ok": true,
  "database": true,
  "melhor_envio_env": "production",
  "infinitepay_configured": true,
  "melhor_envio_configured": true,
  "smtp_configured": true
}
```

---

## 8. Teste de venda

No site publicado:

1. adicione um produto ao carrinho;
2. calcule o frete;
3. escolha a transportadora;
4. preencha nome, e-mail, telefone, CPF e endereço;
5. abra o checkout InfinitePay;
6. finalize uma venda real de teste.

Antes de abrir a InfinitePay, o pedido já será salvo no D1 como:

```text
pending
```

Quando a InfinitePay chamar o webhook, o Worker valida:

```text
order_nsu existe
+
valor recebido = total do pedido
+
payment_check confirma paid=true
```

Somente depois o pedido passa para:

```text
paid
```

O webhook é configurado automaticamente pelo Worker. Não é necessário cadastrar a URL manualmente na InfinitePay.

O comprador é redirecionado para:

```text
https://www.sillycatcroche.shop/pedido.html
```

A página consulta a API e mostra a confirmação do pagamento.

---

## 9. E-mail de nova venda

Quando o pedido vira `paid`, o Worker envia para `SALE_NOTIFICATION_TO` um e-mail contendo:

- número do pedido;
- produtos;
- total;
- forma de pagamento;
- transportadora e serviço;
- prazo estimado;
- nome;
- CPF;
- telefone;
- e-mail;
- endereço completo;
- link do comprovante, quando disponível.

O disparo é feito diretamente por SMTP usando a conta configurada em `wrangler.jsonc` + `SMTP_PASSWORD` salvo como secret.

---

## 10. Consultar pedidos no D1

Exemplo:

```bash
npx wrangler d1 execute silly-cat-orders --remote --command="SELECT order_nsu,status,total_cents,created_at FROM orders ORDER BY created_at DESC LIMIT 10"
```

Para ver um pedido específico:

```bash
npx wrangler d1 execute silly-cat-orders --remote --command="SELECT * FROM orders WHERE order_nsu='SC-...'"
```

---

## 11. Teste local opcional

Copie:

```text
worker/.dev.vars.example
```

para:

```text
worker/.dev.vars
```

Preencha pelo menos:

```text
MELHOR_ENVIO_TOKEN
SMTP_PASSWORD
```

Crie o banco local:

```bash
cd worker
npx wrangler d1 execute silly-cat-orders --local --file=./schema.sql
```

Depois execute `iniciar-local.bat` na raiz.

Frontend:

```text
http://127.0.0.1:8000
```

Worker local:

```text
http://127.0.0.1:8787
```

---

## 12. Próxima etapa: etiqueta automática

O banco já guarda os campos necessários para implementar:

```text
pedido pago
   ↓
Melhor Envio /me/cart
   ↓
comprar frete
   ↓
gerar etiqueta
   ↓
salvar ID da etiqueta no pedido
```

Os campos `melhor_envio_shipment_id` e `label_status` já existem no D1 para essa próxima implementação.

---

## Segurança

Nunca coloque no frontend ou no GitHub:

- `MELHOR_ENVIO_TOKEN`;
- `SMTP_PASSWORD`;
- senhas de e-mail.

O Worker também não confia no preço enviado pelo navegador: ele relê `catalogo.json`, recalcula o frete no Melhor Envio e só então cria o checkout InfinitePay.
