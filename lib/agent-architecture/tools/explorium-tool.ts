import { z } from 'zod';

export function createExploriumTool(exploriumApiKey: string) {
  return {
    name: 'explorium_enrich',
    description: 'Enrich a company using Explorium API',
    parameters: z.object({
      domain: z.string().describe('The domain of the company to enrich.'),
    }),
    execute: async ({ domain }: { domain: string }) => {
      const url = 'https://api.explorium.ai/v2/enrich/company';
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': exploriumApiKey,
        },
        body: JSON.stringify({
          domain,
          data: [
            'company_name',
            'company_domain',
            'company_industry',
            'company_country',
            'company_competitors'
          ],
        }),
      };

      try {
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(`Explorium API request failed with status ${response.status}`);
        }
        const data = await response.json();
        return data;
      } catch (error) {
        console.error('Error enriching company with Explorium:', error);
        throw error;
      }
    },
  };
}
