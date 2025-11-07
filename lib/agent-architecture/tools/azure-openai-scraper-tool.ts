import { z } from 'zod';
import { OpenAIService } from '../../services/openai';

interface ScrapeResult {
  success: boolean;
  markdown?: string;
  html?: string;
  metadata?: Record<string, unknown>;
}

export function createAzureOpenAIScraperTool(
  openai: OpenAIService,
  onProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
) {
  return {
    name: 'scrape_website_azure',
    description: 'Fetch a webpage and transform HTML into clean markdown using Azure OpenAI',
    parameters: z.object({
      url: z.string().url().describe('URL to scrape'),
      targetFields: z.array(z.string()).describe('Fields we are looking for'),
    }),

    async execute({ url, targetFields }: { url: string; targetFields: string[] }) {
      try {
        if (onProgress) onProgress(`Fetching ${url}`, 'info');
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AzureScraper/1.0)' } });
        if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        const html = await res.text();

        if (onProgress) onProgress(`Converting HTML to markdown with Azure OpenAI`, 'info');

        const systemPrompt = `You are an expert content transformer. Convert raw HTML into clean, readable markdown.
Rules:
- Preserve headings hierarchy (H1-H4)
- Convert links (keep URL)
- Remove scripts, styles, nav/footers, cookie banners
- Keep main content only (articles, product pages, blog posts)
- Include meta title and description when available
Output JSON with keys: markdown, metadata { title?, description? }`;

        const userPrompt = `HTML from ${url} (first 60k chars):\n\n${html.slice(0, 60000)}`;
        const json = await openai.chatCompletionJSON(systemPrompt, userPrompt);

        const markdown: string = json.markdown || '';
        const metadata: Record<string, unknown> = json.metadata || {};

        if (onProgress) onProgress(`Markdown length: ${markdown.length}`, 'success');

        // Simple extraction helpers similar to previous tool
        const extractedData: Record<string, unknown> = {};
        if (targetFields.includes('Company Name') || targetFields.includes('companyName')) {
          extractedData.companyName = extractCompanyName(markdown, metadata);
        }
        if (targetFields.includes('Company Description') || targetFields.includes('description')) {
          extractedData.description = extractDescription(markdown, metadata);
        }
        if (targetFields.includes('Location') || targetFields.includes('headquarters')) {
          extractedData.location = extractLocation(markdown);
        }
        if (targetFields.includes('Industry') || targetFields.includes('industry')) {
          extractedData.industry = extractIndustry(markdown);
        }

        return {
          url,
          extractedData,
          rawContent: markdown.substring(0, 5000),
          metadata,
        };
      } catch (error) {
        if (onProgress) onProgress(`Scrape failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'warning');
        return {
          url,
          error: error instanceof Error ? error.message : 'Unknown error',
          extractedData: {},
        };
      }
    },
  };
}

function extractCompanyName(markdown: string, metadata: Record<string, unknown>): string | null {
  if (metadata.title && typeof metadata.title === 'string') {
    const cleaned = metadata.title
      .replace(/\s*[\||-]\s*Official\s*(Website|Site)?\s*$/i, '')
      .replace(/\s*[\||-]\s*Home\s*$/i, '')
      .replace(/\s*[\||-]\s*About\s*.*$/i, '')
      .trim();
    if (cleaned && cleaned.length > 2 && cleaned.length < 100) return cleaned;
  }
  const h1Match = markdown.match(/^#\s+([^#\n]+)/m);
  if (h1Match) {
    const h1Text = h1Match[1].trim();
    if (h1Text.length > 2 && h1Text.length < 100) return h1Text;
  }
  const aboutMatch = markdown.match(/About\s+([A-Z][A-Za-z0-9\s&.-]+?)(?:\s*[\n|,.])/);
  if (aboutMatch) return aboutMatch[1].trim();
  return null;
}

function extractDescription(markdown: string, metadata: Record<string, unknown>): string | null {
  if (metadata.description && typeof metadata.description === 'string' && (metadata.description as string).length > 20) {
    return metadata.description as string;
  }
  const patterns = [
    /(?:Our\s+)?(?:Mission|Vision|About|Who\s+We\s+Are)[\s:]+([^\n]+(?:\n[^\n]+){0,2})/i,
    /We\s+(?:are|help|provide|build|create)\s+([^\n]+(?:\n[^\n]+){0,2})/i,
    /^([A-Z][^.!?]+(?:help|provide|build|create|enable|empower)[^.!?]+[.!?])/m,
  ];
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match) {
      const desc = match[1].trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ');
      if (desc.length > 30 && desc.length < 500) return desc;
    }
  }
  const paragraphs = markdown.split(/\n\n+/).filter((p) => p.length > 50);
  if (paragraphs.length > 0) return paragraphs[0].substring(0, 300).trim();
  return null;
}

function extractLocation(markdown: string): string | null {
  const patterns = [
    /(?:Headquarters|HQ|Based\s+in|Located\s+in)[\s:]+([A-Za-z\s,]+?)(?:\n|$)/i,
    /(?:Address|Office)[\s:]+([A-Za-z0-9\s,.-]+?)(?:\n|$)/i,
    /([A-Z][a-z]+(?:,\s*[A-Z]{2})?)\s*(?:USA|United\s+States|U\.S\.|US)/,
    /([A-Z][a-z]+,\s*[A-Z][a-z]+)/,
  ];
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match) {
      const location = match[1].trim();
      if (location.length > 3 && location.length < 100 && /[A-Za-z]/.test(location)) return location;
    }
  }
  return null;
}

function extractIndustry(markdown: string): string | null {
  const content = markdown.toLowerCase();
  const industries: Record<string, string[]> = {
    'SaaS': ['saas', 'software as a service', 'cloud platform', 'subscription software'],
    'Fintech': ['fintech', 'financial technology', 'payments', 'banking technology'],
    'Healthcare': ['healthcare', 'medical', 'healthtech', 'digital health'],
    'E-commerce': ['ecommerce', 'e-commerce', 'online retail', 'marketplace'],
    'EdTech': ['edtech', 'education technology', 'learning platform', 'online education'],
    'AI/ML': ['artificial intelligence', 'machine learning', 'ai platform', 'ml platform'],
    'Cybersecurity': ['cybersecurity', 'security platform', 'data protection', 'infosec'],
    'MarTech': ['martech', 'marketing technology', 'marketing platform', 'advertising tech'],
    'InsurTech': ['insurtech', 'insurance technology', 'digital insurance'],
    'Real Estate': ['proptech', 'real estate', 'property technology'],
  };
  const matches: Record<string, number> = {};
  for (const [industry, keywords] of Object.entries(industries)) {
    let count = 0;
    for (const keyword of keywords) {
      if (content.includes(keyword)) count++;
    }
    if (count > 0) matches[industry] = count;
  }
  const sorted = Object.entries(matches).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) return sorted[0][0];
  const industryMatch = markdown.match(/(?:Industry|Sector)[\s:]+([A-Za-z\s&-]+?)(?:\n|,|\.|$)/i);
  if (industryMatch) return industryMatch[1].trim();
  return null;
}