import { z } from 'zod';
import { createAzureOpenAISearchTool } from '../tools/azure-openai-search-tool';
import { OpenAIService } from '../../services/openai';

const ProfileResult = z.object({
  industry: z.string().describe('Primary industry or sector'),
  headquarters: z.string().describe('Headquarters location (City, State/Country)'),
  yearFounded: z.number().min(1800).max(new Date().getFullYear()).describe('Year the company was founded'),
  companyType: z.enum(['Public', 'Private', 'Subsidiary', 'Non-profit', 'Unknown']).describe('Type of company'),
  confidence: z.record(z.string(), z.number()).describe('Confidence scores for each field'),
  sources: z.record(z.string(), z.array(z.string())).describe('Source URLs for each field'),
});

export function createCompanyProfileAgent(openai: OpenAIService) {
  console.log('[AGENT-PROFILE] Creating Company Profile Agent');

  // Lightweight agent that uses our Azure search tool + OpenAI JSON extraction
  const search = createAzureOpenAISearchTool(openai, 'business');

  return {
    async run(_prompt: string, options?: { context?: Record<string, unknown> }) {
      const ctx = options?.context || {};
      const companyName = (ctx['companyName'] as string) || '';
      const domain = (ctx['companyDomain'] as string) || '';

      const queries = [
        `${companyName} industry headquarters founded year`,
        `${companyName} company type public private subsidiary`,
        `${domain} about company`,
      ].filter(Boolean);

      const results = await (search as any).execute({
        queries,
        targetField: 'company profile',
        context: { companyName, companyDomain: domain }
      });

      const sources = results.map((r: any) => r.url);
      const contentBlob = results.map((r: any) => `Source: ${r.url}\nTitle: ${r.title}\nSummary:\n${r.markdown || r.description || ''}`).join('\n\n');

      const systemPrompt = `Extract company profile with keys: industry, headquarters, yearFounded, companyType (Public|Private|Subsidiary|Non-profit), confidence (record), sources (array of URLs). Return JSON conforming to the schema.`;
      const userPrompt = `COMPANY: ${companyName || domain}\n\nSUMMARIES:\n${contentBlob}`;
      const finalOutput = await openai.chatCompletionJSON(systemPrompt, userPrompt);
      if (finalOutput && !finalOutput.sources) finalOutput.sources = sources;
      return { finalOutput };
    }
  };
}