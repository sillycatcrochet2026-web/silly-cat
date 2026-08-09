# Silly Cat — Patch v2.3: geração automática de etiqueta

Este patch parte da **v2.2**. Ele altera somente o Worker e adiciona uma tabela no D1. O frontend não precisa ser alterado.

## Fluxo novo

```text
InfinitePay confirma o pagamento
        ↓
estoque é baixado
        ↓
Melhor Envio: adiciona o envio ao carrinho
        ↓
compra o frete com o saldo da carteira Melhor Envio
        ↓
gera a etiqueta
        ↓
obtém o link de impressão
        ↓
e-mail da venda já inclui o status/link da etiqueta
```

A operação é retomável: se falhar por falta de saldo, geração ainda não pronta etc., o Worker preserva o estágio e pode tentar novamente sem recriar intencionalmente os envios já salvos.

## 1. Instalar o patch

Substitua:

```text
worker/src/index.js
```

pelo arquivo deste patch.

Crie a nova tabela:

```bash
cd worker
npx wrangler d1 execute silly-cat-orders --remote --file=./migrations/003_shipping_labels.sql
```

O próprio Worker também cria essa tabela se ela não existir, mas executar a migration deixa o banco explicitamente atualizado.

## 2. Adicionar as configurações ao `wrangler.jsonc`

Dentro de `vars`, acrescente:

```json
"MELHOR_ENVIO_AUTO_LABEL": "false",
"MELHOR_ENVIO_SHIPMENT_MODE": "non_commercial",
"MELHOR_ENVIO_LABEL_PRINT_MODE": "private"
```

Comece com `MELHOR_ENVIO_AUTO_LABEL=false`. Assim você testa a primeira etiqueta manualmente sem habilitar cobranças automáticas para novas vendas.

`private` gera um link de impressão que exige login no Melhor Envio. Se quiser que o link do e-mail abra sem login, use `public`, sabendo que qualquer pessoa que possua o link poderá acessar a etiqueta.

### Importante sobre `MELHOR_ENVIO_SHIPMENT_MODE`

Esta versão automatiza apenas o fluxo **não comercial / Declaração de Conteúdo**. Use:

```json
"MELHOR_ENVIO_SHIPMENT_MODE": "non_commercial"
```

**somente se esse enquadramento for correto para os seus envios.** Para envio comercial, o Melhor Envio exige dados fiscais/NF-e por pedido; nesse caso não ative a automação desta versão antes de implementarmos esse fluxo.

## 3. Configurar o remetente como Secret

Os dados do remetente não devem ir para o GitHub. Salve tudo em um único Secret:

```bash
npx wrangler secret put MELHOR_ENVIO_SENDER_JSON
```

Quando o Wrangler pedir o valor, cole em uma única linha:

```json
{"name":"SEU NOME","email":"SEU EMAIL","phone":"11999999999","document":"SEU CPF","address":"SUA RUA","complement":"","number":"123","district":"SEU BAIRRO","city":"SUA CIDADE","postal_code":"12345678","state_abbr":"SP"}
```

O `postal_code` precisa ser o mesmo configurado em `MELHOR_ENVIO_FROM_POSTAL_CODE`, para que a cotação cobrada do cliente e a etiqueta usem a mesma origem.

## 4. Criar uma chave administrativa

Ela permite consultar/repetir a geração manual de uma etiqueta sem expor essa função publicamente:

```bash
npx wrangler secret put ADMIN_API_KEY
```

Use uma senha longa e aleatória. Ela nunca deve entrar no frontend ou no GitHub.

## 5. Deploy

```bash
npx wrangler deploy
```

Depois abra:

```text
https://SEU-WORKER.workers.dev/health
```

Você deverá ver, entre outros campos:

```json
{
  "melhor_envio_auto_label": false,
  "melhor_envio_sender_configured": true,
  "melhor_envio_label_print_mode": "private"
}
```

## 6. Testar usando uma venda já paga

Você pode usar o pedido de teste que já foi pago. Como ele foi criado antes da v2.3, a etiqueta **não será comprada automaticamente**; isso é intencional para não cobrar fretes históricos.

No PowerShell:

```powershell
$headers = @{
  "X-Admin-Key" = "SUA_ADMIN_API_KEY"
}

Invoke-RestMethod `
  -Method Post `
  -Uri "https://SEU-WORKER.workers.dev/api/admin/orders/SEU_ORDER_NSU/label" `
  -Headers $headers
```

**Atenção:** esse POST compra o frete com o saldo da sua carteira do Melhor Envio. Garanta que há saldo suficiente.

Se der certo, a resposta terá algo como:

```json
{
  "status": "ready",
  "shipment_ids": ["..."],
  "print_urls": ["https://..."]
}
```

Para apenas consultar o estado sem executar uma nova tentativa:

```powershell
Invoke-RestMethod `
  -Method Get `
  -Uri "https://SEU-WORKER.workers.dev/api/admin/orders/SEU_ORDER_NSU/label" `
  -Headers $headers
```

## 7. Ativar para vendas novas

Depois que a etiqueta manual funcionar, altere:

```json
"MELHOR_ENVIO_AUTO_LABEL": "true"
```

E publique novamente:

```bash
npx wrangler deploy
```

A partir daí, pedidos **criados depois desta v2.3** são marcados como elegíveis para automação. Assim que o pagamento for confirmado, o Worker tenta comprar, gerar e obter o link da etiqueta.

Pedidos antigos nunca são cobrados automaticamente; eles continuam disponíveis pelo endpoint administrativo.

## 8. Falhas e retomada

Os estados ficam em `shipping_labels`, por exemplo:

```text
waiting_payment
cart_created
purchased
generated
ready
error
```

Se faltar saldo no Melhor Envio, o pedido continua pago e o estoque continua baixado; apenas a etiqueta fica com erro. Depois de corrigir o problema, execute novamente o POST administrativo. O Worker reutiliza os IDs já persistidos sempre que possível.

O e-mail de nova venda passa a informar também se a etiqueta ficou pronta ou se ocorreu erro na automação.
