import { z } from 'zod';

/**
 * Apify LinkedIn Post Scraper tool integration
 * Actor: supreme_coder~linkedin-post
 * API docs in apify-doc.md
 */
const ApifyInput = z.object({
  urls: z.array(z.string()).min(1),
  limitPerSource: z.number().optional(),
  scrapeUntil: z.string().optional(),
  deepScrape: z.boolean().optional().default(true),
  rawData: z.boolean().optional().default(false),
});

export type ApifyInput = z.infer<typeof ApifyInput>;

export interface LinkedinPost {
  post_url: string;
  text?: string;
  publishedAt?: string; // ISO date
  likes?: number;
  comments?: number;
  reshares?: number;
  author?: string;
  profile_url?: string;
  engagement_total?: number;
  raw?: Record<string, unknown>;
}

export function createApifyLinkedinPostsTool(apifyToken?: string) {
  const token = apifyToken || process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || '';
  return {
    name: 'apify_linkedin_posts',
    description: 'Fetch recent LinkedIn posts using Apify actor supreme_coder~linkedin-post',
    parameters: ApifyInput,
    execute: async (input: ApifyInput): Promise<{ items: LinkedinPost[]; sourceCount: number }> => {
      if (!token) {
        console.warn('[Apify] Missing API token. Skipping LinkedIn posts enrichment.');
        return { items: [], sourceCount: 0 };
      }

      const body = {
        urls: input.urls,
        ...(input.limitPerSource ? { limitPerSource: input.limitPerSource } : {}),
        ...(input.scrapeUntil ? { scrapeUntil: input.scrapeUntil } : {}),
        deepScrape: input.deepScrape ?? true,
        rawData: input.rawData ?? false,
      };

      try {
        const endpoint = `https://api.apify.com/v2/acts/supreme_coder~linkedin-post/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          console.warn('[Apify] Non-OK response:', resp.status, resp.statusText);
          return { items: [], sourceCount: input.urls.length };
        }
        const json = await resp.json();
        const arr: any[] = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];

        const items: LinkedinPost[] = arr.map((it) => {
          const post_url: string = it.url || it.post_url || it.postUrl || '';
          const text: string | undefined = it.text || it.content || it.body || undefined;
          const publishedAt: string | undefined = it.publishedAt || it.date || it.published_time || undefined;
          const likes: number | undefined = typeof it.likes === 'number' ? it.likes : (typeof it.likeCount === 'number' ? it.likeCount : undefined);
          const comments: number | undefined = typeof it.comments === 'number' ? it.comments : (typeof it.commentCount === 'number' ? it.commentCount : undefined);
          const reshares: number | undefined = typeof it.reshares === 'number' ? it.reshares : (typeof it.shareCount === 'number' ? it.shareCount : undefined);
          const author: string | undefined = it.author || it.username || it.profileName || undefined;
          const profile_url: string | undefined = it.profileUrl || it.profile_url || undefined;
          const engagement_total: number | undefined = [likes, comments, reshares].filter((x) => typeof x === 'number').reduce((a, b) => a + (b as number), 0);
          return { post_url, text, publishedAt, likes, comments, reshares, author, profile_url, engagement_total, raw: it };
        }).filter((p) => p.post_url);

        console.log(`[Apify] Retrieved ${items.length} LinkedIn posts from ${input.urls.length} source URL(s).`);
        return { items, sourceCount: input.urls.length };
      } catch (err) {
        console.error('[Apify] Error calling actor:', err);
        return { items: [], sourceCount: input.urls.length };
      }
    },
  };
}