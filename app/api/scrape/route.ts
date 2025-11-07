import { NextRequest, NextResponse } from 'next/server';
import { OpenAIService } from '@/lib/services/openai';
import { createAzureOpenAIScraperTool } from '@/lib/agent-architecture/tools/azure-openai-scraper-tool';
import { isRateLimited } from '@/lib/rate-limit';

interface ScrapeRequestBody {
  url?: string;
  urls?: string[];
  [key: string]: unknown;
}

interface ScrapeResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface ApiError extends Error {
  status?: number;
}

export async function POST(request: NextRequest) {
  const rateLimit = await isRateLimited(request, 'scrape');
  
  if (!rateLimit.success) {
    return NextResponse.json({ 
      success: false,
      error: 'Rate limit exceeded. Please try again later.' 
    }, { 
      status: 429,
      headers: {
        'X-RateLimit-Limit': rateLimit.limit.toString(),
        'X-RateLimit-Remaining': rateLimit.remaining.toString(),
      }
    });
  }

  const azureApiKey = process.env.AZURE_OPENAI_API_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;

  if (!azureApiKey || !azureEndpoint || !azureDeployment || !azureApiVersion) {
    return NextResponse.json({
      success: false,
      error: 'Azure OpenAI configuration missing. Check AZURE_OPENAI_* env variables.'
    }, { status: 500 });
  }

  try {
    const body = await request.json() as ScrapeRequestBody;
    const { url, urls, ...params } = body;

    const openai = new OpenAIService(azureApiKey, azureEndpoint, azureDeployment, azureApiVersion);
    const scraper = createAzureOpenAIScraperTool(openai);

    let result: ScrapeResult;

    if (url && typeof url === 'string') {
      const targetFields = Array.isArray((params as any)?.targetFields)
        ? ((params as any)?.targetFields as string[])
        : ['companyName', 'description', 'industry', 'headquarters'];
      const data = await scraper.execute({ url, targetFields });
      result = { success: true, data };
    } else if (urls && Array.isArray(urls)) {
      const targetFields = Array.isArray((params as any)?.targetFields)
        ? ((params as any)?.targetFields as string[])
        : ['companyName', 'description', 'industry', 'headquarters'];
      const data = await Promise.all(
        urls.map(u => scraper.execute({ url: u, targetFields }))
      );
      result = { success: true, data: { results: data } };
    } else {
      return NextResponse.json({ success: false, error: 'Invalid request format. Please check your input and try again.' }, { status: 400 });
    }
    
    return NextResponse.json(result);

  } catch (error: unknown) {
    console.error('Error in /api/scrape endpoint (Azure):', error);
    const err = error as ApiError;
    const errorStatus = typeof err.status === 'number' ? err.status : 500;
    return NextResponse.json({ success: false, error: 'An error occurred while processing your request. Please try again later.' }, { status: errorStatus });
  }
}