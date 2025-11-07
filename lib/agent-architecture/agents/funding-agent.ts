import { z } from 'zod';
import { createAzureOpenAISearchTool } from '../tools/azure-openai-search-tool';
import { OpenAIService } from '../../services/openai';

const FundingResult = z.object({
  fundingStage: z.enum([
    'Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D', 'Series E+',
    'IPO', 'Acquired', 'Bootstrapped', 'Unknown'
  ]).describe('Latest funding stage'),
  lastFundingAmount: z.string().optional().describe('Amount raised in last round (e.g., "$10M")'),
  lastFundingDate: z.string().optional().describe('Date of last funding round'),
  totalRaised: z.string().optional().describe('Total funding raised to date'),
  valuation: z.string().optional().describe('Company valuation if available'),
  investors: z.array(z.string()).optional().describe('List of notable investors'),
  acquirer: z.string().optional().describe('Acquiring company if acquired'),
  confidence: z.record(z.string(), z.number()).describe('Confidence scores for each field'),
  sources: z.record(z.string(), z.array(z.string())).describe('Source URLs for each field'),
});

export function createFundingAgent(openai: OpenAIService) {
  const newsSearch = createAzureOpenAISearchTool(openai, 'news');
  const bizSearch = createAzureOpenAISearchTool(openai, 'business');

  return {
    async run(_prompt: string, options?: { context?: Record<string, unknown> }) {
      const ctx = options?.context || {};
      const companyName = (ctx['companyName'] as string) || '';
      const domain = (ctx['companyDomain'] as string) || '';

      const queries = [
        `${companyName} funding announcement ${new Date().getFullYear()}`,
        `${companyName} raises series`,
        `${companyName} investors valuation`,
      ].filter(Boolean);

      const resultsNews = await (newsSearch as any).execute({
        queries,
        targetField: 'funding',
        context: { companyName, companyDomain: domain }
      });

      const resultsBiz = await (bizSearch as any).execute({
        queries: [`${companyName} investors list`],
        targetField: 'funding',
        context: { companyName, companyDomain: domain }
      });

      const results = [...resultsNews, ...resultsBiz];
      const sources = results.map((r: any) => r.url);
      const contentBlob = results.map((r: any) => `Source: ${r.url}\nTitle: ${r.title}\nSummary:\n${r.markdown || r.description || ''}`).join('\n\n');

      const systemPrompt = `Extract funding info and return JSON with: fundingStage, lastFundingAmount, lastFundingDate, totalRaised, valuation, investors (array), confidence (record), sources (array of URLs).`;
      const userPrompt = `COMPANY: ${companyName || domain}\n\nSUMMARIES:\n${contentBlob}`;
      const finalOutput = await openai.chatCompletionJSON(systemPrompt, userPrompt);
      if (finalOutput && !finalOutput.sources) finalOutput.sources = sources;
      return { finalOutput };
    }
  };
}