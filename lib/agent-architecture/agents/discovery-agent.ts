import { z } from 'zod';
import { createExploriumTool } from '../tools/explorium-tool';
import { createExploriumMCPTool } from '../tools/explorium-mcp-tool';
import { createWebResearchTool } from '../tools/web-research-tool';
import { OpenAIService } from '../../services/openai';

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
  }),
});

export async function runDiscoveryAgent(
  email: string,
  exploriumApiKey: string,
  openai: OpenAIService,
  options?: { name?: string; linkedin_url?: string; url?: string }
) {
  const match = email.match(/@([^\s@]+)$/);
  const domain = match ? match[1] : '';

  const explorium = createExploriumTool(exploriumApiKey);
  // Try MCP first, then fall back to REST API
  let enriched: {
    company_name: string;
    company_domain: string;
    company_industry: string;
    company_country: string;
    company_competitors: string[];
  };

  const exploriumMcp = createExploriumMCPTool();
  try {
    const mcpResult = await exploriumMcp.execute({
      ...(domain ? { domain } : {}),
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.linkedin_url ? { linkedin_url: options.linkedin_url } : {}),
      ...(options?.url ? { url: options.url } : {}),
    });
    console.log('[DiscoveryAgent] MCP result:', JSON.stringify(mcpResult));

    // If MCP returns only unknowns (no enrichment), use REST fallback
    const isUnknown =
      (!mcpResult.company_domain && !mcpResult.company_name) ||
      (mcpResult.company_industry === 'unknown' &&
        mcpResult.company_country === 'unknown' &&
        (!mcpResult.company_competitors || mcpResult.company_competitors.length === 0));

    if (isUnknown) {
      console.log('[DiscoveryAgent] MCP returned unknowns, using REST fallback');
      enriched = await explorium.execute({
        ...(domain ? { domain } : {}),
        ...(options?.name ? { name: options.name } : {}),
        ...(options?.linkedin_url ? { linkedin_url: options.linkedin_url } : {}),
        ...(options?.url ? { url: options.url } : {}),
      });
      console.log('[DiscoveryAgent] REST result:', JSON.stringify(enriched));
    } else {
      console.log('[DiscoveryAgent] Using MCP enrichment');
      enriched = mcpResult as typeof enriched;
    }
  } catch {
    console.log('[DiscoveryAgent] MCP call failed, using REST fallback');
    enriched = await explorium.execute({
      ...(domain ? { domain } : {}),
      ...(options?.name ? { name: options.name } : {}),
      ...(options?.linkedin_url ? { linkedin_url: options.linkedin_url } : {}),
      ...(options?.url ? { url: options.url } : {}),
    });
    console.log('[DiscoveryAgent] REST result after MCP error:', JSON.stringify(enriched));
  }

  const webResearch = createWebResearchTool(openai);
  const input = {
    company_name: (enriched.company_name as string) || options?.name || domain,
    company_domain: (enriched.company_domain as string) || domain,
    company_industry: (enriched.company_industry as string) || 'unknown',
    company_country: (enriched.company_country as string) || 'unknown',
    company_competitors:
      (enriched.company_competitors as string[]) || ([] as string[]),
  };
  console.log('[DiscoveryAgent] WebResearch input:', JSON.stringify(input));

  const result = await webResearch.execute(input);
  console.log('[DiscoveryAgent] WebResearch result:', JSON.stringify(result));
  return CompanyAnalysisResult.parse(result);
}