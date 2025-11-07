import { AgentOrchestrator } from '../agent-architecture';
import type { CSVRow, EnrichmentField, RowEnrichmentResult, EnrichmentResult } from '../types';
import { shouldSkipEmail, loadSkipList, getSkipReason } from '../utils/skip-list';

export class AgentEnrichmentStrategy {
  private orchestrator: AgentOrchestrator;
  // Cache por domínio para reutilizar enriquecimentos de mesma empresa
  private domainCache: Map<string, Record<string, EnrichmentResult>> = new Map();
  
  constructor(
    openaiApiKey: string,
    exploriumApiKey: string,
    azureEndpoint: string,
    azureDeployment: string,
    azureApiVersion: string
  ) {
    this.orchestrator = new AgentOrchestrator(exploriumApiKey, openaiApiKey, azureEndpoint, azureDeployment, azureApiVersion);
  }
  
  async enrichRow(
    row: CSVRow,
    fields: EnrichmentField[],
    emailColumn: string,
    onProgress?: (field: string, value: unknown) => void,
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<RowEnrichmentResult> {
    const email = row[emailColumn];
    // Preferir company_domain como chave primária; fallback para domínio do email
    const explicitDomain = (row['company_domain'] || row['domain'] || '').toString().trim().toLowerCase();
    const emailDomain = typeof email === 'string' && email.includes('@') ? email.split('@')[1].toLowerCase() : '';
    const primaryDomain = (explicitDomain || emailDomain || '').replace(/^www\./, '');
    console.log(`[AgentEnrichmentStrategy] Starting enrichment for email: ${email}`);
    console.log(`[AgentEnrichmentStrategy] Requested fields: ${fields.map(f => f.name).join(', ')}`);
    
    if (!email) {
      console.log(`[AgentEnrichmentStrategy] No email found in column: ${emailColumn}`);
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'error',
        error: 'No email found in specified column',
      };
    }
    
    // Check skip list
    const skipList = await loadSkipList();
    if (shouldSkipEmail(email, skipList)) {
      const skipReason = getSkipReason(email, skipList);
      console.log(`[AgentEnrichmentStrategy] Skipping email ${email}: ${skipReason}`);
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'skipped',
        error: skipReason,
      };
    }
    
    try {
      // Cache: se já temos enriquecimento para o domínio, reutiliza
      const domain = primaryDomain;
      if (domain && this.domainCache.has(domain)) {
        const cached = this.domainCache.get(domain)!;
        const filteredEnrichments: Record<string, EnrichmentResult> = {};
        for (const [key, enrichment] of Object.entries(cached)) {
          if (enrichment.value !== null) {
            filteredEnrichments[key] = enrichment as EnrichmentResult;
          }
        }
        const enrichedCount = Object.keys(filteredEnrichments).length;
        console.log(`[AgentEnrichmentStrategy] Cache hit for domain ${domain}. Returning ${enrichedCount} fields.`);
        if (onAgentProgress) onAgentProgress(`Cache hit (${domain}): ${enrichedCount} campos`, 'success');
        return {
          rowIndex: 0,
          originalData: row,
          enrichments: filteredEnrichments,
          status: 'completed',
        };
      }

      console.log(`[AgentEnrichmentStrategy] Delegating to AgentOrchestrator`);
      // Use the agent orchestrator for enrichment
      const result = await this.orchestrator.enrichRow(
        row,
        fields,
        emailColumn,
        onProgress,
        onAgentProgress
      );
      
      // Filter out null values to match the expected type
      const filteredEnrichments: Record<string, EnrichmentResult> = {};
      for (const [key, enrichment] of Object.entries(result.enrichments)) {
        if (enrichment.value !== null) {
          filteredEnrichments[key] = enrichment as EnrichmentResult;
        }
      }
      
      const enrichedCount = Object.keys(filteredEnrichments).length;
      console.log(`[AgentEnrichmentStrategy] Orchestrator returned ${enrichedCount} enriched fields`);

      // Armazena no cache por domínio (se disponível)
      if (domain) {
        this.domainCache.set(domain, filteredEnrichments);
        console.log(`[AgentEnrichmentStrategy] Cached enrichment for domain ${domain}`);
      }

      return {
        ...result,
        enrichments: filteredEnrichments
      };
    } catch (error) {
      console.error('[AgentEnrichmentStrategy] Enrichment error:', error);
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}