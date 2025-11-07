import { z } from 'zod';

export function createExploriumTool(exploriumApiKey: string) {
  return {
    name: 'explorium_enrich',
    description: 'Enrich a company using Explorium Business API (v1)',
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
      const matchUrl =
        process.env.EXPLORIUM_MATCH_ENDPOINT ||
        'https://api.explorium.ai/v1/businesses/match';
      const fetchUrl =
        process.env.EXPLORIUM_FETCH_ENDPOINT ||
        'https://api.explorium.ai/v1/businesses';

      const headers = {
        'Content-Type': 'application/json',
        api_key: exploriumApiKey,
      };

      try {
        let businessId: string | null = null;

        // 1) MATCH: usa identificadores disponíveis
        if (domain || name || url || linkedin_url) {
          const matchBody = {
            request_context: {},
            businesses_to_match: [
              {
                ...(name ? { name } : {}),
                ...(domain ? { domain } : {}),
                ...(url ? { url } : {}),
                ...(linkedin_url ? { linkedin_url } : {}),
              },
            ],
          };

          const matchResp = await fetch(matchUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(matchBody),
          });

          if (matchResp.ok) {
            const matchJson = await matchResp.json();
            businessId =
              matchJson?.results?.[0]?.business_id ??
              matchJson?.businesses?.[0]?.business_id ??
              matchJson?.businesses_matched?.[0]?.business_id ??
              null;
          } else {
            console.warn(`Explorium match failed: ${matchResp.status}`);
          }
        }

        // 2) FETCH: usa business_id se disponível
        if (businessId) {
          const fetchBody = {
            request_context: {},
            mode: 'full',
            size: 1,
            page_size: 1,
            page: 1,
            exclude: [],
            filters: { business_id: { values: [businessId] } },
          };

          const fetchResp = await fetch(fetchUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(fetchBody),
          });

          if (fetchResp.ok) {
            const fetchJson = await fetchResp.json();
            const record =
              fetchJson?.results?.[0] ??
              fetchJson?.businesses?.[0] ??
              fetchJson?.data?.[0] ??
              null;

            if (record) {
              return {
                company_name: record.name ?? name ?? domain ?? '',
                company_domain: record.domain ?? domain ?? '',
                company_industry:
                  record.industry ?? record.linkedin_industry ?? 'unknown',
                company_country:
                  record.country_code ?? record.country ?? 'unknown',
                company_competitors:
                  record.competitors ??
                  record.top_competitors ??
                  ([] as string[]),
              };
            }
          } else {
            console.warn(`Explorium fetch failed: ${fetchResp.status}`);
          }
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
        console.error('Explorium integration error:', err);
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
