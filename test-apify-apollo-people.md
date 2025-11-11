# Guia de Teste: Apify (LinkedIn) e Apollo People

Este guia ensina como configurar, testar pela UI e depurar os campos `key_executives`, `linkedin_recent_posts` e `company_activity`.

## 1. Instruções de Configuração

- `APIFY_API_TOKEN` (opcional, recomendado):
  - Abra `.env.local` na raiz do projeto.
  - Adicione: `APIFY_API_TOKEN=SEU_TOKEN_AQUI`
  - Reinicie o dev server (`pnpm dev`). Sem esse token, os posts do LinkedIn serão ignorados.

- `APOLLO_API_KEY` (opcional, recomendado para executivos):
  - No `.env.local`, adicione: `APOLLO_API_KEY=SEU_TOKEN_APOLLO`
  - Reinicie o dev server.
  - Alternativamente, salve no navegador: `localStorage.setItem('apollo_api_key', 'SEU_TOKEN_APOLLO')`.

- Modo limitado (sem chaves):
  - O enriquecimento funciona com Azure OpenAI apenas (já configurado). Executivos e posts podem não aparecer.

## 2. Teste Passo a Passo na UI

1) Faça upload de um CSV simples (coluna `email` obrigatória). Exemplo:
```
email,company_domain
tester@openai.com,openai.com
test@microsoft.com,microsoft.com
```

2) Preencha extras na UI:
- `LinkedIn URL (empresa)`: ex. `https://www.linkedin.com/company/microsoft/`
- `Company Domain`: ex. `microsoft.com`

3) Selecione campos de enriquecimento:
- `Executivos (key_executives)`
- `Posts LinkedIn (linkedin_recent_posts)`
- `Atividade (company_activity)`

4) Clique em “Start Enrichment” e observe o painel de agentes (mensagens de progresso em tempo real).

## 3. Campos Novos e Expectativas

- `key_executives`:
  - Deve listar nomes/títulos (CEO, CTO, etc.) se `APOLLO_API_KEY` estiver válido.

- `linkedin_recent_posts`:
  - Requer `APIFY_API_TOKEN`. Mostra itens com `url`, `text`, `publishedAt`, `likes`, `comments`, `reshares`, `engagement_total`.

- `company_activity`:
  - Agrega sinal de atividade a partir de posts (contagem e engajamento) quando disponível.

## 4. Exemplos de URLs e Domínios

- LinkedIn válido:
  - `https://www.linkedin.com/company/microsoft/`
  - `https://www.linkedin.com/company/google/`
  - `https://www.linkedin.com/company/nvidia/`

- Domínios recomendados:
  - `microsoft.com`, `openai.com`, `nvidia.com`, `stripe.com`

## 5. Troubleshooting

- Executivos não aparecem:
  - Verifique `APOLLO_API_KEY` em `.env.local` ou no `localStorage`.
  - Cheque a Network do navegador para chamadas a Apollo (pode haver 401/403).
  - Tente fornecer `company_domain` e `name` (se disponível no CSV).

- Posts do LinkedIn vazios:
  - Confirme `APIFY_API_TOKEN`.
  - Verifique se `linkedin_url` foi preenchido.
  - Alguns perfis têm pouca atividade ou bloqueios; teste outro URL.

- Erro “Failed to start enrichment”:
  - Atualizamos o backend para não exigir Apollo; se persistir, confira Azure vars via `GET /api/check-env`.
  - Garanta que o payload tem `rows`, `fields` (1–10), `emailColumn`.

- Validar configuração:
  - `GET /api/check-env` deve mostrar Azure `true`. `APOLLO_API_KEY`/`APIFY_API_TOKEN` podem estar `false` e ainda assim o enriquecimento começar.

## 6. Referência de APIs (interno)

- Apify Actor:
```
POST https://api.apify.com/v2/acts/supreme_coder~linkedin-post/run-sync-get-dataset-items?token=APIFY_TOKEN
{
  "urls": ["LINKEDIN_COMPANY_URL"],
  "limitPerSource": 10,
  "deepScrape": true,
  "rawData": false
}
```

- Apollo People (normalização interna):
```
{
  "executives": [
    { "name": "Jane Doe", "title": "CEO", "department": "Executive", "linkedin_url": "https://www.linkedin.com/in/janedoe" }
  ],
  "sourceCount": 1
}
```

Anote resultados, latência e quaisquer mensagens no painel de agentes para cada caso de teste.