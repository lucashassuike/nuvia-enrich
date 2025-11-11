# Teste da Integração Snov.io

Este guia explica como configurar e testar a integração com a Snov.io, tanto via API quanto pela UI. Inclui exemplos de chamadas, CSV de teste e dicas de troubleshooting.

## Visão Geral
- Fontes na UI: Apollo (azul), Snov.io (roxo), Web (teal).
- Colunas dinâmicas: `Technologies` e `Prospects` aparecem quando presentes nos resultados.
- Tooltip de fontes mostra selo da origem (Apollo/Snov.io/Web) e citações quando disponíveis.
- API Snov: autenticação via OAuth Client Credentials, com cache de token e backoff contra rate limiting.

## 1) Configuração das variáveis de ambiente
Crie um arquivo `.env.local` na raiz do projeto com:

```
SNOV_CLIENT_ID=seu_client_id
SNOV_CLIENT_SECRET=seu_client_secret

# Recomendado para rodar a arquitetura de agentes
APOLLO_API_KEY=sua_chave_apollo
AZURE_OPENAI_API_KEY=sua_chave_azure
AZURE_OPENAI_ENDPOINT=https://seu-endpoint-azure.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=seu-deployment
AZURE_OPENAI_API_VERSION=2024-10-01-preview
```

Valide com:

```
curl http://localhost:3000/api/check-env
```

Resposta esperada (resumo):

```
{
  "environmentStatus": {
    "SNOV_CLIENT_ID": true,
    "SNOV_CLIENT_SECRET": true,
    "APOLLO_API_KEY": true,
    "AZURE_OPENAI_API_KEY": true,
    "AZURE_OPENAI_ENDPOINT": true,
    "AZURE_OPENAI_DEPLOYMENT": true,
    "AZURE_OPENAI_API_VERSION": true
  }
}
```

Alternativa: enviar via headers nas requisições (caso não use `.env.local`):
- `X-Snov-Client-Id: <client_id>`
- `X-Snov-Client-Secret: <client_secret>`

## 2) Teste via API (curl/Postman)
A rota principal é `POST /api/enrich` (streaming SSE). Exemplo com curl (Windows PowerShell):

```
$body = @{
  rows = @(@{ email = "contato@nuvia.ai"; domain = "nuvia.ai" })
  fields = @(
    @{ name = "company_domain"; displayName = "Company Domain"; type = "string" },
    @{ name = "technologies"; displayName = "Technologies"; type = "array" },
    @{ name = "prospects"; displayName = "Prospects"; type = "array" }
  )
  emailColumn = "email"
} | ConvertTo-Json

$headers = @{
  "Content-Type" = "application/json"
  "X-Apollo-API-Key" = "SUA_CHAVE_APOLLO"
  "X-Azure-API-Key" = "SUA_CHAVE_AZURE"
  "X-Snov-Client-Id" = "SEU_CLIENT_ID"
  "X-Snov-Client-Secret" = "SEU_CLIENT_SECRET"
}

Invoke-RestMethod -Method POST -Uri http://localhost:3000/api/enrich -Headers $headers -Body $body
```

Observação: a resposta é SSE (linhas iniciadas por `data:`). Exemplo de trechos:

```
data: {"type":"session","sessionId":"173..."}

data: {"type":"pending","rowIndex":0,"totalRows":1}

data: {"type":"processing","rowIndex":0}

data: {"type":"completed","rowIndex":0,
 "result":{
   "rowIndex":0,
   "status":"completed",
   "enrichments":{
     "company_domain":{ "value":"nuvia.ai", "confidence":0.95, "source":"apollo" },
     "technologies":{ "value":["React","Next.js","Tailwind"], "confidence":0.73, "source":"snov" },
     "prospects":{ "value":["Jane Doe - CTO","John Roe - Head of Sales"], "confidence":0.62, "source":"snov" }
   }
 }
}
```

## 3) Teste via UI
1. Inicie o servidor: `pnpm dev` ou `npm run dev`.
2. Acesse `http://localhost:3000/fire-enrich`.
3. Faça upload de um CSV de teste (veja seção abaixo).
4. Selecione os campos para enriquecer e execute.

### O que você deve ver
- Dashboard “Fontes dos dados” mostrando:
  - Apollo com barra azul.
  - Snov.io com barra roxa.
- Na tabela principal:
  - Colunas “Technologies” e “Prospects” surgem se houver dados.
  - Badge “Snov.io” roxo na célula quando a fonte for Snov.
  - Tooltip de fontes com selo da origem e, se disponível, citações/links.

## 4) Exemplos de responses (Snov.io)
Chamada interna (ferramenta de agente) retorna algo como:

```
{
  "has_data": true,
  "company": {
    "name": "Nuvia",
    "industry": "Software",
    "website": "https://nuvia.ai"
  },
  "emails_count": 42,
  "technologies": [
    { "name": "React", "category": "Frontend" },
    { "name": "Next.js" }
  ],
  "prospects": [
    { "first_name": "Jane", "last_name": "Doe", "position": "CTO", "email": "jane.doe@nuvia.ai" },
    { "first_name": "John", "last_name": "Roe", "position": "Head of Sales" }
  ]
}
```

Os valores acima são exemplos; os dados reais dependem do domínio consultado e das permissões da sua conta Snov.

## 5) CSV de Teste
Crie um arquivo `test.csv` com o conteúdo abaixo:

```
email,domain
contato@nuvia.ai,nuvia.ai
```

Na UI, selecione `email` como `Email column`. Os campos sugeridos incluem `company_domain`, e você pode adicionar `technologies` e `prospects` para confirmar que as colunas aparecem dinamicamente.

## 6) Troubleshooting
- `SNOV_CLIENT_ID/SNOV_CLIENT_SECRET` faltando
  - Verifique `http://localhost:3000/api/check-env` e o `.env.local`.
  - Se usar headers, confirme que estão sendo enviados.
- 429 (Rate limiting) da Snov
  - A integração possui backoff automático; tente novamente após alguns segundos.
- Token OAuth inválido
  - Verifique o Client ID/Secret e se sua conta possui acesso às APIs.
- Nenhum dado retornado (has_data: false)
  - Cheque se o domínio está correto (sem `http://` e sem `www.`), ex: `nuvia.ai`.
  - Alguns endpoints podem não ter dados para certos domínios.
- UI não mostra barras ou colunas
  - As colunas “Technologies/Prospects” só aparecem se houver dados nos resultados.
  - As barras de fonte incrementam com campos que possuem valor e fonte.
- Debug
  - Veja o console do servidor para mensagens de `Snov OAuth error`, `Snov API ... failed:` e `DiscoveryAgent`.
  - Use `GET /api/check-env` para confirmar as variáveis.

## 7) Postman
- Método: `POST`
- URL: `http://localhost:3000/api/enrich`
- Headers:
  - `Content-Type: application/json`
  - `X-Apollo-API-Key: ...`
  - `X-Azure-API-Key: ...`
  - `X-Snov-Client-Id: ...`
  - `X-Snov-Client-Secret: ...`
- Body (raw JSON):

```
{
  "rows": [{ "email": "contato@nuvia.ai", "domain": "nuvia.ai" }],
  "fields": [
    { "name": "company_domain", "displayName": "Company Domain", "type": "string" },
    { "name": "technologies", "displayName": "Technologies", "type": "array" },
    { "name": "prospects", "displayName": "Prospects", "type": "array" }
  ],
  "emailColumn": "email"
}
```

Se precisar de ajuda para configurar