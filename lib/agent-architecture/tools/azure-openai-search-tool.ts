import { z } from 'zod';
import { OpenAIService } from '../../services/openai';

export type SearchType = 'discovery' | 'business' | 'news' | 'technical' | 'metrics';

interface SearchContext {
  companyName?: string;
  companyDomain?: string;
  industry?: string;
  location?: string;
}

interface SearchResult {
  url: string;
  title?: string;
  markdown?: string;
  content?: string;
  description?: string;
}

interface ProcessedResult extends SearchResult {
  relevance: number;
  domain: string;
}

const AzureSearchOutput = z.array(
  z.object({
    url: z.string().url(),
    title: z.string().optional(),
    markdown: z.string().optional(),
    description: z.string().optional(),
  })
);

/**
 * Azure OpenAI-powered search tool that returns structured, markdown-focused results.
 * This replaces Firecrawl search by leveraging the GPT model to aggregate and summarize
 * trustworthy sources for given queries, returning results in a predictable shape.
 */
export function createAzureOpenAISearchTool(
  openai: OpenAIService,
  searchType: SearchType,
  onProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
) {
  return {
    name: `azure_search_${searchType}`,
    description:
      `Search the web for ${searchType} information using Azure OpenAI and return markdown summaries for each result`,
    parameters: z.object({
      queries: z.array(z.string()).describe('Search queries to try'),
      targetField: z.string().describe('The field we are trying to enrich'),
      context: z
        .object({
          companyName: z.string().optional(),
          companyDomain: z.string().optional(),
          industry: z.string().optional(),
          location: z.string().optional(),
        })
        .optional()
        .describe('Context to enhance search queries'),
    }),

    async execute({
      queries,
      targetField,
      context,
    }: {
      queries: string[];
      targetField: string;
      context?: SearchContext;
    }) {
      const allResults: ProcessedResult[] = [];

      for (const query of queries) {
        try {
          const enhancedQuery = enhanceQuery(query, searchType, context);
          if (onProgress) {
            onProgress(`Executing Azure search: ${enhancedQuery.substring(0, 80)}...`, 'info');
          }

          const systemPrompt = `
You are a meticulous web research assistant. Given a query and context, return TOP sources with:
- Real, accessible URLs (no placeholders)
- Clear titles
- Concise markdown summaries of the page's main content

STRICT RULES:
- Only include verifiable public sources with valid URLs
- Prefer recent content (last 1-2 years) when applicable
- Avoid social media profiles and wiki unless highly relevant
- Do not fabricate URLs or content. If unsure, omit.

OUTPUT FORMAT (JSON array):
[
  {
    "url": "https://example.com/article",
    "title": "Example Title",
    "markdown": "# Heading\nSummary of key points...",
    "description": "One-sentence summary"
  }
]
`;

          const userPrompt = `
SEARCH TYPE: ${searchType}
TARGET FIELD: ${targetField}
QUERY: ${enhancedQuery}
CONTEXT: ${JSON.stringify(context || {})}

Return 3-6 high-quality results with markdown summaries. Focus on ${searchType} relevance.`;

          const raw = await openai.chatCompletionJSON(systemPrompt, userPrompt);
          const parsed = AzureSearchOutput.safeParse(raw);
          if (!parsed.success) {
            if (onProgress) {
              onProgress(
                `Azure search returned unexpected format for query: ${enhancedQuery}`,
                'warning'
              );
            }
            continue;
          }

          const results = parsed.data;
          if (onProgress) {
            onProgress(`Processing ${results.length} results from Azure search`, 'info');
          }

          for (const result of results) {
            if (!result || !result.url) continue;
            const relevance = calculateRelevance(
              {
                url: result.url || '',
                title: result.title,
                markdown: result.markdown,
                content: result.markdown,
                description: result.description,
              },
              targetField,
              context,
              searchType
            );

            allResults.push({
              url: result.url,
              title: result.title || '',
              content: result.markdown || result.description || '',
              markdown: result.markdown || undefined,
              description: result.description,
              relevance,
              domain: safeHostname(result.url),
            });
          }
        } catch (error) {
          console.error(
            `Azure search failed for query: ${query}`,
            error instanceof Error ? error.message : String(error)
          );
          if (onProgress) {
            onProgress(
              `Azure search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
              'warning'
            );
          }
        }
      }

      // Sort by relevance and deduplicate by domain
      const uniqueResults = deduplicateByDomain(allResults)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 10);

      if (onProgress) {
        onProgress(`Ranked ${uniqueResults.length} unique results by relevance`, 'success');
      }

      return uniqueResults;
    },
  };
}

function enhanceQuery(query: string, searchType: SearchType, context?: SearchContext): string {
  let enhanced = query;

  // Add year for time-sensitive searches
  if (searchType === 'metrics' || searchType === 'news') {
    const year = new Date().getFullYear();
    if (!query.includes(year.toString())) {
      enhanced += ` ${year}`;
    }
  }

  // Add location context if available
  if (context?.location && searchType === 'business') {
    enhanced += ` ${context.location}`;
  }

  // Add industry context for technical searches
  if (context?.industry && searchType === 'technical') {
    enhanced += ` ${context.industry}`;
  }

  return enhanced;
}

function calculateRelevance(
  result: SearchResult,
  _targetField: string,
  context: SearchContext | undefined,
  searchType: SearchType
): number {
  let score = 0.5; // Base score

  const url = result.url.toLowerCase();
  const domain = safeHostname(result.url).toLowerCase();

  // Boost for company's own domain
  if (context?.companyDomain && domain.includes((context.companyDomain || '').toLowerCase())) {
    score += 0.3;
  }

  // Boost for trusted sources based on search type
  const trustedSources = {
    discovery: ['about', 'company', 'who-we-are'],
    business: ['crunchbase', 'pitchbook', 'zoominfo', 'dnb.com'],
    news: ['techcrunch', 'forbes', 'reuters', 'bloomberg', 'businesswire'],
    technical: ['github', 'producthunt', 'g2.com', 'capterra'],
    metrics: ['linkedin', 'glassdoor', 'indeed', 'builtin'],
  } as Record<SearchType, string[]>;

  const relevantSources = trustedSources[searchType] || [];
  if (relevantSources.some((source) => url.includes(source))) {
    score += 0.2;
  }

  // Boost for recent content (check if title/content contains recent year)
  const currentYear = new Date().getFullYear();
  const recentYears = [currentYear, currentYear - 1];
  const contentText = ((result.title || '') + ' ' + (result.content || '')).toLowerCase();

  if (recentYears.some((year) => contentText.includes(year.toString()))) {
    score += 0.1;
  }

  // Penalty for obviously irrelevant domains
  const irrelevantDomains = ['wikipedia.org', 'facebook.com', 'twitter.com', 'instagram.com'];
  if (irrelevantDomains.some((d) => url.includes(d))) {
    score -= 0.3;
  }

  return Math.max(0, Math.min(1, score));
}

function deduplicateByDomain(results: ProcessedResult[]): ProcessedResult[] {
  const seen = new Map<string, ProcessedResult>();

  for (const result of results) {
    const existing = seen.get(result.domain);
    if (!existing || result.relevance > existing.relevance) {
      seen.set(result.domain, result);
    }
  }

  return Array.from(seen.values());
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}