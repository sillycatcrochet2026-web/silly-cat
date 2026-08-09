# Silly Cat — Patch v2.2: limitar frete a Correios e Jadlog

Este patch altera somente o Worker. Não há migração do D1 e não é necessário alterar o frontend.

## O que muda

- As cotações do Melhor Envio continuam sendo consultadas normalmente.
- O Worker descarta no backend qualquer opção cuja transportadora não seja permitida.
- Por padrão, apenas **Correios** e **Jadlog** são aceitos.
- A mesma regra vale no `/api/checkout`, porque o frete é recalculado no servidor antes de criar o pagamento. Assim, não é possível forçar outra transportadora pelo navegador.

## Instalação

1. Substitua no seu projeto atual:

```text
worker/src/index.js
```

pelo arquivo deste patch.

2. Opcionalmente, dentro de `vars` no seu `worker/wrangler.jsonc`, adicione:

```json
"MELHOR_ENVIO_ALLOWED_CARRIERS": "Correios,Jadlog",
```

Se não adicionar essa variável, **Correios,Jadlog já são usados como padrão**.

O seu `MELHOR_ENVIO_SERVICES` pode continuar vazio:

```json
"MELHOR_ENVIO_SERVICES": ""
```

3. Publique o Worker:

```bash
cd worker
npx wrangler deploy
```

Não é necessário executar `schema.sql` novamente.

## Teste

Abra:

```text
https://SEU-WORKER.workers.dev/health
```

A resposta deve conter algo como:

```json
"melhor_envio_allowed_carriers": ["Correios", "Jadlog"]
```

Depois calcule o frete no site. Serviços de Loggi, J&T, LATAM Cargo, Azul etc. não devem mais aparecer.

## Alterar no futuro

Exemplo: apenas Correios:

```json
"MELHOR_ENVIO_ALLOWED_CARRIERS": "Correios"
```

Exemplo: Correios, Jadlog e Loggi:

```json
"MELHOR_ENVIO_ALLOWED_CARRIERS": "Correios,Jadlog,Loggi"
```

Para remover temporariamente o filtro:

```json
"MELHOR_ENVIO_ALLOWED_CARRIERS": "*"
```

Depois de qualquer alteração no `wrangler.jsonc`, execute novamente:

```bash
npx wrangler deploy
```
