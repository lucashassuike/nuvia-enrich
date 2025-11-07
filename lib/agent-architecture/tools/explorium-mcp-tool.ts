import { z } from 'zod';

/**
 * Explorium MCP Tool
 *
 * This tool communicates with the Explorium MCP server using HTTP.
 * It mirrors the interface of the existing REST tool but routes the request
 * through the MCP endpoint so we can take advantage of MCP-managed tools.
 */
export function createExploriumMCPTool() {
  return {
    name: 'explorium_mcp_enrich',
    description: 'Enrich a company using Explorium MCP server',
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
      const mcpUrl =
        process.env.EXPLORIUM_MCP_URL || 'https://mcp.explorium.ai/mcp';
      const apiKey = process.env.EXPLORIUM_API_KEY;
      const toolName = process.env.EXPLORIUM_MCP_TOOL_NAME || 'enrich_company';

      // The public MCP endpoint supports HTTP requests that encapsulate tool calls.
      // We will call a generic `enrich_company` tool exposed by the server.
      // If the server changes, this stays resilient by passing optional identifiers.

      try {
        // Build common arguments
        const args = {
          ...(name ? { name } : {}),
          ...(domain ? { domain } : {}),
          ...(url ? { url } : {}),
          ...(linkedin_url ? { linkedin_url } : {}),
        };

        // 1) Try direct HTTP POST (streamable-http style) without JSON-RPC wrapper
        const directBody = { name: toolName, arguments: args };

        const makeHeaders = (accept: string) => ({
          'Content-Type': 'application/json',
          Accept: accept,
          'X-MCP-Mode': 'streamable-http',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
          ...(apiKey ? { api_key: apiKey } : {}),
        });

        const candidateUrls = [
          mcpUrl,
          // Common alternative path for MCP tools call
          mcpUrl.endsWith('/mcp') ? mcpUrl.replace(/\/mcp$/, '/tools/call') : `${mcpUrl}/tools/call`,
        ];

        let resp: Response | null = null;
        for (const urlCandidate of candidateUrls) {
          // First try allowing SSE or JSON
          resp = await fetch(urlCandidate, {
            method: 'POST',
            headers: makeHeaders('application/json, text/event-stream'),
            body: JSON.stringify(directBody),
          });
          if (resp.ok) break;
          // If 406 Not Acceptable, try strict JSON only
          if (resp.status === 406) {
            resp = await fetch(urlCandidate, {
              method: 'POST',
              headers: makeHeaders('application/json'),
              body: JSON.stringify(directBody),
            });
            if (resp.ok) break;
          }
        }

        // 2) If direct POST failed, fall back to JSON-RPC 2.0
        if (!resp || !resp.ok) {
          const rpcBody = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: args,
            },
          };

          resp = await fetch(mcpUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              ...(apiKey ? { 'X-API-Key': apiKey } : {}),
              ...(apiKey ? { api_key: apiKey } : {}),
            },
            body: JSON.stringify(rpcBody),
          });
        }

        if (!resp || !resp.ok) {
          console.warn(`Explorium MCP call failed: ${resp ? resp.status : 'no-response'}`);
          return {
            company_name: name ?? domain ?? '',
            company_domain: domain ?? '',
            company_industry: 'unknown',
            company_country: 'unknown',
            company_competitors: [],
          };
        }

        const contentType = resp.headers.get('content-type') || '';
        let data: any = null;

        if (contentType.includes('text/event-stream')) {
          // Parse SSE stream; extract last data: line as JSON if possible
          const text = await resp.text();
          const lines = text.split(/\r?\n/);
          const dataLines = lines.filter(l => l.startsWith('data:'));
          const last = dataLines.length > 0 ? dataLines[dataLines.length - 1].replace(/^data:\s*/, '') : '';
          try {
            data = last ? JSON.parse(last) : null;
          } catch {
            data = null;
          }
        } else if (contentType.includes('application/json')) {
          data = await resp.json();
        } else {
          // Fallback: try text then parse JSON
          const text = await resp.text();
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
        }

        // Normalize possible MCP responses
        let record: any = null;

        // If JSON-RPC shape
        const rpcResult = data?.result ?? data?.results;
        if (rpcResult?.content && Array.isArray(rpcResult.content)) {
          for (const item of rpcResult.content) {
            if (item?.type === 'json' && item?.data) {
              record = item.data;
              break;
            }
            if (!record && item?.type === 'text' && typeof item?.text === 'string') {
              const txt = item.text.trim();
              if ((txt.startsWith('{') && txt.endsWith('}')) || (txt.startsWith('[') && txt.endsWith(']'))) {
                try {
                  record = JSON.parse(txt);
                  break;
                } catch {}
              }
            }
          }
        }

        if (!record && rpcResult?.data) {
          record = rpcResult.data;
        }
        if (!record && data?.data) {
          record = Array.isArray(data.data) ? data.data[0] : data.data;
        }
        if (!record && data?.company) {
          record = data.company;
        }
        if (!record) {
          record = data ?? null;
        }

        return {
          company_name: record?.name ?? name ?? domain ?? '',
          company_domain: record?.domain ?? domain ?? '',
          company_industry:
            record?.industry ?? record?.linkedin_industry ?? 'unknown',
          company_country: record?.country_code ?? record?.country ?? 'unknown',
          company_competitors:
            record?.competitors ?? record?.top_competitors ?? ([] as string[]),
        };
      } catch (err) {
        console.error('Explorium MCP integration error:', err);
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