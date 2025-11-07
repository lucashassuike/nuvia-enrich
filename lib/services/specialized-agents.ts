import type { EnrichmentField } from '../types';
import { OpenAIService } from './openai';
import { createAzureOpenAISearchTool } from '../agent-architecture/tools/azure-openai-search-tool';
import type { SearchType } from '../agent-architecture/tools/azure-openai-search-tool';

// Lightweight agent interface compatible with our Orchestrator expectations
type SimpleAgent = {
  run: (
    prompt: string,
    options?: { apiKey?: string; context?: Record<string, unknown> }
  ) => Promise<{ finalOutput: Record<string, unknown> }>
};

// Specialized search tool using Azure OpenAI
const createSpecializedSearchTool = (openai: OpenAIService, searchType: SearchType) => {
  // Reuse our Azure search tool which returns markdown-focused results
  return createAzureOpenAISearchTool(openai, searchType);
};

// Company Information Agent
export function createCompanyAgent(openai: OpenAIService): SimpleAgent {
  const search = createSpecializedSearchTool(openai, 'business');
  return {
    async run(_prompt: string, options?: { context?: Record<string, unknown> }) {
      const ctx = options?.context || {};
      const companyName = (ctx['companyName'] as string) || '';
      const domain = (ctx['domain'] as string) || (ctx['companyDomain'] as string) || '';
      const queries = [
        `${companyName} company overview`,
        `${companyName} website`,
        `${companyName} industry headquarters employee count`,
        `${domain} about company`,
      ].filter(Boolean);

      const results = await search.execute({ queries, targetField: 'company info', context: { companyName, companyDomain: domain } });

      const sources = results.map(r => r.url);
      const contentBlob = results.map(r => `Source: ${r.url}\nTitle: ${r.title}\nSummary:\n${r.markdown || r.description || ''}`).join('\n\n');
      const systemPrompt = `Extract structured company info from the provided summaries. Return JSON with keys: companyName, website, industry, headquarters, employeeCount, yearFounded, description, confidence (record), sources (array of URLs).`;
      const userPrompt = `COMPANY: ${companyName || domain}\n\nSUMMARIES:\n${contentBlob}\n\nReturn concise JSON.`;
      const finalOutput = await openai.chatCompletionJSON(systemPrompt, userPrompt);
      // Attach sources if missing
      if (finalOutput && !finalOutput.sources) finalOutput.sources = sources;
      return { finalOutput };
    }
  };
}

// Fundraising Intelligence Agent
export function createFundraisingAgent(openai: OpenAIService): SimpleAgent {
  const search = createSpecializedSearchTool(openai, 'news');
  return {
    async run(_prompt: string, options?: { context?: Record<string, unknown> }) {
      const ctx = options?.context || {};
      const companyName = (ctx['companyName'] as string) || '';
      const domain = (ctx['domain'] as string) || (ctx['companyDomain'] as string) || '';
      const queries = [
        `${companyName} funding`,
        `${companyName} raised Series`,
        `${companyName} investors valuation`,
      ].filter(Boolean);

      const results = await search.execute({ queries, targetField: 'funding', context: { companyName, companyDomain: domain } });
      const sources = results.map(r => r.url);
      const contentBlob = results.map(r => `Source: ${r.url}\nTitle: ${r.title}\nSummary:\n${r.markdown || r.description || ''}`).join('\n\n');
      const systemPrompt = `Extract fundraising info and return JSON with: lastFundingStage, lastFundingAmount, lastFundingDate, totalRaised, valuation, leadInvestors (array), allInvestors (array), confidence (record), sources (array of URLs).`;
      const userPrompt = `COMPANY: ${companyName || domain}\n\nSUMMARIES:\n${contentBlob}`;
      const finalOutput = await openai.chatCompletionJSON(systemPrompt, userPrompt);
      if (finalOutput && !finalOutput.sources) finalOutput.sources = sources;
      return { finalOutput };
    }
  };
}

// People & Leadership Agent
export function createPeopleAgent(openai: OpenAIService): SimpleAgent {
  const search = createSpecializedSearchTool(openai, 'discovery');
  return {
    async run(_prompt: string, options?: { context?: Record<string, unknown> }) {
      const ctx = options?.context || {};
      const companyName = (ctx['companyName'] as string) || '';
      const domain = (ctx['domain'] as string) || (ctx['companyDomain'] as string) || '';
      const queries = [
        `${companyName} CEO`,
        `${companyName} leadership team`,
        `${companyName} founders`,
        `${domain} CEO`,
        `${companyName} executive team LinkedIn`,
      ].filter(Boolean);

      const results = await search.execute({ queries, targetField: 'leadership', context: { companyName, companyDomain: domain } });
      const sources = results.map(r => r.url);
      const contentBlob = results.map(r => `Source: ${r.url}\nTitle: ${r.title}\nSummary:\n${r.markdown || r.description || ''}`).join('\n\n');
      const systemPrompt = `Extract leadership info and return JSON with keys:
{
  "ceo": { "name": string, "linkedin"?: string, "previousCompany"?: string }?,
  "founders": [{ "name": string, "role"?: string, "linkedin"?: string }]?,
  "keyExecutives": [{ "name": string, "title": string, "linkedin"?: string }]?,
  "boardMembers"?: string[],
  "employeeCount"?: number,
  "confidence"?: { "ceo"?: number, "founders"?: number, "keyExecutives"?: number },
  "sources": string[]
}
Return concise values.`;
      const userPrompt = `COMPANY: ${companyName || domain}\n\nSUMMARIES:\n${contentBlob}`;
      const finalOutput = await openai.chatCompletionJSON(systemPrompt, userPrompt);
      if (finalOutput && !finalOutput.sources) finalOutput.sources = sources;
      return { finalOutput };
    }
  };
}

// Product & Technology Agent
export function createProductAgent(openai: OpenAIService): SimpleAgent {
  const search = createSpecializedSearchTool(openai, 'technical');
  return {
    async run(_prompt: string, options?: { context?: Record<string, unknown> }) {
      const ctx = options?.context || {};
      const companyName = (ctx['companyName'] as string) || '';
      const domain = (ctx['domain'] as string) || (ctx['companyDomain'] as string) || '';
      const queries = [
        `${companyName} products platform`,
        `${companyName} technology stack`,
        `${companyName} competitors`,
      ].filter(Boolean);

      const results = await search.execute({ queries, targetField: 'product & tech', context: { companyName, companyDomain: domain } });
      const sources = results.map(r => r.url);
      const contentBlob = results.map(r => `Source: ${r.url}\nTitle: ${r.title}\nSummary:\n${r.markdown || r.description || ''}`).join('\n\n');
      const systemPrompt = `Extract product & tech info. Return JSON with keys: mainProducts (array), targetMarket, techStack (array), competitors (array), uniqueSellingPoints (array), pricingModel, confidence (record), sources (array of URLs).`;
      const userPrompt = `COMPANY: ${companyName || domain}\n\nSUMMARIES:\n${contentBlob}`;
      const finalOutput = await openai.chatCompletionJSON(systemPrompt, userPrompt);
      if (finalOutput && !finalOutput.sources) finalOutput.sources = sources;
      return { finalOutput };
    }
  };
}

// Contact & Social Media Agent
export function createContactAgent(openai: OpenAIService): SimpleAgent {
  const search = createSpecializedSearchTool(openai, 'discovery');
  return {
    async run(_prompt: string, options?: { context?: Record<string, unknown> }) {
      const ctx = options?.context || {};
      const companyName = (ctx['companyName'] as string) || '';
      const domain = (ctx['domain'] as string) || (ctx['companyDomain'] as string) || '';
      const queries = [
        `${companyName} contact email phone address`,
        `${companyName} official social media`,
        `${domain} contact`,
      ].filter(Boolean);

      const results = await search.execute({ queries, targetField: 'contacts', context: { companyName, companyDomain: domain } });
      const sources = results.map(r => r.url);
      const contentBlob = results.map(r => `Source: ${r.url}\nTitle: ${r.title}\nSummary:\n${r.markdown || r.description || ''}`).join('\n\n');
      const systemPrompt = `Extract contact info. Return JSON with keys: emails (array), phones (array), address, socialMedia { linkedin, twitter, facebook, instagram, youtube }, confidence (record), sources (array of URLs).`;
      const userPrompt = `COMPANY: ${companyName || domain}\n\nSUMMARIES:\n${contentBlob}`;
      const finalOutput = await openai.chatCompletionJSON(systemPrompt, userPrompt);
      if (finalOutput && !finalOutput.sources) finalOutput.sources = sources;
      return { finalOutput };
    }
  };
}

// Master Enrichment Coordinator that uses specialized agents
// Simple coordinator placeholder (not used yet). Left for future integration.
export function createEnrichmentCoordinator(
  _openai: OpenAIService,
  _fields: EnrichmentField[]
) {
  return {
    async run() {
      return { finalOutput: {} };
    }
  } as SimpleAgent;
}

// Helper function to create dynamic output schema based on requested fields
// Removed dynamic zod schema builder since we now use chatCompletionJSON for agents

// Service class to use the specialized agents
export class SpecializedAgentService {
  private openai: OpenAIService;
  private apiKey: string;

  constructor(apiKey: string, openai: OpenAIService) {
    this.apiKey = apiKey;
    this.openai = openai;
  }

  async enrichWithSpecializedAgents(
    context: Record<string, string>,
    fields: EnrichmentField[]
  ) {
    // Use individual agents based on field patterns
    const enrichmentResults: Record<string, { value: unknown; confidence: number; sources: string[] }> = {};
    
    for (const field of fields) {
      try {
        let agentToUse = null;
        const fieldNameLower = field.name.toLowerCase();
        const fieldDescLower = field.description.toLowerCase();
        
        if (fieldNameLower.includes('company') || fieldDescLower.includes('company')) {
          agentToUse = this.getCompanyAgent();
        } else if (fieldNameLower.includes('fund') || fieldDescLower.includes('fund')) {
          agentToUse = this.getFundraisingAgent();
        } else if (fieldNameLower.includes('people') || fieldNameLower.includes('ceo') || fieldNameLower.includes('founder')) {
          agentToUse = this.getPeopleAgent();
        } else if (fieldNameLower.includes('product') || fieldDescLower.includes('product')) {
          agentToUse = this.getProductAgent();
        } else if (fieldNameLower.includes('contact') || fieldNameLower.includes('social')) {
          agentToUse = this.getContactAgent();
        }
        
        if (agentToUse) {
          const result = await agentToUse.run('', { apiKey: this.apiKey, context });
          const output = result.finalOutput as Record<string, unknown>;
          enrichmentResults[field.name] = {
            value: output[field.name] ?? null,
            confidence: 0.8,
            sources: Array.isArray(output.sources) ? (output.sources as string[]) : []
          };
        }
      } catch (error) {
        console.error(`Error getting field ${field.name}:`, error);
        enrichmentResults[field.name] = {
          value: null,
          confidence: 0,
          sources: []
        };
      }
    }
    
    return enrichmentResults;
  }

  private transformAgentResult(agentOutput: Record<string, unknown>, fields: EnrichmentField[]) {
    const enrichmentResults: Record<string, { value: unknown; confidence: number; sources: string[] }> = {};
    
    fields.forEach(field => {
      if (field.name in agentOutput) {
        enrichmentResults[field.name] = {
          value: agentOutput[field.name],
          confidence: (agentOutput._confidence as Record<string, number>)?.[field.name] || 0.7,
          sources: (agentOutput._sources as Record<string, string[]>)?.[field.name] || [],
        };
      }
    });
    
    return enrichmentResults;
  }

  // Get a specific specialized agent for direct use
  getCompanyAgent() {
    return createCompanyAgent(this.openai);
  }

  getFundraisingAgent() {
    return createFundraisingAgent(this.openai);
  }

  getPeopleAgent() {
    return createPeopleAgent(this.openai);
  }

  getProductAgent() {
    return createProductAgent(this.openai);
  }

  getContactAgent() {
    return createContactAgent(this.openai);
  }
}