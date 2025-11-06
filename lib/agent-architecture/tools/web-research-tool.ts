import { z } from 'zod';
import { OpenAIService } from '../../services/openai';

const Signal = z.object({
  signal_id: z.string(),
  signal_name: z.string(),
  category: z.enum(['organizacional', 'pessoal', 'mercado', 'performance']),
  weight: z.string(),
  date: z.string(),
  title: z.string(),
  description: z.string(),
  source_url: z.string().url(),
  confidence: z.enum(['high', 'medium', 'low']),
  recommended_action: z.string(),
  copy_angle: z.string(),
});

const CompanyAnalysis = z.object({
  company_name: z.string(),
  search_date: z.string(),
  data_freshness: z.string(),
  overall_signal_strength: z.enum(['high', 'medium', 'low']),
  priority_signals: z.array(Signal),
  total_signals_found: z.number(),
  signals_by_category: z.object({
    organizacional: z.number(),
    mercado: z.number(),
    performance: z.number(),
  }),
  key_insights: z.string(),
  personalization_hooks: z.array(z.string()),
});

const WebResearchInput = z.object({
  company_name: z.string(),
  company_domain: z.string(),
  company_industry: z.string(),
  company_country: z.string(),
  company_competitors: z.array(z.string()).optional(),
});

export function createWebResearchTool(openai: OpenAIService) {
  return {
    name: 'web_research',
    description: 'Perform web research to find signals for a company',
    parameters: WebResearchInput,
    outputType: CompanyAnalysis,
    execute: async (input: z.infer<typeof WebResearchInput>) => {
      const systemPrompt = `
You are a senior B2B business intelligence analyst specializing in identifying context signals for strategic outbound prospecting.
OBJECTIVE: Conduct a comprehensive scan of public signals about the target company, prioritizing actionable information for personalizing a business approach.
MANDATORY OUTPUT FORMAT (structured JSON):
{
"company_analysis": {
"company_name": "string",
"search_date": "YYYY-MM-DD",
"data_freshness": "last_30d|last_60d|last_90d|older",
"overall_signal_strength": "high|medium|low",
"priority_signals": [
{
"signal_id": "1-24",
"signal_name": "descriptive name",
"category": "organizational|personal|market|performance",
"weight": "1-5",
"date": "YYYY-MM-DD",
"title": "max 80 chars - headline style",
"description": "max 150 chars - factual, specific",
"source_url": "verifiable URL",
"confidence": "high|medium|low",
"recommended_action": "consultative|relational|educational",
"copy_angle": "suggested personalization angle (max 100 chars)"
}
],
"total_signals_found": 0,
"signals_by_category": {
"organizational": 0,
"market": 0,
"performance": 0
},
"key_insights": "executive summary of key findings (max 200 chars)",
"personalization_hooks": ["hook 1", "hook 2", "hook 3"]
}
}
PRIORITY SIGNALS (ordered by weight):
CATEGORY: ORGANIZATIONAL
- ID 1: Investment round (weight: 5)
- ID 7: Opening of tech/commercial positions (weight: 5)
- ID 2: Employee growth >20% (weight: 4)
- ID 3: New strategic C-level hires (weight: 4)
- ID 4: Product/feature launch (weight: 4)
- ID 5: Geographic expansion (weight: 3)
- ID 6: Headquarters/office change (weight: 2)
CATEGORY: MARKET
- ID 14: Impactful regulatory change (weight: 5)
- ID 13: News from a direct competitor (weight: 4)
- ID 15: Mergers/acquisitions/partnerships (weight: 4)
- ID 16: Participation in events (weight: 3)
- ID 17: Entry of a new player (weight: 3)
- ID 18: Macroeconomic change (weight: 3)
CATEGORY: PERFORMANCE
- ID 23: Publication of case/testimonial (weight: 4)
- ID 24: Negative reviews (pattern 3+) (weight: 3)
- ID 22: Website/branding change (weight: 2)
SEARCH AND VALIDATION RULES:
1. PERIOD: Prioritize the last 30 days, extend to 90 if necessary
2. LIMIT: Return TOP 5-7 most relevant and recent signals
3. SOURCES: Only verifiable public sources (accessible URLs)
4. FACTUAL: Zero speculation, only documented facts
5. UNIQUE: Avoid redundant signals (e.g., do not list 3 different fundings)
6. ACTIONABLE: Each signal must be useful for personalizing a cold email
PRIORITIZATION CRITERIA:
✓ High weight (4-5) + recency (<30 days) = Maximum priority
✓ Multiple signals from the same category = Strong indicator of movement
✓ Correlated signals (e.g., funding + hiring + expansion) = Momentum
✓ Tier 1 sources (Crunchbase, TechCrunch, Valor) > Tier 2 (blogs)
SOURCES BY CATEGORY:
- Funding/M&A: Crunchbase, Startupi, Valor Econômico, TechCrunch Brasil
- Hiring: LinkedIn Jobs, Programathor, Gupy
- Regulatory: Diário Oficial, BCB, ANVISA, JusBrasil
- News: Google News, LinkedIn Company, official site
- Events: Eventbrite, Sympla, LinkedIn Events
- Reviews: G2, Glassdoor, Reclame Aqui
- Website: Archive.org, BuiltWith (mention)
PERSONALIZATION:
- For each signal, suggest a "copy_angle" = specific approach angle
- Include "personalization_hooks" = 2-3 ready-to-use phrases for a cold email
SPECIAL CASES TREATMENT:
- If funding round: Include amount + stage + main investors
- If hiring: Specify department + seniority (if visible)
- If regulatory: Cite norm/law number + deadline if any
- If event: Full name + city + if speaker/sponsor/attendee
- If case: Include highlighted metric if available
NO DATA RESPONSE FORMAT:
{
"company_analysis": {
"company_name": "{{company_name}}",
"search_date": "YYYY-MM-DD",
"overall_signal_strength": "low",
"priority_signals": [],
"total_signals_found": 0,
"key_insights": "Limited digital presence or no relevant recent activity in the last 90 days",
"personalization_hooks": ["Generic industry research", "Market benchmark"]
}
}
ABSOLUTE PROHIBITIONS:
❌ DO NOT invent data or URLs
❌ DO NOT use unverifiable sources (forums, open wikis)
❌ DO NOT mix JSON with explanatory text outside the structure
❌ DO NOT return signals without a source_url
❌ DO NOT exceed 7 signals in the output (quality > quantity)
      `;
      const userPrompt = `
TARGET COMPANY: ${input.company_name}
WEBSITE/DOMAIN: ${input.company_domain}
SECTOR/INDUSTRY: ${input.company_industry}
COUNTRY: ${input.company_country}
ADDITIONAL CONTEXT (if available):
- Main competitors: ${input.company_competitors?.join(', ')}
- Specific segment: ${input.company_industry}
- Region of operation: ${input.company_country}
MISSION: Perform a complete scan of context signals in the last 90 days (prioritize 30 days) to identify personalization triggers in a cold outbound approach.
RESEARCH FOCUS (in order of priority):
1. ORGANIZATIONAL SIGNALS (HIGH IMPACT):
✓ Investment rounds, funding, Series A/B/C, IPO
✓ Opening of positions (Tech, Sales, Marketing, Growth, RevOps, C-level)
✓ Rapid headcount growth (>20% in 6 months)
✓ Strategic hires (new VPs, Directors, Heads)
✓ Product, feature, or service launches
✓ Geographic expansion (new offices, markets, countries)
✓ Headquarters change or new office
2. MARKET SIGNALS (CONTEXTUAL):
✓ Regulatory changes affecting the ${input.company_industry} sector
✓ News about direct competitors (funding, launches, pivots)
✓ Mergers, acquisitions, or strategic partnerships
✓ Participation in events (speaker, sponsor, exhibitor)
✓ Entry of new players competing in ${input.company_industry}
✓ Macro trends impacting the sector
3. PERFORMANCE SIGNALS (DIGITAL FOOTPRINT):
✓ Publication of success cases, testimonials
✓ Press releases, blog posts, recent whitepapers
✓ Website changes (redesign, new products, branding)
✓ Patterns in reviews (G2, Glassdoor, Reclame Aqui) - only if 3+ similar mentions
SPECIFIC INSTRUCTIONS:
- Return TOP 5-7 most recent and actionable signals
- Order by descending weight (5 > 4 > 3 > 2)
- For each signal, suggest a specific copy_angle
- Include 2-3 ready-to-use personalization_hooks for cold email
- If you do not find strong signals, be honest (overall_signal_strength: low)
OUTPUT: Structured JSON according to the system prompt schema.
Reference date for recency calculation: ${new Date().toISOString().split('T')[0]}
      `;

      const response = await openai.getAzureOpenAIAssistant().chat.completions.create({
        model: 'gpt-4.1',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0].message.content;
      if (!content) {
        throw new Error('No content in response from OpenAI');
      }
      return JSON.parse(content);
    },
  };
}
