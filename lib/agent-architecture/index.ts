import { AgentOrchestrator } from './orchestrator';

export { AgentOrchestrator } from './orchestrator';
export * from './core/types';

// Factory function for easy initialization
export function createAgentOrchestrator(
  apolloApiKey: string,
  openaiApiKey: string,
  azureEndpoint: string,
  azureDeployment: string,
  azureApiVersion: string,
  snovCredentials?: { clientId?: string; clientSecret?: string; apiKey?: string }
) {
  return new AgentOrchestrator(
    apolloApiKey,
    openaiApiKey,
    azureEndpoint,
    azureDeployment,
    azureApiVersion,
    snovCredentials
  );
}
