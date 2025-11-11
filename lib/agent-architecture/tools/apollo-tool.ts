import { z } from 'zod';

export function createApolloTool(apolloApiKey: string) {
  return {
    name: 'apollo_enrich',
    description: 'Enrich a company using Apollo.io Companies API',
    parameters: z.object({
      name: z.string().optional().describe('Company name'),
      domain: z.string().optional().describe('Company website domain'),
      url: z.string().optional().describe('Company URL'),
      linkedin_url: z.string().optional().describe('LinkedIn company URL'),
    }),
    execute: async ({
      name,
      domain,
      url,
      linkedin_url,
    }: {
      name?: string;
      domain?: string;
      url?: string;
      linkedin_url?: string;
    }) => {
      // Apollo API endpoints vary; try common search endpoints in order
      const candidates = [
        'https://api.apollo.io/v1/organizations/search',
        'https://api.apollo.io/v1/companies/search',
        'https://api.apollo.io/v1/mixed_companies/search',
      ];

      // Build request payload focusing on domain or name
      const query: Record<string, any> = {
        page: 1,
        // Prefer domain filter when available
        ...(domain ? { domain } : {}),
        ...(name ? { name } : {}),
        // Some Apollo endpoints expect a filter object
        ...(domain || name
          ? { q: domain || name }
          : {}),
      };

      const headersCommon: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      const headersWithApiKeyVariants: Array<Record<string, string>> = [
        { ...headersCommon, 'Authorization': `Bearer ${apolloApiKey}` },
        { ...headersCommon, 'x-api-key': apolloApiKey },
      ];

      try {
        let record: any = null;
        for (const endpoint of candidates) {
          let resp: Response | null = null;
          // Try with header variants
          for (const headers of headersWithApiKeyVariants) {
            resp = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(query),
            });
            if (resp.ok) break;
          }

          if (!resp || !resp.ok) {
            // Some Apollo endpoints accept api_key in the body
            resp = await fetch(endpoint, {
              method: 'POST',
              headers: headersCommon,
              body: JSON.stringify({ ...query, api_key: apolloApiKey }),
            });
          }

          if (resp && resp.ok) {
            const json = await resp.json();
            // Normalize possible shapes
            const items = json.organizations || json.companies || json.data || json.results || [];
            const first = Array.isArray(items) ? items[0] : items;
            if (first) {
              record = first;
              break;
            }
          }
        }

        if (record) {
          return {
            company_name: record.name || name || domain || '',
            company_domain: record.website_url || record.domain || domain || '',
            company_industry: record.industry || record.primary_industry || 'unknown',
            company_country: record.country || record.country_code || 'unknown',
            company_competitors: Array.isArray(record.top_competitors) ? record.top_competitors : [],
            // Include LinkedIn company URL when available from Apollo
            linkedin_url: record.linkedin_url || record.linkedin || record.linkedin_company_url || '',
          };
        }

        // Fallback mínimo
        return {
          company_name: name ?? domain ?? '',
          company_domain: domain ?? '',
          company_industry: 'unknown',
          company_country: 'unknown',
          company_competitors: [],
        };
      } catch (err) {
        console.error('Apollo integration error:', err);
        return {
          company_name: name ?? domain ?? '',
          company_domain: domain ?? '',
          company_industry: 'unknown',
          company_country: 'unknown',
          company_competitors: [],
        };
      }
    },
  };
}

// Apollo People search tool for executives
export function createApolloPeopleTool(apolloApiKey: string) {
  return {
    name: 'apollo_people',
    description: 'Search executives using Apollo.io People API (no phone enrichment)',
    parameters: z.object({
      domain: z.string().optional().describe('Company website domain'),
      name: z.string().optional().describe('Company name'),
      titles: z.array(z.string()).optional().describe('Preferred titles to filter, e.g., CEO, CTO'),
      limit: z.number().optional().default(15).describe('Max number of people to return'),
    }),
    execute: async ({ domain, name, titles, limit = 15 }: { domain?: string; name?: string; titles?: string[]; limit?: number }) => {
      const endpointCandidates = [
        'https://api.apollo.io/v1/people/search',
        'https://api.apollo.io/v1/mixed_people/search',
      ];

      const headersCommon: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      const headersWithApiKeyVariants: Array<Record<string, string>> = [
        { ...headersCommon, 'Authorization': `Bearer ${apolloApiKey}` },
        { ...headersCommon, 'x-api-key': apolloApiKey },
      ];

      const buildQuery = () => {
        const q: Record<string, any> = {
          page: 1,
          per_page: Math.max(1, Math.min(50, limit || 15)),
        };
        // Apollo supports filters; use company domain/name
        const filters: Record<string, any> = {};
        if (domain) filters.website_url = domain;
        if (name) filters.organization_name = name;
        if (titles && titles.length > 0) filters.person_titles = titles;
        if (Object.keys(filters).length > 0) q.filters = filters;
        // Some endpoints expect q param
        q.q = domain || name || '';
        return q;
      };

      try {
        let records: any[] = [];
        for (const endpoint of endpointCandidates) {
          let resp: Response | null = null;
          // Try header variants
          for (const headers of headersWithApiKeyVariants) {
            resp = await fetch(endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(buildQuery()),
            });
            if (resp.ok) break;
          }
          if (!resp || !resp.ok) {
            // Fallback with api_key in body
            resp = await fetch(endpoint, {
              method: 'POST',
              headers: headersCommon,
              body: JSON.stringify({ ...buildQuery(), api_key: apolloApiKey }),
            });
          }
          if (resp && resp.ok) {
            const json = await resp.json();
            const items = json.people || json.persons || json.data || json.results || [];
            if (Array.isArray(items)) {
              records = items;
              break;
            }
          }
        }

        const executives = records
          .map((p: any) => {
            const name = p?.name || [p?.first_name, p?.last_name].filter(Boolean).join(' ').trim();
            const title = p?.title || p?.role || p?.designation || '';
            const department = p?.department || p?.seniority || undefined;
            const linkedin_url = p?.linkedin_url || p?.linkedin || undefined;
            // Do not include phone numbers per user requirement
            if (!name || !title) return null;
            return { name, title, department, linkedin_url };
          })
          .filter(Boolean);

        return { executives, sourceCount: executives.length };
      } catch (err) {
        console.error('Apollo People integration error:', err);
        return { executives: [], sourceCount: 0 };
      }
    },
  };
}

// Apollo People Enrichment (match by email) - precise person lookup
export function createApolloPersonMatchTool(apolloApiKey: string) {
  return {
    name: 'apollo_person_match',
    description: 'Match a single person using Apollo People Enrichment by email',
    parameters: z.object({
      email: z.string().email().describe('Person email to match'),
      reveal_personal_emails: z.boolean().optional().default(false),
      reveal_phone_number: z.boolean().optional().default(false),
    }),
    execute: async ({ email, reveal_personal_emails = false, reveal_phone_number = false }: { email: string; reveal_personal_emails?: boolean; reveal_phone_number?: boolean }) => {
      const baseUrl = 'https://api.apollo.io/api/v1/people/match';
      const url = `${baseUrl}?email=${encodeURIComponent(email)}&reveal_personal_emails=${reveal_personal_emails ? 'true' : 'false'}&reveal_phone_number=${reveal_phone_number ? 'true' : 'false'}`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'accept': 'application/json',
        'x-api-key': apolloApiKey,
      };

      try {
        const resp = await fetch(url, { method: 'POST', headers });
        if (!resp.ok) {
          console.warn('[Apollo Person Match] Non-OK response:', resp.status, resp.statusText);
          return null;
        }
        const json = await resp.json();
        const person = json?.person || json?.data || null;
        if (!person) return null;
        // Normalize person fields commonly used downstream
        return {
          id: person.id,
          name: person.name || [person.first_name, person.last_name].filter(Boolean).join(' ').trim(),
          first_name: person.first_name,
          last_name: person.last_name,
          title: person.title,
          linkedin_url: person.linkedin_url || person.linkedin || undefined,
          email: person.email || email,
          organization_name: person.organization_name,
          organization_id: person.organization_id,
          photo_url: person.photo_url,
          headline: person.headline,
          location: [person.city, person.state, person.country].filter(Boolean).join(', '),
        };
      } catch (err) {
        console.error('[Apollo Person Match] Error:', err);
        return null;
      }
    },
  };
}
