import { z } from 'zod';
import { createAzureOpenAIScraperTool } from '../tools/azure-openai-scraper-tool';
import { createAzureOpenAISearchTool } from '../tools/azure-openai-search-tool';
import { OpenAIService } from '../../services/openai';

const MetricsResult = z.object({
  employeeCount: z.string().describe('Employee count or range (e.g., "50-100", "1000+")'),
  revenue: z.string().optional().describe('Annual revenue (e.g., "$10M", "$100M ARR")'),
  growthRate: z.string().optional().describe('Growth rate if available'),
  isEstimate: z.record(z.string(), z.boolean()).describe('Whether each metric is an estimate'),
  confidence: z.record(z.string(), z.number()).describe('Confidence scores for each field'),
  sources: z.record(z.string(), z.array(z.string())).describe('Source URLs for each field'),
});

export function createMetricsAgent(openai: OpenAIService) {
  const scraper = createAzureOpenAIScraperTool(openai);
  const search = createAzureOpenAISearchTool(openai, 'metrics');

  return {
    async run(_prompt: string, options?: { context?: Record<string, unknown> }) {
      const ctx = options?.context || {};
      const companyName = (ctx['companyName'] as string) || '';
      const domain = (ctx['companyDomain'] as string) || '';

      // Build queries
      const queries = [
        `${companyName} employees team size ${new Date().getFullYear()}`,
        `${companyName} revenue ARR`,
        `${domain} careers`,
      ].filter(Boolean);

      const searchResults = await (search as any).execute({
        queries,
        targetField: 'metrics',
        context: { companyName, companyDomain: domain }
      });

      // Try scraping careers page for employee hints
      const possibleUrls = [
        domain ? `https://${domain}/careers` : '',
        domain ? `https://${domain}/jobs` : ''
      ].filter(Boolean);

      const scrapedContents: string[] = [];
      for (const url of possibleUrls) {
        try {
          const scraped = await (scraper as any).execute({ url, formats: ['markdown'] });
          if (scraped?.markdown) {
            scrapedContents.push(`URL: ${url}\n${scraped.markdown}`);
          }
        } catch {}
      }

      const sources = searchResults.map((r: any) => r.url).concat(possibleUrls);
      const contentBlob = searchResults.map((r: any) => `Source: ${r.url}\nTitle: ${r.title}\nSummary:\n${r.markdown || r.description || ''}`).join('\n\n')
        + (scrapedContents.length ? `\n\n${scrapedContents.join('\n\n')}` : '');

      const systemPrompt = `Extract metrics and return JSON with keys: employeeCount (string range), revenue (string), growthRate (string), isEstimate (record), confidence (record), sources (array of URLs).`;
      const userPrompt = `COMPANY: ${companyName || domain}\n\nDATA:\n${contentBlob}`;
      const finalOutput = await openai.chatCompletionJSON(systemPrompt, userPrompt);
      if (finalOutput && !finalOutput.sources) finalOutput.sources = sources;
      return { finalOutput };
    }
  };
}