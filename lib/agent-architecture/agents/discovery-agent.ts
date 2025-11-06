import { Agent, Tool } from '@openai/agents';
import { z } from 'zod';
import { createExploriumTool } from '../tools/explorium-tool';
import { createWebResearchTool } from '../tools/web-research-tool';
import { OpenAIService } from '../../services/openai';

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

const CompanyAnalysisResult = z.object({
  company_analysis: z.object({
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
  }),
});

export function createDiscoveryAgent(exploriumApiKey: string, openai: OpenAIService) {
  console.log('[AGENT-DISCOVERY] Creating Discovery Agent');
  
  return new Agent({
    name: 'Discovery Agent',
    
    instructions: `You are the Discovery Agent. Your mission is to enrich a company's data and find actionable signals for outbound prospecting.
    
    PROCESS:
    1. Extract the domain from the input email (e.g., john@acme.com -> acme.com).
    2. Use the 'explorium_enrich' tool to get initial company data (name, industry, country, competitors).
    3. Take the enriched data from Explorium and use the 'web_research' tool to find recent signals.
    4. The 'web_research' tool will perform a comprehensive search and return a structured JSON with the top signals.
    5. Return the JSON output from the 'web_research' tool as the final result.`,
    
    tools: [
      createExploriumTool(exploriumApiKey) as unknown as Tool<unknown>,
      createWebResearchTool(openai) as unknown as Tool<unknown>,
    ],
    
    outputType: CompanyAnalysisResult,
  });
}