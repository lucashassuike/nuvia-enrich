import { z } from 'zod';

type SnovCreds = { clientId?: string; clientSecret?: string; apiKey?: string };

// Simple in-memory token cache with TTL
const tokenCache: { token?: string; expiresAt?: number } = {};

async function getSnovAccessToken(creds?: SnovCreds): Promise<string | null> {
  const clientId = creds?.clientId || process.env.SNOV_CLIENT_ID;
  const clientSecret = creds?.clientSecret || process.env.SNOV_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Return cached if valid
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const body = { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' };
  let attempts = 0;
  const maxAttempts = 3;
  let lastError: unknown = null;

  while (attempts < maxAttempts) {
    try {
      const resp = await fetch('https://api.snov.io/v1/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        lastError = new Error(`Snov token request failed: ${resp.status}`);
        attempts++;
        await new Promise(r => setTimeout(r, 500 * attempts));
        continue;
      }
      const json = await resp.json();
      const token = json.access_token || null;
      const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 1800; // default 30min
      if (token) {
        tokenCache.token = token;
        tokenCache.expiresAt = Date.now() + (expiresInSec * 1000);
        return token;
      }
      return null;
    } catch (err) {
      lastError = err;
      attempts++;
      await new Promise(r => setTimeout(r, 500 * attempts));
    }
  }
  console.error('Snov OAuth error:', lastError);
  return null;
}

// Common fetch with backoff respecting basic rate limiting (POST)
async function snovPost<T>(url: string, token: string, payload: Record<string, any>): Promise<T> {
  let attempts = 0;
  const maxAttempts = 4;
  let lastError: unknown = null;

  while (attempts < maxAttempts) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      if (resp.status === 429) {
        // Rate limited: exponential backoff
        attempts++;
        const waitMs = Math.min(1500 * attempts, 5000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!resp.ok) {
        lastError = new Error(`Snov API ${url} failed: ${resp.status}`);
        attempts++;
        await new Promise(r => setTimeout(r, 400 * attempts));
        continue;
      }

      const json = await resp.json();
      return json as T;
    } catch (err) {
      lastError = err;
      attempts++;
      await new Promise(r => setTimeout(r, 400 * attempts));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Snov API request failed');
}

// Common fetch (GET)
async function snovGet<T>(url: string, token: string): Promise<T> {
  let attempts = 0;
  const maxAttempts = 4;
  let lastError: unknown = null;

  while (attempts < maxAttempts) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (resp.status === 429) {
        attempts++;
        const waitMs = Math.min(1500 * attempts, 5000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!resp.ok) {
        lastError = new Error(`Snov API ${url} failed: ${resp.status}`);
        attempts++;
        await new Promise(r => setTimeout(r, 400 * attempts));
        continue;
      }

      const json = await resp.json();
      return json as T;
    } catch (err) {
      lastError = err;
      attempts++;
      await new Promise(r => setTimeout(r, 400 * attempts));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Snov API request failed');
}

// Zod schemas for responses (v2 domain search)
const CompanySchema = z
  .object({
    company_name: z.string().nullable().optional(),
    industry: z.string().nullable().optional(),
    size: z.union([z.string(), z.number()]).nullable().optional(),
    country: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    founded: z.union([z.string(), z.number()]).nullable().optional(),
    hq_phone: z.string().nullable().optional(),
    revenue: z.union([z.string(), z.number()]).nullable().optional(),
    related_domains: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

const ProspectSchema = z
  .object({
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    position: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    linkedin: z.string().nullable().optional(),
  })
  .passthrough();

export function createSnovTool(creds?: SnovCreds) {
  return {
    name: 'snov_company_enrich',
    description: 'Fetch company info and prospects from Snov.io by domain (v2 domain-search)',
    parameters: z.object({
      domain: z.string().describe('Company website domain'),
      includeProspects: z.boolean().optional().default(true),
    }),
    execute: async ({ domain }: { domain: string; includeProspects?: boolean }) => {
      const cleanDomain = (domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').trim();
      if (!cleanDomain) {
        return { has_data: false };
      }

      const token = await getSnovAccessToken(creds);
      if (!token) {
        return { has_data: false };
      }

      try {
        // 1) Start domain search
        type StartResp = {
          data?: any[];
          meta?: { domain?: string; task_hash?: string };
          links?: { result?: string };
        };
        const start = await snovPost<StartResp>('https://api.snov.io/v2/domain-search/start', token, { domain: cleanDomain });
        const taskHash = start?.meta?.task_hash || (start?.links?.result ? start.links.result.split('/').pop() : undefined);
        if (!taskHash) {
          console.warn('Snov start did not return task_hash');
          return { has_data: false };
        }

        // 2) Poll for results
        type ResultResp = { data?: any; meta?: Record<string, any> };
        let result: ResultResp | null = null;
        const maxPollAttempts = 5;
        for (let i = 0; i < maxPollAttempts; i++) {
          const url = `https://api.snov.io/v2/domain-search/result/${taskHash}`;
          const res = await snovGet<ResultResp>(url, token);
          // If data is present and non-empty, break
          if (res?.data && Object.keys(res.data).length > 0) {
            result = res;
            break;
          }
          // wait a bit before retrying
          await new Promise(r => setTimeout(r, 600 + i * 200));
        }

        if (!result?.data) {
          return { has_data: false };
        }

        const companyRaw = result.data || {};
        const company = CompanySchema.parse(companyRaw);

        // emails count if present
        const emailsArr = Array.isArray((companyRaw as any).emails) ? (companyRaw as any).emails : [];
        const emails_count = emailsArr.length;

        // prospects if present in known locations
        const prospectsRaw =
          (Array.isArray((companyRaw as any).prospects) ? (companyRaw as any).prospects : null) ||
          (Array.isArray((companyRaw as any).prospect_profiles) ? (companyRaw as any).prospect_profiles : null) ||
          (Array.isArray((result as any).prospects) ? (result as any).prospects : null);

        const prospects = Array.isArray(prospectsRaw)
          ? (prospectsRaw as any[]).map(p => ProspectSchema.parse(p))
          : [];

        return {
          has_data: Boolean(company?.company_name || emails_count > 0 || prospects.length > 0),
          company,
          emails_count,
          technologies: [], // v2 domain-search does not provide technologies directly
          prospects,
        };
      } catch (err) {
        console.error('Snov integration error:', err);
        return { has_data: false };
      }
    },
  };
}

// Email verification (v2) via Snov.io
const EmailVerificationStartSchema = z
  .object({
    data: z.object({ task_hash: z.string() }).optional(),
    meta: z.object({ emails: z.array(z.string()) }).optional(),
    links: z.object({ result: z.string().optional() }).optional(),
  })
  .passthrough();

const EmailVerificationResultItemSchema = z
  .object({
    email: z.string(),
    result: z
      .object({
        is_webmail: z.boolean().optional(),
        smtp_status: z.enum(['valid', 'not_valid', 'unknown']).optional(),
        is_gibberish: z.boolean().optional(),
        is_disposable: z.boolean().optional(),
        is_valid_format: z.boolean().optional(),
        unknown_status_reason: z
          .enum(['catchall', 'banned', 'connection_error', 'greylist', 'hidden_by_owner'])
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const EmailVerificationResultSchema = z
  .object({
    status: z.enum(['completed', 'in_progress']).optional(),
    data: z.array(EmailVerificationResultItemSchema).optional(),
    meta: z
      .object({ emails: z.array(z.string()).optional(), task_hash: z.string().optional() })
      .optional(),
  })
  .passthrough();

export async function verifyEmailWithSnovV2(
  email: string,
  creds?: SnovCreds
): Promise<{
  email: string;
  status: 'valid' | 'not_valid' | 'unknown';
  details?: {
    is_valid_format?: boolean;
    is_disposable?: boolean;
    is_webmail?: boolean;
    is_gibberish?: boolean;
    unknown_status_reason?: 'catchall' | 'banned' | 'connection_error' | 'greylist' | 'hidden_by_owner';
  };
}> {
  const token = await getSnovAccessToken(creds);
  if (!token) {
    return { email, status: 'unknown' };
  }
  // Start verification with proper form encoding (emails[])
  const startUrl = 'https://api.snov.io/v2/email-verification/start';
  let taskHash: string | undefined;
  {
    const formBody = JSON.stringify({ emails: [email] });
    // Snov expects form-like array parameter; if JSON is not accepted, fallback to URLSearchParams
    let startResp: any;
    try {
      startResp = await snovPost<any>(startUrl, token, { emails: [email] });
    } catch (e) {
      // Fallback: attempt URLSearchParams style
      const resp = await fetch(startUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'emails[]': email }).toString(),
      });
      if (!resp.ok) throw new Error(`Snov API ${startUrl} failed: ${resp.status}`);
      startResp = await resp.json();
    }
    const parsed = EmailVerificationStartSchema.parse(startResp || {});
    taskHash = parsed?.data?.task_hash || (parsed?.links?.result ? parsed.links.result.split('/').pop() : undefined);
    if (!taskHash) {
      return { email, status: 'unknown' };
    }
  }

  // Poll result
  const resultUrl = `https://api.snov.io/v2/email-verification/result?task_hash=${taskHash}`;
  let resultParsed: z.infer<typeof EmailVerificationResultSchema> | undefined;
  for (let i = 0; i < 6; i++) {
    const res = await snovGet<any>(resultUrl, token);
    const parsed = EmailVerificationResultSchema.parse(res || {});
    if (parsed?.status === 'completed' && Array.isArray(parsed.data)) {
      resultParsed = parsed;
      break;
    }
    await new Promise(r => setTimeout(r, 600 + i * 250));
  }
  if (!resultParsed || !Array.isArray(resultParsed.data)) {
    return { email, status: 'unknown' };
  }
  const item = resultParsed.data.find(i => i.email?.toLowerCase() === email.toLowerCase()) || resultParsed.data[0];
  const smtp = item?.result?.smtp_status || 'unknown';
  const status: 'valid' | 'not_valid' | 'unknown' = smtp as any;
  const details = {
    is_valid_format: item?.result?.is_valid_format,
    is_disposable: item?.result?.is_disposable,
    is_webmail: item?.result?.is_webmail,
    is_gibberish: item?.result?.is_gibberish,
    unknown_status_reason: item?.result?.unknown_status_reason,
  };
  return { email, status, details };
}
