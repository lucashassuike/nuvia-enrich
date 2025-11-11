import { z } from 'zod';
import { createApolloTool, createApolloPeopleTool, createApolloPersonMatchTool } from '../tools/apollo-tool';
import { createSnovTool, verifyEmailWithSnovV2 } from '../tools/snov-tool';
import { createWebResearchTool } from '../tools/web-research-tool';
import { OpenAIService } from '../../services/openai';
import { createApifyLinkedinPostsTool } from '../tools/apify-tool';

const Signal = z.object({
  // Accept numeric IDs and coerce to string
  signal_id: z.union([z.string(), z.number()]).transform(v => String(v)),
  signal_name: z.string(),
  // Accept English category variants and map to Portuguese
  category: z
    .enum([
      'organizacional',
      'pessoal',
      'mercado',
      'performance',
      'organizational',
      'market',
      'personal',
    ])
    .transform(val => {
      if (val === 'organizational') return 'organizacional';
      if (val === 'market') return 'mercado';
      if (val === 'personal') return 'pessoal';
      return val;
    }),
  // Accept numeric weight and coerce to string
  weight: z.union([z.string(), z.number()]).transform(v => String(v)),
  date: z.string(),
  title: z.string(),
  description: z.string(),
  source_url: z.string().url(),
  confidence: z.enum(['high', 'medium', 'low']),
  recommended_action: z.string(),
  copy_angle: z.string(),
});

const CompanyAnalysisResult = z.object({
  company_analysis: z.object({
    company_name: z.string(),
    search_date: z.string(),
    data_freshness: z.string(),
    overall_signal_strength: z.enum(['high', 'medium', 'low']),
    priority_signals: z.array(Signal),
    total_signals_found: z.number(),
    // Accept either Portuguese or English category keys, and pass through extras
    signals_by_category: z
      .union([
        z.object({
          organizacional: z.number().optional(),
          pessoal: z.number().optional(),
          mercado: z.number().optional(),
          performance: z.number().optional(),
        }).passthrough(),
        z.object({
          organizational: z.number().optional(),
          personal: z.number().optional(),
          market: z.number().optional(),
          performance: z.number().optional(),
        }).passthrough(),
      ])
      .or(z.record(z.string(), z.number())),
    key_insights: z.string(),
    personalization_hooks: z.array(z.string()),
  }).passthrough(),
});

export async function runDiscoveryAgent(
  email: string,
  apolloApiKey: string,
  openai: OpenAIService,
  options?: { name?: string; linkedin_url?: string; url?: string; snov?: { clientId?: string; clientSecret?: string; apiKey?: string } }
) {
  // Optional email verification with Snov.io v2 (executed independently)
  const verifyEmails = (process.env.SNOV_VERIFY_EMAILS || '').toLowerCase() === 'true';
  const match = email.match(/@([^\s@]+)$/);
  const domain = match ? match[1] : '';
  const apollo = createApolloTool(apolloApiKey);
  const apolloPeople = createApolloPeopleTool(apolloApiKey);
  const apolloPersonMatch = createApolloPersonMatchTool(apolloApiKey);
  const webResearch = createWebResearchTool(openai);
  const apifyLinkedin = createApifyLinkedinPostsTool();

  const normalizeDomain = (d: string) =>
    d
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .trim();

  console.log('[DiscoveryAgent] Starting independent enrichment blocks (Snov, Apollo, WebResearch)');

  const snovPromise = (async () => {
    if (!options?.snov) return null;
    try {
      const snov = createSnovTool(options.snov);
      const snovData = await snov.execute({ domain, includeProspects: true });
      console.log('[DiscoveryAgent] Snov domain info:', JSON.stringify(snovData));
      return snovData || null;
    } catch (err) {
      console.log('[DiscoveryAgent] Snov call failed:', err);
      return null;
    }
  })();

  const apolloPromise = (async () => {
    try {
      const apolloData = await apollo.execute({
        ...(domain ? { domain } : {}),
        ...(options?.name ? { name: options.name } : {}),
        ...(options?.linkedin_url ? { linkedin_url: options.linkedin_url } : {}),
        ...(options?.url ? { url: options.url } : {}),
      });
      console.log('[DiscoveryAgent] Apollo result:', JSON.stringify(apolloData));
      return apolloData || null;
    } catch (err) {
      console.log('[DiscoveryAgent] Apollo call failed:', err);
      return null;
    }
  })();

  // WebResearch must use only basic input (no enriched dependencies)
  const webResearchPromise = (async () => {
    const baseInput = {
      company_name: options?.name || '',
      company_domain: domain,
      company_industry: 'unknown',
      company_country: 'unknown',
      company_competitors: [] as string[],
    };
    console.log('[DiscoveryAgent] WebResearch input (basic):', JSON.stringify(baseInput));
    const result = await webResearch.execute(baseInput);
    console.log('[DiscoveryAgent] WebResearch result:', JSON.stringify(result));
    return result || null;
  })();

  const emailVerificationPromise = (async () => {
    if (!verifyEmails || !options?.snov) return undefined;
    try {
      const ev = await verifyEmailWithSnovV2(email, options.snov);
      console.log('[DiscoveryAgent] Snov v2 email verification:', JSON.stringify(ev));
      return ev;
    } catch (e) {
      console.log('[DiscoveryAgent] Snov v2 email verification failed:', e);
      return undefined;
    }
  })();

  const [snovData, apolloData, webResult, emailVerification] = await Promise.all([
    snovPromise,
    apolloPromise,
    webResearchPromise,
    emailVerificationPromise,
  ]);
  
  // Prioritized independent blocks: Apollo Person Match > Apify LinkedIn > WebResearch
  let apolloPeopleResult: { executives: Array<{ name: string; title: string; department?: string; linkedin_url?: string }>; sourceCount: number } | null = null;
  let apolloPerson: { name?: string; title?: string; linkedin_url?: string; email?: string; organization_name?: string } | null = null;
  let apifyLinkedinResult: { items: Array<{ post_url: string; text?: string; publishedAt?: string; likes?: number; comments?: number; reshares?: number; author?: string; profile_url?: string; engagement_total?: number }>; sourceCount: number } | null = null;
  // Auto-detect LinkedIn company URL using Apollo data when available
  const autoLinkedinUrlApollo: string | undefined = (() => {
    const v = (apolloData as any)?.linkedin_url || (apolloData as any)?.linkedin || (apolloData as any)?.linkedin_company_url;
    return typeof v === 'string' && v.trim() ? (v as string).trim() : undefined;
  })();

  // Leadership search desativado conforme preferência do usuário
  apolloPeopleResult = null;
  // Precise person match via Apollo (if API key exists)
  try {
    if (apolloApiKey) {
      apolloPerson = await apolloPersonMatch.execute({ email });
      console.log('[DiscoveryAgent] Apollo person match:', JSON.stringify(apolloPerson));
    }
  } catch (err) {
    console.log('[DiscoveryAgent] Apollo person match failed:', err);
    apolloPerson = null;
  }

  try {
    // Prefer person-level LinkedIn from Apollo match; fallback to company LinkedIn
    const linkedinToUse = (apolloPerson?.linkedin_url && typeof apolloPerson.linkedin_url === 'string')
      ? apolloPerson.linkedin_url
      : (options?.linkedin_url || autoLinkedinUrlApollo);
    if (linkedinToUse) {
      apifyLinkedinResult = await apifyLinkedin.execute({ urls: [linkedinToUse], limitPerSource: 10, deepScrape: true, rawData: false });
      console.log('[DiscoveryAgent] Apify LinkedIn posts result:', JSON.stringify(apifyLinkedinResult));
    }
  } catch (err) {
    console.log('[DiscoveryAgent] Apify LinkedIn call failed:', err);
    apifyLinkedinResult = null;
  }

  // Aggregation: choose best source per field
  const picks: Record<string, { value: any; source: string }> = {};
  const sourcesUsed = new Set<string>();

  // Evaluate Apollo quality
  const requestedDomain = domain ? normalizeDomain(domain) : '';
  const returnedDomainApollo = apolloData?.company_domain ? normalizeDomain(apolloData.company_domain) : '';
  const domainMismatchApollo = Boolean(requestedDomain && returnedDomainApollo && requestedDomain !== returnedDomainApollo);
  const requestedName = options?.name?.toLowerCase().trim();
  const returnedNameApollo = apolloData?.company_name?.toLowerCase().trim();
  const nameLooksLikeDomainApollo = !!returnedNameApollo && /\./.test(returnedNameApollo);
  const nameMismatchApollo = Boolean(requestedName && returnedNameApollo && !returnedNameApollo.includes(requestedName));
  const apolloOK = !!apolloData && !domainMismatchApollo && !nameMismatchApollo && !nameLooksLikeDomainApollo;

  // Snov company extraction helpers
  const snovCompany = (snovData as any)?.company || {};
  const snovName = typeof (snovCompany as any).company_name === 'string'
    ? (snovCompany as any).company_name.trim()
    : (typeof (snovCompany as any).name === 'string' ? (snovCompany as any).name.trim() : '');
  const snovWebsite = typeof snovCompany.website === 'string' ? normalizeDomain((snovCompany.website as string).trim()) : '';
  const snovIndustry = typeof snovCompany.industry === 'string' ? (snovCompany.industry as string).trim() : '';
  const snovHasData = !!snovData && !!(snovData as any).has_data;

  // company_name
  if (apolloOK && apolloData?.company_name) {
    picks.company_name = { value: apolloData.company_name, source: 'apollo' };
  } else if (snovHasData && snovName) {
    picks.company_name = { value: snovName, source: 'snov' };
  } else if (webResult?.company_analysis?.company_name) {
    picks.company_name = { value: (webResult.company_analysis as any).company_name, source: 'web' };
  } else {
    picks.company_name = { value: options?.name || '', source: 'input' };
  }

  // company_domain
  if (apolloOK && apolloData?.company_domain) {
    picks.company_domain = { value: apolloData.company_domain, source: 'apollo' };
  } else if (snovHasData && snovWebsite) {
    picks.company_domain = { value: snovWebsite, source: 'snov' };
  } else if (webResult?.company_analysis?.company_domain) {
    picks.company_domain = { value: (webResult.company_analysis as any).company_domain, source: 'web' };
  } else {
    picks.company_domain = { value: domain, source: 'input' };
  }

  // company_industry
  if (apolloOK && apolloData?.company_industry) {
    picks.company_industry = { value: apolloData.company_industry, source: 'apollo' };
  } else if (snovHasData && snovIndustry) {
    picks.company_industry = { value: snovIndustry, source: 'snov' };
  } else if (webResult?.company_analysis?.company_industry) {
    picks.company_industry = { value: (webResult.company_analysis as any).company_industry, source: 'web' };
  } else {
    picks.company_industry = { value: 'unknown', source: 'unknown' };
  }

  // company_country
  if (apolloOK && apolloData?.company_country) {
    picks.company_country = { value: apolloData.company_country, source: 'apollo' };
  } else if (webResult?.company_analysis?.company_country) {
    picks.company_country = { value: (webResult.company_analysis as any).company_country, source: 'web' };
  } else {
    picks.company_country = { value: 'unknown', source: 'unknown' };
  }

  // company_competitors
  const apolloCompetitors = Array.isArray(apolloData?.company_competitors) ? apolloData?.company_competitors : [];
  const webCompetitors = Array.isArray((webResult?.company_analysis as any)?.company_competitors) ? (webResult?.company_analysis as any).company_competitors : [];
  if (apolloOK && apolloCompetitors && apolloCompetitors.length > 0) {
    picks.company_competitors = { value: apolloCompetitors, source: 'apollo' };
  } else if (webCompetitors && webCompetitors.length > 0) {
    picks.company_competitors = { value: webCompetitors, source: 'web' };
  } else {
    picks.company_competitors = { value: [], source: 'unknown' };
  }

  // prospects (Snov only)
  const snovProspects = Array.isArray((snovData as any)?.prospects) ? (snovData as any).prospects : [];
  // technologies (Snov only)
  const techList = Array.isArray((snovData as any)?.technologies) ? (snovData as any).technologies : [];
  const snovTechnologies = techList
    .map((t: any) => (typeof t?.name === 'string' ? (t.name as string).trim() : ''))
    .filter((x: string) => x);

  // Track sources used
  Object.values(picks).forEach(p => sourcesUsed.add(p.source));
  if (snovProspects.length > 0) sourcesUsed.add('snov');
  if (snovTechnologies.length > 0) sourcesUsed.add('snov');

  console.log('[DiscoveryAgent] Field source selection:', JSON.stringify({
    company_name: picks.company_name.source,
    company_domain: picks.company_domain.source,
    company_industry: picks.company_industry.source,
    company_country: picks.company_country.source,
    company_competitors: picks.company_competitors.source,
  }));

  const sourceLabel = sourcesUsed.size > 1 ? 'multiple' : (sourcesUsed.values().next().value || 'unknown');

  // Base result comes from WebResearch for signals/insights; overlay aggregated firmographics
  const baseResult = webResult || { company_analysis: {
    company_name: picks.company_name.value,
    search_date: new Date().toISOString(),
    data_freshness: 'fresh',
    overall_signal_strength: 'medium',
    priority_signals: [],
    total_signals_found: 0,
    signals_by_category: {},
    key_insights: '',
    personalization_hooks: [],
  } };

  if (baseResult && baseResult.company_analysis) {
    (baseResult.company_analysis as any).company_name = picks.company_name.value;
    (baseResult.company_analysis as any).company_domain = picks.company_domain.value;
    (baseResult.company_analysis as any).company_industry = picks.company_industry.value;
    (baseResult.company_analysis as any).company_country = picks.company_country.value;
    (baseResult.company_analysis as any).company_competitors = picks.company_competitors.value;
    (baseResult.company_analysis as any).source = sourceLabel;
    // Preserve LinkedIn URL: prefer person-level if matched; otherwise company
    const linkedinToUse = (apolloPerson?.linkedin_url && typeof apolloPerson.linkedin_url === 'string')
      ? apolloPerson.linkedin_url
      : (options?.linkedin_url || autoLinkedinUrlApollo);
    if (linkedinToUse) {
      (baseResult.company_analysis as any).linkedin_url = linkedinToUse;
    }
    if (snovProspects && snovProspects.length > 0) {
      (baseResult.company_analysis as any).prospects = snovProspects;
    }
    if (snovTechnologies && snovTechnologies.length > 0) {
      (baseResult.company_analysis as any).technologies = snovTechnologies;
    }
    if (emailVerification) {
      (baseResult.company_analysis as any).email_verification = {
        provider: 'snov',
        status: emailVerification.status,
        email: emailVerification.email,
        details: emailVerification.details,
      };
    }

    // Não mapear executivos (leadership search removido)
    // Map Apify LinkedIn recent posts
    if (apifyLinkedinResult && Array.isArray(apifyLinkedinResult.items) && apifyLinkedinResult.items.length > 0) {
      const posts = apifyLinkedinResult.items.map(p => ({
        url: p.post_url,
        text: p.text,
        publishedAt: p.publishedAt,
        likes: p.likes,
        comments: p.comments,
        reshares: p.reshares,
        engagement_total: p.engagement_total,
      }));
      (baseResult.company_analysis as any).linkedin_recent_posts = posts;
      // Simple activity aggregate
      const postCount = posts.length;
      const totalEngagement = posts.reduce((acc, cur) => acc + (cur.engagement_total || 0), 0);
      (baseResult.company_analysis as any).company_activity = { postCount, totalEngagement };
    }
  }

  return CompanyAnalysisResult.parse(baseResult);
}
