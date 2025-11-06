import { RowEnrichmentResult } from './core/types';
import { EnrichmentField, EnrichmentResult } from '../types';
import { OpenAIService } from '../services/openai';
import { createDiscoveryAgent } from './agents/discovery-agent';

export class AgentOrchestrator {
  private openai: OpenAIService;
  
  constructor(
    private exploriumApiKey: string,
    private openaiApiKey: string,
    private azureEndpoint: string,
    private azureDeployment: string,
    private azureApiVersion: string
  ) {
    this.openai = new OpenAIService(openaiApiKey, azureEndpoint, azureDeployment, azureApiVersion);
  }
  
  async enrichRow(
    row: Record<string, string>,
    fields: EnrichmentField[],
    emailColumn: string,
    onProgress?: (field: string, value: unknown) => void,
    onAgentProgress?: (message: string, type: 'info' | 'success' | 'warning' | 'agent') => void
  ): Promise<RowEnrichmentResult> {
    const email = row[emailColumn];
    console.log(`[Orchestrator] Starting enrichment for email: ${email}`);
    
    if (!email) {
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: {},
        status: 'error',
        error: 'No email found',
      };
    }
    
    try {
      const discoveryAgent = createDiscoveryAgent(this.exploriumApiKey, this.openai);
      const agentResult = await discoveryAgent.run({
        input: `Enrich the company associated with the email: ${email}`,
        context: {
          onProgress: (message, type) => {
            if (onAgentProgress) {
              onAgentProgress(message, type as 'info' | 'success' | 'warning' | 'agent');
            }
          },
        },
      });

      if (!agentResult) {
        throw new Error('Agent did not return a result');
      }

      const companyAnalysis = (agentResult as any).company_analysis;
      const enrichments: Record<string, EnrichmentResult> = {};

      for (const field of fields) {
        if (companyAnalysis.hasOwnProperty(field.name)) {
          enrichments[field.name] = {
            field: field.name,
            value: companyAnalysis[field.name],
            confidence: 0.9,
            source: 'Multiple sources',
            sourceContext: [],
          };
        }
      }
      
      return {
        rowIndex: 0,
        originalData: row,
        enrichments,
        status: 'completed',
      };
    } catch (error) {
      console.error('Orchestrator error:', error);
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