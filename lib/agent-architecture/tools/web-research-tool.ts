import { z } from 'zod';
import { OpenAIService } from '../../services/openai';

// In-memory cache with 7-day TTL per company
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const researchCache = new Map<string, { ts: number; data: any }>();

type NewsItem = { title: string; url: string; publishedAt?: string };

function normalizeKey(name: string, domain: string, country: string, industry: string) {
  return [name.trim().toLowerCase(), domain.trim().toLowerCase(), country.trim().toLowerCase(), industry.trim().toLowerCase()].join('|');
}

async function fetchGoogleNewsRSS(query: string, { hl = 'pt-BR', gl = 'BR', ceid = 'BR:pt-419', limit = 10 }: { hl?: string; gl?: string; ceid?: string; limit?: number }): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  try {
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) return [];
    const xml = await resp.text();
    // Minimal RSS parsing for items
    const items: NewsItem[] = [];
    const itemRegex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?(?:<pubDate>([\s\S]*?)<\/pubDate>)?[\s\S]*?<\/item>/g;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) && items.length < limit) {
      const title = match[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const link = match[2]?.trim();
      const pubDate = match[3]?.trim();
      if (title && link) items.push({ title, url: link, publishedAt: pubDate });
    }
    return items;
  } catch {
    return [];
  }
}

// Additional BR-specific sources fetchers (simple HTML parsing)
async function fetchFromSourceList(urls: string[], limit = 10): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { method: 'GET' });
      if (!resp.ok) continue;
      const html = await resp.text();
      // naive link extraction
      const linkRegex = /<a[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = linkRegex.exec(html)) && items.length < limit) {
        const link = m[1];
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        if (title && link) items.push({ title, url: link });
      }
    } catch {}
  }
  return items;
}

function daysAgo(dateStr?: string): number {
  if (!dateStr) return 9999;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 9999;
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function classifyCategory(title: string): 'organizacional' | 'mercado' | 'performance' {
  const t = title.toLowerCase();
  if (/(funding|investimento|rodada|series a|series b|ipo|contrataç|vagas|novo vp|diretor|lançamento|feature|expansão|novo escritório|nova sede)/.test(t)) return 'organizacional';
  if (/(regulat|bcb|anvisa|diário oficial|concorrent|fusões|aquisições|parceria|evento|conferência|sympla|eventbrite)/.test(t)) return 'mercado';
  if (/(case|depoimento|press release|blog|whitepaper|redesign|branding|g2|glassdoor|reclame aqui)/.test(t)) return 'performance';
  return 'mercado';
}

function baseWeight(title: string): string {
  const t = title.toLowerCase();
  if (/(funding|investimento|rodada|series a|series b|ipo|mudança regulat)/.test(t)) return '5';
  if (/(contrataç|vagas|lançamento|feature|concorrente|m&a|parceria)/.test(t)) return '4';
  if (/(evento|expansão|novo escritório|nova sede|reviews|glassdoor|reclame aqui)/.test(t)) return '3';
  return '2';
}

function momentumScore(signals: Array<{ category: string; weight: string; date?: string }>): 'high' | 'medium' | 'low' {
  // Simple heuristic combining count, weight, and recency
  let score = 0;
  for (const s of signals) {
    const w = Number(s.weight || '1');
    const rec = daysAgo(s.date);
    score += w;
    if (rec <= 30) score += 2;
  }
  if (score >= 20) return 'high';
  if (score >= 10) return 'medium';
  return 'low';
}

function analyzeSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const t = (text || '').toLowerCase();
  const positives = /(recorde|crescimento|contrataç|funding|investimento|parceria|melhoria|lançamento|expansão|aquisição|premiado|contrato|ganhou|aumento)/;
  const negatives = /(demiss|queda|processo|crise|falha|vazamento|recall|investiga|fraude|problema|atraso|multado|perda|redução|encerramento|fechamento|reclame aqui|reviews negativos)/;
  if (negatives.test(t)) return 'negative';
  if (positives.test(t)) return 'positive';
  return 'neutral';
}

function detectPatterns(signals: Array<{ title?: string; category?: string; date?: string }>): string[] {
  const hasFunding = signals.some(s => /funding|investimento|rodada|series a|series b|ipo/.test(String(s.title || '').toLowerCase()));
  const hasHiring = signals.some(s => /contrataç|vagas|hiring/.test(String(s.title || '').toLowerCase()));
  const hasExpansion = signals.some(s => /expansão|novo escritório|nova sede|mercado/.test(String(s.title || '').toLowerCase()));
  const hasPartnership = signals.some(s => /parceria|aliança|joint venture/.test(String(s.title || '').toLowerCase()));
  const patterns: string[] = [];
  if (hasFunding && hasHiring && hasExpansion) {
    patterns.push('Momentum estratégico: funding + contratações + expansão em janela recente.');
  } else if (hasFunding && hasHiring) {
    patterns.push('Crescimento acelerado: funding acompanhado de abertura de vagas.');
  } else if (hasFunding && hasExpansion) {
    patterns.push('Escala: funding seguido por expansão geográfica/estrutura.');
  } else if (hasExpansion && hasPartnership) {
    patterns.push('Go-to-market: expansão apoiada por parceria estratégica.');
  }
  return patterns;
}

const Signal = z.object({
  signal_id: z.string(),
  signal_name: z.string(),
  category: z.enum(['organizacional', 'pessoal', 'mercado', 'performance']),
  weight: z.string(),
  date: z.string(),
  title: z.string(),
  description: z.string(),
  source_url: z.string().url(),
  confidence: z.enum(['high', 'medium', 'low']),
  recommended_action: z.string(),
  copy_angle: z.string(),
});

const CompanyAnalysis = z.object({
  company_name: z.string(),
  search_date: z.string(),
  data_freshness: z.string(),
  overall_signal_strength: z.enum(['high', 'medium', 'low']),
  priority_signals: z.array(Signal),
  total_signals_found: z.number(),
  signals_by_category: z.object({
    organizacional: z.number(),
    mercado: z.number(),
    performance: z.number(),
  }),
  key_insights: z.string(),
  personalization_hooks: z.array(z.string()),
  sector_trends: z.array(z.string()).optional(),
});

const WebResearchInput = z.object({
  company_name: z.string(),
  company_domain: z.string(),
  company_industry: z.string(),
  company_country: z.string(),
  company_competitors: z.array(z.string()).optional(),
});

export function createWebResearchTool(openai: OpenAIService) {
  return {
    name: 'web_research',
    description: 'Perform web research to find signals for a company',
    parameters: WebResearchInput,
    outputType: CompanyAnalysis,
    execute: async (input: z.infer<typeof WebResearchInput>) => {
      // Cache check
      const cacheKey = normalizeKey(input.company_name, input.company_domain, input.company_country, input.company_industry);
      const cached = researchCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return cached.data;
      }

      // Build targeted queries (focus BR sources + category signals)
      const company = input.company_name || input.company_domain;
      const queries = [
        // Organizacional
        `${company} funding OR investimento OR rodada OR "Series A" OR "Series B" OR IPO`,
        `${company} contratações OR vagas OR hiring`,
        `${company} lançamento OR feature OR produto`,
        `${company} expansão OR "novo escritório" OR "nova sede"`,
        // Mercado
        `${company} regulatória OR BCB OR ANVISA OR "Diário Oficial"`,
        `${company} concorrente OR parceria OR aquisição OR fusão`,
        `${company} evento OR conferência OR simpósio OR "LinkedIn Events"`,
        // Performance
        `${company} case OR depoimento OR press release OR blog OR whitepaper`,
        `${company} Glassdoor OR "Reclame Aqui"`,
        // BR tier-1 outlets
        `${company} site:valor.globo.com`,
        `${company} site:exame.com`,
        `${company} site:infomoney.com.br`,
        `${company} site:startupi.com.br`,
        // BR niche outlets
        `${company} site:startse.com`,
        `${company} site:neofeed.com.br`,
        `${company} site:bussola.istoe.com.br`,
      ];

      const allNews: NewsItem[] = [];
      for (const q of queries) {
        const items = await fetchGoogleNewsRSS(q, { limit: 6 });
        for (const it of items) {
          if (!allNews.find(n => n.url === it.url)) allNews.push(it);
        }
      }

      // Direct scraping of specific Brazilian sources home/news pages
      const brDirect = await fetchFromSourceList([
        'https://www.startse.com/noticias/',
        'https://neofeed.com.br/',
        'https://bussola.istoe.com.br/',
      ], 12);
      for (const it of brDirect) {
        if (!allNews.find(n => n.url === it.url)) allNews.push(it);
      }

      // Create context from sources for LLM extraction
      const sourcesContext = allNews
        .slice(0, 30)
        .map(n => `Title: ${n.title}\nURL: ${n.url}\nPublishedAt: ${n.publishedAt || ''}`)
        .join('\n\n---\n\n');

      const systemPrompt = `
Você é um analista sênior de business intelligence B2B especializado em identificar sinais de contexto para prospecção outbound estratégica.
OBJETIVO: Realizar varredura completa de sinais públicos sobre a empresa-alvo, priorizando informações acionáveis para personalização de abordagem comercial.
FORMATO DE SAÍDA OBRIGATÓRIO (JSON estruturado):
{
"company_analysis": {
"company_name": "string",
"search_date": "YYYY-MM-DD",
"data_freshness": "last_30d|last_60d|last_90d|older",
"overall_signal_strength": "high|medium|low",
"priority_signals": [
{
"signal_id": "1-24",
"signal_name": "nome descritivo",
"category": "organizacional|pessoal|mercado|performance",
"weight": "1-5",
"date": "YYYY-MM-DD",
"title": "max 80 chars - headline style",
"description": "max 150 chars - factual, specific",
"source_url": "URL verificável",
"confidence": "high|medium|low",
"recommended_action": "consultiva|relacional|educativa",
"copy_angle": "ângulo de personalização sugerido (max 100 chars)"
}
],
"total_signals_found": 0,
"signals_by_category": {
"organizacional": 0,
"mercado": 0,
"performance": 0
},
"key_insights": "síntese executiva dos principais achados (max 200 chars)",
"personalization_hooks": ["hook 1", "hook 2", "hook 3"]
}
}
SINAIS PRIORITÁRIOS (ordenados por weight):
CATEGORIA: ORGANIZACIONAL
- ID 1: Rodada de investimento (weight: 5)
- ID 7: Abertura de vagas tech/comercial (weight: 5)
- ID 2: Crescimento de funcionários >20% (weight: 4)
- ID 3: Novas contratações estratégicas C-level (weight: 4)
- ID 4: Lançamento de produto/feature (weight: 4)
- ID 5: Expansão geográfica (weight: 3)
- ID 6: Mudança de sede/escritório (weight: 2)
CATEGORIA: MERCADO
- ID 14: Mudança regulatória impactante (weight: 5)
- ID 13: Notícia de concorrente direto (weight: 4)
- ID 15: Fusões/aquisições/parcerias (weight: 4)
- ID 16: Participação em eventos (weight: 3)
- ID 17: Entrada de novo player (weight: 3)
- ID 18: Mudança macroeconômica (weight: 3)
CATEGORIA: PERFORMANCE
- ID 23: Publicação de case/depoimento (weight: 4)
- ID 24: Reviews negativos (padrão 3+) (weight: 3)
- ID 22: Alteração de site/branding (weight: 2)
REGRAS DE BUSCA E VALIDAÇÃO:
1. PERÍODO: Priorize últimos 30 dias, estenda até 90 se necessário
2. LIMITE: Retorne TOP 5-7 sinais mais relevantes e recentes
3. SOURCES: Apenas fontes públicas verificáveis (URLs acessíveis)
4. FACTUAL: Zero especulação, apenas fatos documentados
5. UNIQUE: Evite sinais redundantes (ex: não liste 3 funding diferentes)
6. ACTIONABLE: Cada sinal deve ser útil para personalização de cold email
CRITÉRIOS DE PRIORIZAÇÃO:
✓ Weight alto (4-5) + recência (<30 dias) = Prioridade máxima
✓ Múltiplos sinais da mesma categoria = Indicador forte de movimento
✓ Sinais correlacionados (ex: funding + hiring + expansion) = Momentum
✓ Sources tier 1 (Crunchbase, TechCrunch, Valor) > tier 2 (blogs)
FONTES POR CATEGORIA:
- Funding/M&A: Crunchbase, Startupi, Valor Econômico, TechCrunch Brasil
- Hiring: LinkedIn Jobs, Programathor, Gupy
- Regulatory: Diário Oficial, BCB, ANVISA, JusBrasil
- News: Google News, LinkedIn Company, site oficial
- Events: Eventbrite, Sympla, LinkedIn Events
- Reviews: G2, Glassdoor, Reclame Aqui
- Website: Archive.org, BuiltWith (menção)
PERSONALIZAÇÃO:
- Para cada sinal, sugira "copy_angle" = ângulo de abordagem específico
- Inclua "personalization_hooks" = 2-3 frases prontas para usar em cold email
TRATAMENTO DE CASOS ESPECIAIS:
- Se funding round: Inclua valor + stage + investidores principais
- Se hiring: Especifique departamento + seniority (se visível)
- Se regulatory: Cite número da norma/lei + deadline se houver
- Se event: Nome completo + cidade + se é speaker/sponsor/attendee
- Se case: Inclua métrica destacada se disponível
FORMATO DE RESPOSTA SEM DADOS:
{
"company_analysis": {
"company_name": "{{company_name}}",
"search_date": "YYYY-MM-DD",
"overall_signal_strength": "low",
"priority_signals": [],
"total_signals_found": 0,
"key_insights": "Presença digital limitada ou sem atividade recente relevante nos últimos 90 dias",
"personalization_hooks": ["Pesquisa genérica do setor", "Benchmark de mercado"]
}
}
PROIBIÇÕES ABSOLUTAS:
❌ NÃO invente dados ou URLs
❌ NÃO use fontes não verificáveis (fóruns, wikis abertos)
❌ NÃO misture JSON com texto explicativo fora da estrutura
❌ NÃO retorne sinais sem source_url
❌ NÃO exceda 7 sinais no output (qualidade > quantidade)
      `;
      const userPrompt = `
EMPRESA ALVO: ${input.company_name}
WEBSITE/DOMÍNIO: ${input.company_domain}
SETOR/INDÚSTRIA: ${input.company_industry}
PAÍS: ${input.company_country}
CONTEXTO ADICIONAL (se disponível):
- Concorrentes principais: ${input.company_competitors?.join(', ')}
- Segmento específico: ${input.company_industry}
- Região de atuação: ${input.company_country}
MISSÃO: Realizar varredura completa de sinais de contexto nos últimos 90 dias (priorize 30 dias) para identificar gatilhos de personalização em abordagem de cold outbound.
FOCO DA PESQUISA (em ordem de prioridade):
1. SINAIS ORGANIZACIONAIS (HIGH IMPACT):
✓ Rodadas de investimento, funding, Series A/B/C, IPO
✓ Abertura de vagas (Tech, Sales, Marketing, Growth, RevOps, C-level)
✓ Crescimento rápido de headcount (>20% em 6 meses)
✓ Contratações estratégicas (novos VP, Directors, Heads)
✓ Lançamentos de produtos, features ou serviços
✓ Expansão geográfica (novos escritórios, mercados, países)
✓ Mudança de sede ou novo office
2. SINAIS DE MERCADO (CONTEXTUAL):
✓ Mudanças regulatórias afetando o setor ${input.company_industry}
✓ Notícias sobre concorrentes diretos (funding, launches, pivots)
✓ Fusões, aquisições ou parcerias estratégicas
✓ Participação em eventos (palestrante, sponsor, expositor)
✓ Entrada de novos players competindo em ${input.company_industry}
✓ Macro trends impactando o setor
3. SINAIS DE PERFORMANCE (DIGITAL FOOTPRINT):
✓ Publicação de cases de sucesso, depoimentos, testimonials
✓ Press releases, blog posts, whitepapers recentes
✓ Alterações no website (redesign, novos produtos, branding)
✓ Padrões em reviews (G2, Glassdoor, Reclame Aqui) - apenas se 3+ menções similares
INSTRUÇÕES ESPECÍFICAS:
- Retorne TOP 5-7 sinais mais recentes e acionáveis
- Ordene por weight descendente (5 > 4 > 3 > 2)
- Para cada sinal, sugira copy_angle específico
- Inclua 2-3 personalization_hooks prontos para cold email
- Se não encontrar sinais fortes, seja honesto (overall_signal_strength: low)
4. TENDÊNCIAS SETORIAIS (ESPECÍFICAS):
✓ Citações do setor ${input.company_industry} (ex: "Open Banking", "Pix", "IA Generativa", "LGPD")
✓ Mudanças macro/regulatórias que afetam diretamente o segmento
✓ Principais players e movimentações nos últimos 90 dias

OUTPUT: JSON estruturado conforme schema do system prompt.
Data de referência para cálculo de recência: ${new Date().toISOString().split('T')[0]}

 FONTES COLETADAS (Google News e BR tier-1):
 ${sourcesContext || 'Nenhuma fonte externa encontrada; use dados públicos disponíveis.'}
      `;
      const json = await openai.chatCompletionJSON(systemPrompt, userPrompt);

      // Post-process: compute momentum based on signals
      try {
        const ca = (json as any)?.company_analysis;
        const signals = Array.isArray(ca?.priority_signals) ? ca.priority_signals : [];
        // Build confidence via cross-validation: count unique sources mentioning similar titles
        function computeConfidence(title: string, url: string): 'high' | 'medium' | 'low' {
          const t = (title || '').toLowerCase().replace(/\s+/g, ' ').trim();
          let matches = 0;
          for (const n of allNews) {
            const nt = (n.title || '').toLowerCase();
            if (nt && t && nt.includes(t.split(' ').slice(0, 5).join(' '))) {
              matches++;
            }
          }
          if (matches >= 3) return 'high';
          if (matches === 2) return 'medium';
          return 'low';
        }

        const enrichedSignals = signals.map((s: any) => {
          // Adjust weight with recency
          const baseW = Number(s.weight || baseWeight(String(s.title || s.signal_name || '')));
          const recDays = daysAgo(s.date);
          const newWeight = String(Math.max(1, Math.min(5, baseW + (recDays <= 30 ? 1 : 0))));
          const sentiment = analyzeSentiment(`${s.title || ''} ${s.description || ''}`);
          let recommended_action = s.recommended_action || 'consultiva';
          let copy_angle = s.copy_angle || '';
          if (sentiment === 'negative') {
            recommended_action = 'consultiva';
            copy_angle = copy_angle || 'Abordagem consultiva para mitigar riscos e apoiar reorganização.';
          } else if (sentiment === 'positive') {
            recommended_action = 'relacional';
            copy_angle = copy_angle || 'Conectar oferta com crescimento recente e próximos passos.';
          } else {
            recommended_action = 'educativa';
            copy_angle = copy_angle || 'Educar sobre oportunidades alinhadas ao cenário atual.';
          }
          const confidence = computeConfidence(String(s.title || s.signal_name || ''), String(s.source_url || ''));
          return { ...s, weight: newWeight, recommended_action, copy_angle, confidence };
        });

        const overall = momentumScore(enrichedSignals);
        (json as any).company_analysis.priority_signals = enrichedSignals.slice(0, 7);
        (json as any).company_analysis.total_signals_found = enrichedSignals.length;
        (json as any).company_analysis.overall_signal_strength = overall;
        const byCat = { organizacional: 0, mercado: 0, performance: 0 } as Record<string, number>;
        for (const s of enrichedSignals) {
          const cat = String(s.category || classifyCategory(String(s.title || '')));
          if (byCat[cat] !== undefined) byCat[cat]++;
        }
        (json as any).company_analysis.signals_by_category = byCat;
        const patterns = detectPatterns(enrichedSignals);
        const kiBase = (json as any).company_analysis.key_insights || '';
        const ki = [kiBase, ...patterns].filter(Boolean).join(' ');
        (json as any).company_analysis.key_insights = ki.trim();
        // Sector trends derivation (simple extraction from titles)
        const trendKeywords = ['open banking', 'pix', 'ia generativa', 'lgpd', 'open finance', 'pagamentos instantâneos', 'telemedicina', 'esg', 'carbono', 'onboarding digital', 'compliance'];
        const trendsSet = new Set<string>();
        for (const n of allNews) {
          const t = (n.title || '').toLowerCase();
          for (const kw of trendKeywords) {
            if (t.includes(kw)) trendsSet.add(kw);
          }
        }
        (json as any).company_analysis.sector_trends = Array.from(trendsSet).slice(0, 6);

        // Cache store
        researchCache.set(cacheKey, { ts: Date.now(), data: json });
      } catch {
        // if post-processing fails, still cache raw
        researchCache.set(cacheKey, { ts: Date.now(), data: json });
      }

      return json;
    },
  };
}
