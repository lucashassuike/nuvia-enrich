import { RowEnrichmentResult } from './core/types';
import { EnrichmentField, EnrichmentResult } from '../types';
import { OpenAIService } from '../services/openai';
import { SpecializedAgentService } from '../services/specialized-agents';
import { runDiscoveryAgent } from './agents/discovery-agent';

export class AgentOrchestrator {
  private openai: OpenAIService;
  private specialized: SpecializedAgentService;

  constructor(
    private exploriumApiKey: string,
    private openaiApiKey: string,
    private azureEndpoint: string,
    private azureDeployment: string,
    private azureApiVersion: string
  ) {
    this.openai = new OpenAIService(openaiApiKey, azureEndpoint, azureDeployment, azureApiVersion);
    this.specialized = new SpecializedAgentService(openaiApiKey, this.openai);
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
      if (onAgentProgress) onAgentProgress('Starting discovery', 'agent');

      // Extração de possíveis colunas (melhora o match no Explorium)
      const nameCandidates = ['_name','name','company','company_name','account','account_name','organization','org','empresa'];
      const linkedinCandidates = ['linkedin','linkedin_url','company_linkedin','linkedin_company_url'];
      const urlCandidates = ['website','url','company_url','site'];

      const name = nameCandidates.map(k => row[k]).find(v => typeof v === 'string' && v.trim().length > 0);
      const linkedin_url = linkedinCandidates.map(k => row[k]).find(v => typeof v === 'string' && v.trim().length > 0);
      const url = urlCandidates.map(k => row[k]).find(v => typeof v === 'string' && v.trim().length > 0);

      const agentResult = await runDiscoveryAgent(
        email,
        this.exploriumApiKey,
        this.openai,
        { name, linkedin_url, url }
      );

      if (onAgentProgress) onAgentProgress('Discovery completed', 'success');

      const companyAnalysis = agentResult.company_analysis;

      // Helper: detect executive-related fields
      const isExecutiveField = (field: EnrichmentField): boolean => {
        const name = field.name.toLowerCase();
        const desc = field.description.toLowerCase();
        const titles = ['ceo', 'cto', 'cfo', 'coo', 'cmo', 'cpo', 'chief', 'founder', 'president', 'director', 'executive'];
        return titles.some(t => name.includes(t) || desc.includes(t));
      };

      // Helper to infer industry based on signals and text
      const inferIndustry = (analysis: any): string => {
        try {
          const texts: string[] = [];
          if (typeof analysis.company_name === 'string') texts.push(analysis.company_name);
          if (typeof analysis.key_insights === 'string') texts.push(analysis.key_insights);
          if (Array.isArray(analysis.priority_signals)) {
            for (const s of analysis.priority_signals) {
              if (typeof s?.title === 'string') texts.push(s.title);
              if (typeof s?.description === 'string') texts.push(s.description);
            }
          }
          const blob = texts.join(' ').toLowerCase();
          const keywords: Array<[string, string]> = [
            ['saas', 'SaaS'],
            ['crm', 'CRM'],
            ['email', 'Sales Tech'],
            ['outbound', 'Sales Tech'],
            ['marketing', 'Marketing Tech'],
            [' ai', 'AI'],
            ['ai ', 'AI'],
            ['machine learning', 'AI'],
            ['analytics', 'Data & Analytics'],
            ['data', 'Data & Analytics'],
            ['security', 'Security'],
            ['cyber', 'Security'],
            ['fintech', 'Fintech'],
            ['payment', 'Fintech'],
            ['ecommerce', 'E-commerce'],
            ['e-commerce', 'E-commerce'],
            ['health', 'Healthcare'],
            ['med', 'Healthcare'],
            ['edtech', 'Edtech'],
            ['education', 'Edtech'],
          ];
          for (const [kw, label] of keywords) {
            if (blob.includes(kw)) return label;
          }
          return 'unknown';
        } catch {
          return 'unknown';
        }
      };

      // Derived mapping available for common field names
      const derived: Record<string, unknown> = {
        companyName: companyAnalysis.company_name,
        companyDescription: companyAnalysis.key_insights,
        industry: inferIndustry(companyAnalysis),
        keyInsights: companyAnalysis.key_insights,
        signalStrength: companyAnalysis.overall_signal_strength,
        signalsFound: companyAnalysis.total_signals_found,
        signalsByCategory: companyAnalysis.signals_by_category,
        personalizationHooks: companyAnalysis.personalization_hooks,
        searchDate: companyAnalysis.search_date,
        dataFreshness: companyAnalysis.data_freshness,
        prioritySignals: companyAnalysis.priority_signals,
      };

      // If executive fields are requested, run People Agent once and prepare mappings
      let peopleOutput: any | null = null;
      const requestedExecutiveFields = fields.filter(isExecutiveField);
      if (requestedExecutiveFields.length > 0) {
        try {
          if (onAgentProgress) onAgentProgress('Searching leadership (CEO, founders, execs)', 'agent');
          const peopleAgent = this.specialized.getPeopleAgent();
          const companyName = (companyAnalysis.company_name as string) || name || '';
          const domain = (email.split('@')[1]) || '';
          const ctx = {
            companyName,
            domain,
            // Use row-derived values; company_analysis does not include website/linkedin_url
            website: (url as string) || '',
            linkedin: (linkedin_url as string) || '',
            email,
          };
          const res = await peopleAgent.run(`Find leadership info (CEO, founders, key executives) for ${companyName || domain}. Return names and LinkedIn URLs when available.`, {
            apiKey: this.openaiApiKey,
            context: ctx,
          } as any);
          peopleOutput = (res as any)?.finalOutput ?? null;
          if (onAgentProgress) onAgentProgress('Leadership search completed', 'success');
        } catch (err) {
          console.warn('[Orchestrator] People Agent failed:', err);
          if (onAgentProgress) onAgentProgress('Leadership search failed', 'warning');
        }
      }

      const enrichments: Record<string, EnrichmentResult> = {};

      // Helper: map people agent output to requested executive fields
      const mapExecutiveField = (field: EnrichmentField): { value?: unknown; confidence?: number; sources?: string[] } => {
        if (!peopleOutput) return {};
        const nameLower = field.name.toLowerCase();
        const descLower = field.description.toLowerCase();
        const wantsLinkedin = nameLower.includes('linkedin') || descLower.includes('linkedin') || nameLower.includes('link');

        // CEO mapping
        if (nameLower.includes('ceo')) {
          const ceo = peopleOutput?.ceo;
          const value = wantsLinkedin ? ceo?.linkedin : ceo?.name;
          const confidence = (peopleOutput?.confidence?.ceo as number) ?? 0.85;
          const sources = Array.isArray(peopleOutput?.sources) ? (peopleOutput.sources as string[]) : [];
          return { value, confidence, sources };
        }

        // Founder(s) mapping
        if (nameLower.includes('founder')) {
          const founders = Array.isArray(peopleOutput?.founders) ? peopleOutput.founders : [];
          let value: unknown = undefined;
          if (wantsLinkedin) {
            const links = founders.map((f: any) => f?.linkedin).filter((x: any) => typeof x === 'string' && x);
            value = field.type === 'array' ? links : links.join(', ');
          } else {
            const names = founders.map((f: any) => f?.name).filter((x: any) => typeof x === 'string' && x);
            value = field.type === 'array' ? names : names.join(', ');
          }
          const confidence = (peopleOutput?.confidence?.founders as number) ?? 0.8;
          const sources = Array.isArray(peopleOutput?.sources) ? (peopleOutput.sources as string[]) : [];
          return { value, confidence, sources };
        }

        // Key executives mapping
        if (nameLower.includes('executive') || nameLower.includes('leadership')) {
          const execs = Array.isArray(peopleOutput?.keyExecutives) ? peopleOutput.keyExecutives : [];
          let value: unknown = undefined;
          if (wantsLinkedin) {
            const links = execs.map((e: any) => e?.linkedin).filter((x: any) => typeof x === 'string' && x);
            value = field.type === 'array' ? links : links.join(', ');
          } else {
            const names = execs.map((e: any) => e?.name).filter((x: any) => typeof x === 'string' && x);
            value = field.type === 'array' ? names : names.join(', ');
          }
          const confidence = 0.75;
          const sources = Array.isArray(peopleOutput?.sources) ? (peopleOutput.sources as string[]) : [];
          return { value, confidence, sources };
        }

        return {};
      };
      const normalizeValue = (
        v: unknown
      ): string | number | boolean | string[] | undefined => {
        if (v === null || v === undefined) return undefined;
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') return v as any;
        if (Array.isArray(v)) {
          // If array of strings, keep; otherwise stringify each element
          if (v.every(x => typeof x === 'string')) return v as string[];
          return v.map(x => {
            if (typeof x === 'string') return x;
            if (x && typeof x === 'object') {
              // Special-case signals: prefer title
              const maybeTitle = (x as any).title;
              if (typeof maybeTitle === 'string') return maybeTitle;
            }
            try {
              return JSON.stringify(x);
            } catch {
              return String(x);
            }
          });
        }
        // Objects: stringify
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      };

      for (const field of fields) {
        let value: unknown = undefined;

        // 1) Direct property inside company_analysis
        if (Object.prototype.hasOwnProperty.call(companyAnalysis, field.name)) {
          value = (companyAnalysis as any)[field.name];
        }

        // 2) Derived mapping for common names
        if (value === undefined && Object.prototype.hasOwnProperty.call(derived, field.name)) {
          value = derived[field.name];
        }

        // 3) Alias mapping for normalized variations (lowercase, sem espaços/underscores) e PT-BR
        if (value === undefined) {
          const normalized = field.name
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .replace(/[^a-z0-9]/g, '');
          const aliasMap: Record<string, string> = {
            // English/camel variations
            companyname: 'companyName',
            companydescription: 'companyDescription',
            industry: 'industry',
            keyinsights: 'keyInsights',
            signalstrength: 'signalStrength',
            signalsfound: 'signalsFound',
            personalizationhooks: 'personalizationHooks',
            signalsbycategory: 'signalsByCategory',
            prioritysignals: 'prioritySignals',
            searchdate: 'searchDate',
            datafreshness: 'dataFreshness',

            // Portuguese aliases (normalized without spaces/accents)
            empresa: 'companyName',
            nomeempresa: 'companyName',
            nomedaempresa: 'companyName',
            descricao: 'companyDescription',
            descricaoempresa: 'companyDescription',
            descricaodaempresa: 'companyDescription',
            industria: 'industry',
            setor: 'industry',
            segmento: 'industry',
            forcadosinal: 'signalStrength',
            forcasinal: 'signalStrength',
            intensidadesinal: 'signalStrength',
            sinaisencontrados: 'signalsFound',
            totalsinais: 'signalsFound',
            ganchospersonalizacao: 'personalizationHooks',
            personalizacaoganchos: 'personalizationHooks',
            sinaisporcategoria: 'signalsByCategory',
            categoriassinais: 'signalsByCategory',
            sinaisprioritarios: 'prioritySignals',
            topsinais: 'prioritySignals',
            datapesquisa: 'searchDate',
            databusca: 'searchDate',
            recenciadados: 'dataFreshness',
            freshnessdados: 'dataFreshness',
          };
          const alias = aliasMap[normalized];
          if (alias && Object.prototype.hasOwnProperty.call(derived, alias)) {
            value = derived[alias];
          }
        }

        // 4) Executive fields mapped via People Agent, if available
        if (value === undefined && requestedExecutiveFields.some(f => f.name === field.name)) {
          const mapped = mapExecutiveField(field);
          if (mapped.value !== undefined) {
            const normalizedExec = normalizeValue(mapped.value);
            if (normalizedExec !== undefined) {
              enrichments[field.name] = {
                field: field.name,
                value: normalizedExec,
                confidence: typeof mapped.confidence === 'number' ? mapped.confidence : 0.8,
                source: 'Web research',
                sourceContext: [],
                sourceCount: Array.isArray(mapped.sources) ? mapped.sources.length : undefined,
              };
              continue; // done with this field
            }
          }
        }

        const normalized = normalizeValue(value);
        if (normalized !== undefined) {
          enrichments[field.name] = {
            field: field.name,
            value: normalized,
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