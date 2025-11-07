import { AgentOrchestrator } from './orchestrator';

export { AgentOrchestrator } from './orchestrator';
export * from './core/types';

// Factory function for easy initialization
export function createAgentOrchestrator(
  exploriumApiKey: string,
  openaiApiKey: string,
  azureEndpoint: string,
  azureDeployment: string,
  azureApiVersion: string
) {
  return new AgentOrchestrator(
    exploriumApiKey,
    openaiApiKey,
    azureEndpoint,
    azureDeployment,
    azureApiVersion
  );
}