"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { CSVRow, EnrichmentField, RowEnrichmentResult } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Button from "@/components/shared/button/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { ChatPanel, ChatMessage } from "./chat-panel";
import {
  Download,
  X,
  Copy,
  ExternalLink,
  Globe,
  Mail,
  Check,
  ChevronDown,
  ChevronUp,
  Activity,
  CheckCircle,
  AlertCircle,
  Info,
} from "lucide-react";
import { toast } from "sonner";

interface EnrichmentTableProps {
  rows: CSVRow[];
  fields: EnrichmentField[];
  emailColumn?: string;
}

export function EnrichmentTable({
  rows,
  fields,
  emailColumn,
}: EnrichmentTableProps) {
  const [results, setResults] = useState<Map<number, RowEnrichmentResult>>(
    new Map(),
  );
  const [status, setStatus] = useState<
    "idle" | "processing" | "completed" | "cancelled"
  >("idle");
  const [currentRow, setCurrentRow] = useState(-1);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [useAgents] = useState(true); // Default to using agents
  const [expandedAgentLogs, setExpandedAgentLogs] = useState(false);
  const [selectedRow, setSelectedRow] = useState<{
    isOpen: boolean;
    row: CSVRow | null;
    result: RowEnrichmentResult | undefined;
    index: number;
  }>({ isOpen: false, row: null, result: undefined, index: -1 });
  const [copiedRow, setCopiedRow] = useState<number | null>(null);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(
    new Set(),
  );
  const [showSkipped, setShowSkipped] = useState(false);
  const [agentMessages, setAgentMessages] = useState<ChatMessage[]>([]);
  const [chatQueryId, setChatQueryId] = useState<string | null>(null);
  const [isChatProcessing, setIsChatProcessing] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [isChatExpanded, setIsChatExpanded] = useState(true);
  const agentMessagesEndRef = useRef<HTMLDivElement>(null);
  const activityScrollRef = useRef<HTMLDivElement>(null);

  // Track when each row's data arrives
  const [rowDataArrivalTime, setRowDataArrivalTime] = useState<
    Map<number, number>
  >(new Map());
  const [rowStartTime, setRowStartTime] = useState<Map<number, number>>(new Map());
  const [cellsShown, setCellsShown] = useState<Set<string>>(new Set());
  const animationTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [showMetrics, setShowMetrics] = useState<boolean>(true);

  // Cleanup animation timer on unmount
  useEffect(() => {
    const timer = animationTimerRef.current;
    return () => {
      if (timer) {
        clearInterval(timer);
      }
    };
  }, []);

  // Auto-scroll to bottom when new agent messages arrive
  useEffect(() => {
    if (activityScrollRef.current) {
      activityScrollRef.current.scrollTop =
        activityScrollRef.current.scrollHeight;
    }
  }, [agentMessages]);

  // Calculate animation delay for each cell
  const getCellAnimationDelay = useCallback(
    (rowIndex: number, fieldIndex: number) => {
      const arrivalTime = rowDataArrivalTime.get(rowIndex);
      if (!arrivalTime) return 0; // No delay if no arrival time

      // Reduced animation time for better UX
      const totalRowAnimationTime = 2000; // 2 seconds
      const delayPerCell = Math.min(300, totalRowAnimationTime / fields.length); // Max 300ms per cell

      // Add delay based on field position
      return fieldIndex * delayPerCell;
    },
    [rowDataArrivalTime, fields.length],
  );

  const startEnrichment = useCallback(async () => {
    setStatus("processing");

    try {
      // Client no longer sends API keys; server uses Azure env

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(useAgents && { "x-use-agents": "true" }),
      };

      // No client-provided API keys; rely on server configuration

      const response = await fetch("/api/enrich", {
        method: "POST",
        headers,
        body: JSON.stringify({
          rows,
          fields,
          emailColumn,
          useAgents,
          useV2Architecture: true, // Use new agent architecture when agents are enabled
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to start enrichment");
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response body");
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.substring(6));

              switch (data.type) {
                case "session":
                  setSessionId(data.sessionId);
                  break;

                case "pending":
                  // Mark row as pending (queued but not yet started)
                  setResults((prev) => {
                    const newMap = new Map(prev);
                    if (!newMap.has(data.rowIndex)) {
                      newMap.set(data.rowIndex, {
                        rowIndex: data.rowIndex,
                        originalData: rows[data.rowIndex],
                        enrichments: {},
                        status: 'pending',
                      });
                    }
                    return newMap;
                  });
                  break;

                case "processing":
                  setCurrentRow(data.rowIndex);
                  // Update status to processing
                  setResults((prev) => {
                    const newMap = new Map(prev);
                    const existing = newMap.get(data.rowIndex);
                    if (existing) {
                      newMap.set(data.rowIndex, {
                        ...existing,
                        status: 'processing',
                      });
                    }
                    return newMap;
                  });
                  // Mark row start time
                  setRowStartTime((prevTime) => {
                    const newMap = new Map(prevTime);
                    newMap.set(data.rowIndex, Date.now());
                    return newMap;
                  });
                  break;

                case "result":
                  setResults((prev) => {
                    const newMap = new Map(prev);
                    newMap.set(data.result.rowIndex, data.result);
                    return newMap;
                  });
                  // Track when this row's data arrived
                  setRowDataArrivalTime((prevTime) => {
                    const newMap = new Map(prevTime);
                    newMap.set(data.result.rowIndex, Date.now());
                    return newMap;
                  });

                  // Mark all cells as shown after animation completes
                  setTimeout(() => {
                    const rowCells = fields.map(
                      (f) => `${data.result.rowIndex}-${f.name}`,
                    );
                    setCellsShown((prev) => {
                      const newSet = new Set(prev);
                      rowCells.forEach((cell) => newSet.add(cell));
                      return newSet;
                    });
                  }, 2500); // Slightly after all animations complete
                  break;

                case "complete":
                  setStatus("completed");
                  // Add a final success message (only if not already added)
                  setAgentMessages((prev) => {
                    const hasCompletionMessage = prev.some(
                      (msg) => msg.message === "All enrichment tasks completed successfully"
                    );
                    if (hasCompletionMessage) return prev;

                    return [
                      ...prev,
                      {
                        id: `complete-${Date.now()}`,
                        message: "All enrichment tasks completed successfully",
                        type: "success",
                        timestamp: Date.now(),
                      },
                    ];
                  });
                  break;

                case "cancelled":
                  setStatus("cancelled");
                  break;

                case "error":
                  console.error("Enrichment error:", data.error);
                  setStatus("completed");
                  break;

                case "agent_progress":
                  setAgentMessages((prev) => {
                    const newMessages = [
                      ...prev,
                      {
                        id: `${Date.now()}-${Math.random()}`,
                        message: data.message,
                        type: data.messageType,
                        timestamp: Date.now(),
                        rowIndex: data.rowIndex,
                        sourceUrl: data.sourceUrl, // Include sourceUrl for favicons
                      },
                    ];

                    // Keep messages for all rows, but limit to last 500 total
                    return newMessages.slice(-500);
                  });
                  break;
              }
            } catch {
              // Ignore parsing errors
            }
          }
        }
      }
    } catch (error) {
      console.error("Failed to start enrichment:", error);
      setStatus("completed");
    }
  }, [fields, rows, emailColumn, useAgents]);

  useEffect(() => {
    if (status === "idle") {
      startEnrichment();
    }
  }, [startEnrichment, status]); // Add proper dependencies

  const cancelEnrichment = async () => {
    if (sessionId) {
      try {
        await fetch(`/api/enrich?sessionId=${sessionId}`, {
          method: "DELETE",
        });
      } catch (error) {
        console.error("Failed to cancel enrichment:", error);
      }
      setStatus("cancelled");
      setCurrentRow(-1);
    }
  };

  const downloadCSV = () => {
    // Build headers
    const headers = [
      emailColumn || "email",
      ...fields.map((f) => f.displayName),
      ...fields.map((f) => `${f.displayName}_confidence`),
      ...fields.map((f) => `${f.displayName}_source`),
    ];

    const csvRows = [headers.map((h) => `"${h}"`).join(",")];

    rows.forEach((row, index) => {
      const result = results.get(index);
      const values: string[] = [];

      // Add email
      const email = emailColumn ? row[emailColumn] : Object.values(row)[0];
      values.push(`"${email || ""}"`);

      // Add field values
      fields.forEach((field) => {
        const enrichment = result?.enrichments[field.name];
        const value = enrichment?.value;
        if (value === undefined || value === null) {
          values.push("");
        } else if (Array.isArray(value)) {
          values.push(`"${value.join("; ")}"`);
        } else if (
          typeof value === "string" &&
          (value.includes(",") || value.includes('"') || value.includes("\n"))
        ) {
          values.push(`"${value.replace(/"/g, '""')}"`);
        } else {
          values.push(String(value));
        }
      });

      // Add confidence scores
      fields.forEach((field) => {
        const enrichment = result?.enrichments[field.name];
        values.push(
          enrichment?.confidence ? enrichment.confidence.toFixed(2) : "",
        );
      });

      // Add sources
      fields.forEach((field) => {
        const enrichment = result?.enrichments[field.name];
        if (enrichment?.sourceContext && enrichment.sourceContext.length > 0) {
          const urls = enrichment.sourceContext.map((s) => s.url).join("; ");
          values.push(`"${urls}"`);
        } else if (enrichment?.source) {
          values.push(`"${enrichment.source}"`);
        } else {
          values.push("");
        }
      });

      csvRows.push(values.join(","));
    });

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `enriched_data_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- Metrics Computation ---
  const processedRows = Array.from(results.entries())
    .filter(([, r]) => r.status === 'completed' || r.status === 'processing')
    .map(([index, r]) => ({ index, result: r }));

  const classifySource = (enrichment?: { source?: string; sourceContext?: { url: string }[] }) => {
    if (!enrichment) return 'derived';
    const src = (enrichment.source || '').toLowerCase();
    if (src.includes('explorium')) return 'explorium';
    if (enrichment.sourceContext && enrichment.sourceContext.length > 0) return 'web';
    return 'derived';
  };

  const sourceCounts = { explorium: 0, web: 0, derived: 0 };
  const totalFieldsWithValues = processedRows.reduce((acc, { result }) => {
    let count = 0;
    Object.values(result.enrichments || {}).forEach((enr) => {
      const hasValue = enr && enr.value !== null && enr.value !== undefined && !(Array.isArray(enr.value) && enr.value.length === 0);
      if (hasValue) {
        count += 1;
        const cat = classifySource(enr);
        sourceCounts[cat as keyof typeof sourceCounts] += 1;
      }
    });
    return acc + count;
  }, 0);

  // Cache hits inferred from agent messages
  const cacheHits = agentMessages.filter(m => (m.message || '').toLowerCase().includes('cache hit')).length;

  // Average time per row (ms)
  const avgTimeMs = (() => {
    const deltas: number[] = [];
    processedRows.forEach(({ index }) => {
      const start = rowStartTime.get(index);
      const end = rowDataArrivalTime.get(index);
      if (start && end && end > start) deltas.push(end - start);
    });
    if (deltas.length === 0) return 0;
    return Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);
  })();

  // Domain aggregation
  const getDomainForRow = (row: CSVRow): string => {
    const explicit = (row['company_domain'] || row['domain'] || '').toString().trim().toLowerCase();
    const emailVal = emailColumn ? row[emailColumn] : Object.values(row)[0];
    const emailDom = typeof emailVal === 'string' && emailVal.includes('@') ? emailVal.split('@')[1].toLowerCase() : '';
    const primary = (explicit || emailDom || '').replace(/^www\./, '');
    return primary;
  };

  const domainStats = new Map<string, { rows: number; fields: number; signalsFound: number; strengthScore: number; hooks: number }>();
  processedRows.forEach(({ index, result }) => {
    const domain = getDomainForRow(rows[index]);
    if (!domain) return;
    const prev = domainStats.get(domain) || { rows: 0, fields: 0, signalsFound: 0, strengthScore: 0, hooks: 0 };
    let rowFields = 0;
    let rowSignals = 0;
    let rowStrength = 0;
    let rowHooks = 0;
    Object.entries(result.enrichments || {}).forEach(([key, enr]) => {
      const hasValue = enr && enr.value !== null && enr.value !== undefined && !(Array.isArray(enr.value) && enr.value.length === 0);
      if (hasValue) {
        rowFields += 1;
      }
      if (key.toLowerCase().includes('signalsfound') && typeof enr.value === 'number') {
        rowSignals += Number(enr.value) || 0;
      }
      if (key.toLowerCase().includes('signalstrength') && typeof enr.value === 'string') {
        const val = (enr.value as string).toLowerCase();
        rowStrength += val === 'high' ? 3 : val === 'medium' ? 2 : val === 'low' ? 1 : 0;
      }
      if (key.toLowerCase().includes('personalizationhooks') && Array.isArray(enr.value)) {
        rowHooks += (enr.value as string[]).length > 0 ? 1 : 0;
      }
    });
    domainStats.set(domain, {
      rows: prev.rows + 1,
      fields: prev.fields + rowFields,
      signalsFound: prev.signalsFound + rowSignals,
      strengthScore: prev.strengthScore + rowStrength,
      hooks: prev.hooks + rowHooks,
    });
  });

  const topDomains = Array.from(domainStats.entries())
    .sort((a, b) => b[1].fields - a[1].fields)
    .slice(0, 10);

  const readinessScore = (stats: { rows: number; signalsFound: number; strengthScore: number; hooks: number }) => {
    if (stats.rows === 0) return 0;
    const avgSignals = stats.signalsFound / stats.rows;
    const avgStrength = stats.strengthScore / stats.rows; // 0–3
    const hooksRate = stats.hooks / stats.rows; // 0–1
    // Weighted: signals 40%, strength 40%, hooks 20%
    const score = (Math.min(avgSignals, 5) / 5) * 40 + (Math.min(avgStrength, 3) / 3) * 40 + hooksRate * 20;
    return Math.round(score);
  };

  const sourcePercent = (count: number) => {
    if (totalFieldsWithValues === 0) return 0;
    return Math.round((count / totalFieldsWithValues) * 100);
  };

  // --- Metrics Dashboard UI ---
  const MetricsDashboard = () => (
    <Card className="p-16 mb-16 border-gray-200 bg-white rounded-8">
      <div className="flex items-center justify-between">
        <Label className="text-body-medium font-semibold text-gray-900">Dashboard de Métricas</Label>
        <button className="text-body-small text-gray-700" onClick={() => setShowMetrics(!showMetrics)}>
          {showMetrics ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>
      {showMetrics && (
        <div className="mt-12 space-y-12">
          {/* Stats cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
            <Card className="p-12 bg-gray-50 border-gray-200">
              <p className="text-gray-500 text-body-small">Linhas processadas</p>
              <p className="text-gray-900 text-body-large font-semibold">{processedRows.length} / {rows.length}</p>
            </Card>
            <Card className="p-12 bg-gray-50 border-gray-200">
              <p className="text-gray-500 text-body-small">Cache hits</p>
              <p className="text-gray-900 text-body-large font-semibold">{cacheHits}</p>
            </Card>
            <Card className="p-12 bg-gray-50 border-gray-200">
              <p className="text-gray-500 text-body-small">Tempo médio por linha</p>
              <p className="text-gray-900 text-body-large font-semibold">{avgTimeMs} ms</p>
            </Card>
            <Card className="p-12 bg-gray-50 border-gray-200">
              <p className="text-gray-500 text-body-small">Campos com valor</p>
              <p className="text-gray-900 text-body-large font-semibold">{totalFieldsWithValues}</p>
            </Card>
          </div>

          {/* Source breakdown */}
          <div className="border rounded-6 border-gray-200 p-12">
            <p className="text-body-medium font-semibold text-gray-900 mb-8">Fontes dos dados</p>
            <div className="flex gap-12">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-gray-700">Explorium</span>
                  <span className="text-gray-900 font-semibold">{sourceCounts.explorium} ({sourcePercent(sourceCounts.explorium)}%)</span>
                </div>
                <div className="h-2 w-full bg-gray-100 rounded">
                  <div className="h-2 bg-green-600 rounded" style={{ width: `${sourcePercent(sourceCounts.explorium)}%` }} />
                </div>
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-gray-700">Web Research</span>
                  <span className="text-gray-900 font-semibold">{sourceCounts.web} ({sourcePercent(sourceCounts.web)}%)</span>
                </div>
                <div className="h-2 w-full bg-gray-100 rounded">
                  <div className="h-2 bg-blue-600 rounded" style={{ width: `${sourcePercent(sourceCounts.web)}%` }} />
                </div>
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-gray-700">Derivados/LLM</span>
                  <span className="text-gray-900 font-semibold">{sourceCounts.derived} ({sourcePercent(sourceCounts.derived)}%)</span>
                </div>
                <div className="h-2 w-full bg-gray-100 rounded">
                  <div className="h-2 bg-purple-600 rounded" style={{ width: `${sourcePercent(sourceCounts.derived)}%` }} />
                </div>
              </div>
            </div>
          </div>

          {/* Top domains */}
          <div className="border rounded-6 border-gray-200 p-12">
            <p className="text-body-medium font-semibold text-gray-900 mb-8">Top domains enriquecidos</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-gray-600">
                    <th className="py-2 pr-4">Domain</th>
                    <th className="py-2 pr-4">Linhas</th>
                    <th className="py-2 pr-4">Campos</th>
                    <th className="py-2 pr-4">Sinais</th>
                    <th className="py-2 pr-4">Score prontidão</th>
                  </tr>
                </thead>
                <tbody>
                  {topDomains.map(([dom, stats]) => (
                    <tr key={dom} className="border-t">
                      <td className="py-2 pr-4 text-gray-900">{dom || '-'}</td>
                      <td className="py-2 pr-4">{stats.rows}</td>
                      <td className="py-2 pr-4">{stats.fields}</td>
                      <td className="py-2 pr-4">{stats.signalsFound}</td>
                      <td className="py-2 pr-4 font-semibold">{readinessScore(stats)}</td>
                    </tr>
                  ))}
                  {topDomains.length === 0 && (
                    <tr>
                      <td className="py-2 text-gray-600" colSpan={5}>Sem dados suficientes ainda</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Card>
  );

  const downloadJSON = () => {
    const exportData = {
      metadata: {
        exportDate: new Date().toISOString(),
        totalRows: rows.length,
        processedRows: results.size,
        fields: fields.map((f) => ({
          name: f.name,
          displayName: f.displayName,
          type: f.type,
        })),
        status: status,
      },
      data: rows.map((row, index) => {
        const result = results.get(index);
        const email = emailColumn ? row[emailColumn] : Object.values(row)[0];

        const enrichedRow: Record<string, unknown> = {
          _index: index,
          _email: email,
          _original: row,
          _status: result ? "enriched" : "pending",
        };

        if (result) {
          fields.forEach((field) => {
            const enrichment = result.enrichments[field.name];
            if (enrichment) {
              enrichedRow[field.name] = {
                value: enrichment.value,
                confidence: enrichment.confidence,
                sources:
                  enrichment.sourceContext?.map((s) => s.url) ||
                  (enrichment.source ? enrichment.source.split(", ") : []),
              };
            }
          });
        }

        return enrichedRow;
      }),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `enriched_data_${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadSkippedEmails = () => {
    // Get all skipped rows
    const skippedRows = rows.filter((_, index) => {
      const result = results.get(index);
      return result?.status === "skipped";
    });

    if (skippedRows.length === 0) {
      return;
    }

    // Create CSV header
    const headers = Object.keys(skippedRows[0]);
    const csvRows = [headers.join(",")];

    // Add skipped rows with skip reason
    skippedRows.forEach((row, index) => {
      const originalIndex = rows.findIndex((r) => r === row);
      const result = results.get(originalIndex);
      const values = headers.map((header) => {
        const value = row[header];
        // Escape quotes and wrap in quotes if necessary
        if (
          typeof value === "string" &&
          (value.includes(",") || value.includes('"') || value.includes("\n"))
        ) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value || "";
      });

      // Add skip reason as last column
      if (index === 0) {
        csvRows[0] += ",Skip Reason";
      }
      values.push(result?.error || "Personal email provider");

      csvRows.push(values.join(","));
    });

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `skipped_emails_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const copyRowData = (rowIndex: number) => {
    const result = results.get(rowIndex);
    const row = rows[rowIndex];
    if (!result || !row) return;

    // Format data nicely for Google Docs
    const emailValue = emailColumn ? row[emailColumn] : "";
    let formattedData = `Email: ${emailValue}\n\n`;

    fields.forEach((field) => {
      const enrichment = result.enrichments[field.name];
      const value = enrichment?.value;

      // Format the field name and value
      formattedData += `${field.displayName}: `;

      if (value === undefined || value === null || value === "") {
        formattedData += "Not found";
      } else if (Array.isArray(value)) {
        formattedData += value.join(", ");
      } else if (typeof value === "boolean") {
        formattedData += value ? "Yes" : "No";
      } else {
        formattedData += String(value);
      }

      formattedData += "\n\n";
    });

    copyToClipboard(formattedData.trim());

    // Show copied feedback
    setCopiedRow(rowIndex);
    toast.success("Row data copied to clipboard!");
    setTimeout(() => setCopiedRow(null), 2000);
  };

  const openDetailSidebar = (rowIndex: number) => {
    const row = rows[rowIndex];
    const result = results.get(rowIndex);
    setSelectedRow({ isOpen: true, row, result, index: rowIndex });
  };

  const handleChatMessage = async (message: string) => {
    const queryId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    setChatQueryId(queryId);
    setIsChatProcessing(true);

    // Add user message
    setAgentMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        message,
        type: "user",
        timestamp: Date.now(),
      },
    ]);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Get conversation history (last 10 messages)
      const conversationHistory = agentMessages
        .filter(msg => msg.type === 'user' || msg.type === 'assistant')
        .slice(-10)
        .map(msg => ({
          role: msg.type === 'user' ? 'user' : 'assistant',
          content: msg.message
        }));

      // Build full table context with enriched data as formatted string
      const tableDataRows = rows.map((row, index) => {
        const result = results.get(index);
        if (!result || result.status === 'pending') return null;

        const enrichedData: Record<string, any> = {};
        if (result?.enrichments) {
          Object.entries(result.enrichments).forEach(([key, enrichment]) => {
            if (enrichment.value) {
              enrichedData[key] = enrichment.value;
            }
          });
        }

        const email = emailColumn ? row[emailColumn] : Object.values(row)[0];
        const dataPoints = Object.entries(enrichedData)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join(', ');

        return `Row ${index + 1} (${email}): ${dataPoints || 'No data enriched yet'}`;
      }).filter(Boolean);

      const tableDataString = tableDataRows.length > 0
        ? `Enriched Data Table:\n${tableDataRows.join('\n')}\n\nTotal: ${tableDataRows.length} rows with data`
        : '';

      const response = await fetch("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({
          question: message,
          context: {
            emailColumn,
            fields: fields.map((f) => ({ name: f.name, displayName: f.displayName })),
            totalRows: rows.length,
            processedRows: results.size,
            tableData: tableDataString, // Include formatted table data as string
          },
          conversationHistory,
          sessionId: queryId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error("No response body");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.substring(6));

              if (data.type === "status") {
                setAgentMessages((prev) => [
                  ...prev,
                  {
                    id: `status-${Date.now()}-${Math.random()}`,
                    message: data.message,
                    type: "info",
                    timestamp: Date.now(),
                    sourceUrl: data.source?.url,
                  },
                ]);
              } else if (data.type === "response") {
                setAgentMessages((prev) => [
                  ...prev,
                  {
                    id: `assistant-${Date.now()}`,
                    message: data.message,
                    type: "assistant",
                    timestamp: Date.now(),
                  },
                ]);
              } else if (data.type === "error") {
                setAgentMessages((prev) => [
                  ...prev,
                  {
                    id: `error-${Date.now()}`,
                    message: data.message,
                    type: "warning",
                    timestamp: Date.now(),
                  },
                ]);
              }
            } catch {
              // Ignore parsing errors
            }
          }
        }
      }
    } catch (error) {
      console.error("Chat error:", error);
      setAgentMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          message: "Failed to process your question. Please try again.",
          type: "warning",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsChatProcessing(false);
      setChatQueryId(null);
    }
  };

  const handleStopQuery = async () => {
    if (chatQueryId) {
      try {
        await fetch(`/api/chat?queryId=${chatQueryId}`, {
          method: "DELETE",
        });
      } catch (error) {
        console.error("Failed to stop query:", error);
      }
      setIsChatProcessing(false);
      setChatQueryId(null);
    }
  };

  const toggleRowExpansion = (rowIndex: number) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(rowIndex)) {
        newSet.delete(rowIndex);
      } else {
        newSet.add(rowIndex);
      }
      return newSet;
    });
  };

  // Auto-expand currently processing row
  useEffect(() => {
    if (currentRow >= 0 && status === "processing") {
      setExpandedRows(prev => {
        const newSet = new Set(prev);
        newSet.add(currentRow);
        return newSet;
      });
    }
  }, [currentRow, status]);

  // Auto-collapse completed rows after 2 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setExpandedRows(prev => {
        const newSet = new Set(prev);
        // Keep only the currently processing row expanded
        Array.from(newSet).forEach(rowIndex => {
          const result = results.get(rowIndex);
          if (result && result.status !== 'processing' && rowIndex !== currentRow) {
            newSet.delete(rowIndex);
          }
        });
        return newSet;
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, [results, currentRow]);

  return (
    <div className="flex h-screen gap-0 relative px-16 py-4">
      {/* Main Table - takes remaining space */}
      <div className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${isChatExpanded ? 'pr-[440px]' : 'pr-0'}`}>
        {/* Metrics Dashboard */}
        <MetricsDashboard />
        {/* Progress Header */}
        <Card className="p-4 rounded-md mb-4 mt-12">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-label-medium text-zinc-900">
                {status === "processing"
                  ? "Enriching Data"
                  : status === "completed"
                    ? "Enrichment Complete"
                    : "Enrichment Cancelled"}
              </h3>
              <div className="flex items-center gap-4 mt-1">
                <span className="text-body-small text-zinc-600">
                  {results.size} of {rows.length} rows processed
                </span>
                {(() => {
                  const skippedCount = Array.from(results.values()).filter(
                    (r) => r.status === "skipped",
                  ).length;
                  if (skippedCount > 0) {
                    return (
                      <span className="text-body-small text-gray-600">
                        • {skippedCount} skipped
                      </span>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {(status === "completed" ||
                status === "cancelled" ||
                (status === "processing" && results.size > 0)) && (
                <>
                  <button
                    onClick={downloadCSV}
                    className="rounded-6 px-8 py-4 gap-2 text-body-small text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center"
                  >
                    <Download style={{ width: '14px', height: '14px' }} />
                    CSV
                  </button>
                  <button
                    onClick={downloadJSON}
                    className="rounded-6 px-8 py-4 gap-2 text-body-small text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center"
                  >
                    <Download style={{ width: '14px', height: '14px' }} />
                    JSON
                  </button>
                </>
              )}

              {status === "processing" && (
                <button
                  onClick={cancelEnrichment}
                  className="rounded-6 px-8 py-4 gap-2 text-body-small text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center"
                >
                  <X style={{ width: '14px', height: '14px' }} />
                  Cancel
                </button>
              )}
            </div>
          </div>
        </Card>

        <div className="flex-1 overflow-auto scrollbar-hide">
          <div className="overflow-hidden rounded-md shadow-sm border border-gray-200">
            <div className="overflow-x-auto scrollbar-hide bg-white">
              <table className="min-w-full relative table-fixed">
                <thead>
                  <tr className="">
                    <th className="sticky left-0 z-10 bg-white px-6 py-4 text-left text-label-medium text-gray-700 border-r-2 border-gray-300 w-64">
                      {emailColumn || "Email"}
                    </th>
                    {fields.map((field) => (
                      <th
                        key={field.name}
                        className="px-6 py-4 text-left text-label-medium text-gray-700 bg-gray-50 w-80"
                      >
                        {field.displayName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                const result = results.get(index);
                const isProcessing =
                  currentRow === index && status === "processing";

                return (
                  <tr
                    key={index}
                    className={`
                  ${
                    isProcessing
                      ? "animate-processing-row"
                      : index % 2 === 0
                        ? "bg-white"
                        : "bg-gray-50/50"
                  }
                  hover:bg-gray-100/50 transition-all duration-300 group border border-grey-200
                `}
                  >
                    <td
                      className={`
                    sticky left-0 z-10 px-6 py-4 text-body-small
                    ${isProcessing ? "bg-gray-100 " : "bg-white"}
                    border-r-2 border-gray-300
                  `}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 relative">
                          <div className="flex items-center gap-1 relative z-10">
                            <div className="text-gray-800 text-body-medium truncate max-w-[180px]">
                              {emailColumn
                                ? row[emailColumn]
                                : Object.values(row)[0]}
                            </div>
                            {/* Show additional columns if CSV has many columns */}
                            {Object.keys(row).length > fields.length + 1 && (
                              <div className="flex items-center gap-1 text-body-small text-gray-500">
                                {Object.keys(row)
                                  .slice(1, 3)
                                  .map((key, idx) => (
                                    <span
                                      key={idx}
                                      className="truncate max-w-[60px]"
                                      title={row[key]}
                                    >
                                      {idx > 0 && ", "}
                                      {row[key]}
                                    </span>
                                  ))}
                                {Object.keys(row).length > 3 && (
                                  <span className="text-gray-400">
                                    +{Object.keys(row).length - 3} more
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-body-small">
                          {result?.status !== "pending" && (
                            <button
                              onClick={() => openDetailSidebar(index)}
                              className="text-gray-600 hover:text-gray-800 hover:underline"
                            >
                              View details →
                            </button>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Check if this row is skipped and render a single merged cell */}
                    {result?.status === "skipped" ? (
                      <td
                        colSpan={fields.length}
                        className="p-12 text-body-small border-l border-gray-100 bg-gray-50"
                      >
                        <div className="flex flex-col items-start gap-2">
                          <span className="inline-flex items-center px-4 py-2 bg-gray-100 text-gray-600 rounded-full text-body-x-small">
                            Skipped
                          </span>
                          <span className="text-body-x-small text-gray-500">
                            {result.error || "Personal email provider"}
                          </span>
                        </div>
                      </td>
                    ) : (
                      fields.map((field, fieldIndex) => {
                        const enrichment = result?.enrichments[field.name];
                        const cellKey = `${index}-${field.name}`;

                        // Check if this cell should be shown
                        const isCellShown = cellsShown.has(cellKey);
                        const rowArrivalTime = rowDataArrivalTime.get(index);
                        const cellDelay = getCellAnimationDelay(
                          index,
                          fieldIndex,
                        );
                        const shouldAnimate =
                          rowArrivalTime &&
                          !isCellShown &&
                          Date.now() - rowArrivalTime < 2500;
                        const shouldShowData =
                          isCellShown ||
                          (rowArrivalTime &&
                            Date.now() - rowArrivalTime > cellDelay);

                        return (
                          <td
                            key={field.name}
                            className="px-6 py-4 text-body-small relative border-l border-gray-100"
                          >
                            {!result || result?.status === "pending" ? (
                              <div className="animate-slow-pulse">
                                <div className="h-5 bg-gradient-to-r from-gray-200 to-gray-300 rounded-full w-3/4"></div>
                              </div>
                            ) : !shouldShowData && shouldAnimate ? (
                              <div className="animate-slow-pulse">
                                <div className="h-5 bg-gradient-to-r from-gray-200 to-gray-300 rounded-full w-3/4"></div>
                              </div>
                            ) : result?.status === "error" ? (
                              <span className="inline-flex items-center px-2 py-1 bg-red-100 text-red-600 rounded-full text-body-x-small">
                                Error
                              </span>
                            ) : result?.status === 'completed' && (!enrichment ||
                              enrichment.value === null ||
                              enrichment.value === undefined ||
                              enrichment.value === "") ? (
                              <div
                                className={
                                  shouldAnimate && !isCellShown
                                    ? "animate-in fade-in slide-in-from-bottom-2"
                                    : ""
                                }
                                style={
                                  shouldAnimate && !isCellShown
                                    ? {
                                        animationDuration: "500ms",
                                        animationDelay: `${cellDelay}ms`,
                                        animationFillMode: "both",
                                        animationTimingFunction:
                                          "cubic-bezier(0.4, 0, 0.2, 1)",
                                      }
                                    : {}
                                }
                              >
                                <span className="flex items-center gap-1 text-gray-400">
                                  <X style={{ width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' }} />
                                </span>
                              </div>
                            ) : !enrichment ||
                              enrichment.value === null ||
                              enrichment.value === undefined ||
                              enrichment.value === "" ? (
                              <div className="animate-slow-pulse">
                                <div className="h-5 bg-gradient-to-r from-gray-200 to-gray-300 rounded-full w-3/4"></div>
                              </div>
                            ) : (
                              <div
                                className={
                                  shouldAnimate && !isCellShown
                                    ? "animate-in fade-in slide-in-from-bottom-2"
                                    : ""
                                }
                                style={
                                  shouldAnimate && !isCellShown
                                    ? {
                                        animationDuration: "500ms",
                                        animationDelay: `${cellDelay}ms`,
                                        animationFillMode: "both",
                                        animationTimingFunction:
                                          "cubic-bezier(0.4, 0, 0.2, 1)",
                                      }
                                    : {}
                                }
                              >
                                <div className="flex flex-col gap-1">
                                  <div className="text-gray-800">
                                    {field.type === "boolean" ? (
                                      <span
                                        className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${
                                          enrichment.value === true ||
                                          enrichment.value === "true" ||
                                          enrichment.value === "Yes"
                                            ? "bg-green-100 text-green-600"
                                            : "bg-red-100 text-red-600"
                                        }`}
                                      >
                                        {enrichment.value === true ||
                                        enrichment.value === "true" ||
                                        enrichment.value === "Yes"
                                          ? "✓"
                                          : "✗"}
                                      </span>
                                    ) : field.type === "array" &&
                                      Array.isArray(enrichment.value) ? (
                                      <div className="space-y-1">
                                        {enrichment.value
                                          .slice(0, 2)
                                          .map((item, i) => (
                                            <span
                                              key={i}
                                              className="inline-block px-2 py-1 bg-gray-100 text-gray-800 rounded-full text-body-x-small mr-1"
                                            >
                                              {item}
                                            </span>
                                          ))}
                                        {enrichment.value.length > 2 && (
                                          <span className="text-body-x-small text-gray-500">
                                            {" "}
                                            +{enrichment.value.length - 2} more
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <div
                                        className="truncate max-w-xs"
                                        title={String(enrichment.value)}
                                      >
                                        {enrichment.value || "-"}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </td>
                        );
                      })
                    )}
                  </tr>
                );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={selectedRow.isOpen}
        onOpenChange={(open) =>
          setSelectedRow({ ...selectedRow, isOpen: open })
        }
      >
        <DialogContent className="bg-white max-w-2xl max-h-[80vh] overflow-y-auto">
          {selectedRow.row && (
            <>
              <DialogHeader className="pb-6 border-b border-gray-200">
                <DialogTitle className="text-title-h3 text-gray-900 mb-4">
                  {emailColumn
                    ? selectedRow.row[emailColumn]
                    : Object.values(selectedRow.row)[0]}
                </DialogTitle>

                {/* Status Badge */}
                <div className="flex items-center gap-3 mb-4">
                  {selectedRow.result?.status === "completed" ? (
                    <Badge className="bg-gray-100 text-gray-700 border-gray-200">
                      Enriched
                    </Badge>
                  ) : selectedRow.result?.status === "skipped" ? (
                    <Badge className="bg-gray-100 text-gray-700 border-gray-200">
                      Skipped
                    </Badge>
                  ) : selectedRow.result?.status === "error" ? (
                    <Badge className="bg-gray-100 text-gray-700 border-gray-200">
                      Error
                    </Badge>
                  ) : (
                    <Badge className="bg-gray-100 text-gray-700 border-gray-200">
                      Processing
                    </Badge>
                  )}
                  <span className="text-body-small text-gray-600">
                    Row {selectedRow.index + 1} of {rows.length}
                  </span>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-3">
                  {selectedRow.result && (
                    <>
                      {emailColumn && selectedRow.row[emailColumn] && (
                        <a
                          href={`mailto:${selectedRow.row[emailColumn]}`}
                          className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-all text-body-medium"
                        >
                          Send Email
                        </a>
                      )}
                    </>
                  )}
                </div>
              </DialogHeader>

              <div className="mt-6 space-y-6">
                {/* Activity Log for this row */}
                {selectedRow.result && agentMessages.filter(msg => msg.rowIndex === selectedRow.index).length > 0 && (
                  <div className="mb-6">
                    <div className="flex items-center gap-2 mb-4">
                      <h3 className="text-label-medium text-gray-900 font-semibold">
                        Activity Log
                      </h3>
                    </div>
                    <Card className="p-4 bg-gray-50 border-gray-200 rounded-md max-h-[200px] overflow-y-auto scrollbar-hide">
                      <div className="space-y-2">
                        {agentMessages
                          .filter(msg => msg.rowIndex === selectedRow.index)
                          .map((msg, idx) => {
                            return (
                              <div key={idx} className="flex items-start gap-2 text-body-small">
                                <span className="text-gray-700 leading-relaxed">{msg.message}</span>
                              </div>
                            );
                          })
                        }
                      </div>
                    </Card>
                  </div>
                )}

                {/* Enriched Fields */}
                {selectedRow.result && (
                  <div>
                    <div className="flex items-center gap-2 mb-4">
                      <div className="h-px flex-1 bg-gray-200" />
                      <h3 className="text-label-medium text-gray-900 font-semibold">
                        Enriched Data
                      </h3>
                      <div className="h-px flex-1 bg-gray-200" />
                    </div>

                    <div className="space-y-3">
                      {fields.map((field) => {
                        const enrichment =
                          selectedRow.result?.enrichments[field.name];
                        if (!enrichment && enrichment !== null) return null;

                        return (
                          <Card
                            key={field.name}
                            className="p-4 bg-zinc-50 border-zinc-200 rounded-md"
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <Label className="text-label-medium text-zinc-700">
                                {field.displayName}
                              </Label>
                            </div>

                            <div className="text-zinc-900">
                              {!enrichment ||
                              enrichment.value === null ||
                              enrichment.value === undefined ||
                              enrichment.value === "" ? (
                                <div className="flex items-center gap-2 text-zinc-400 py-2">
                                  <X style={{ width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' }} />
                                </div>
                              ) : field.type === "array" &&
                                Array.isArray(enrichment.value) ? (
                                <div className="flex flex-wrap gap-1.5 mt-1">
                                  {enrichment.value.map((item, i) => (
                                    <Badge
                                      key={i}
                                      variant="secondary"
                                      className="bg-gray-100 text-gray-700 border-gray-200"
                                    >
                                      {item}
                                    </Badge>
                                  ))}
                                </div>
                              ) : field.type === "boolean" ? (
                                <div className="flex items-center gap-2">
                                  <div
                                    className={`w-6 h-6 rounded-full flex items-center justify-center ${
                                      enrichment.value === true ||
                                      enrichment.value === "true" ||
                                      enrichment.value === "Yes"
                                        ? "bg-green-100"
                                        : "bg-red-100"
                                    }`}
                                  >
                                    {enrichment.value === true ||
                                    enrichment.value === "true" ||
                                    enrichment.value === "Yes" ? (
                                      <Check style={{ width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' }} className="text-green-700" />
                                    ) : (
                                      <X style={{ width: '20px', height: '20px', minWidth: '20px', minHeight: '20px' }} className="text-red-700" />
                                    )}
                                  </div>
                                  <Badge
                                    variant={
                                      enrichment.value === true ||
                                      enrichment.value === "true" ||
                                      enrichment.value === "Yes"
                                        ? "default"
                                        : "secondary"
                                    }
                                    className={
                                      enrichment.value === true ||
                                      enrichment.value === "true" ||
                                      enrichment.value === "Yes"
                                        ? "bg-green-100 text-green-700 hover:bg-green-200"
                                        : "bg-red-100 text-red-700 hover:bg-red-200"
                                    }
                                  >
                                    {enrichment.value === true ||
                                    enrichment.value === "true" ||
                                    enrichment.value === "Yes"
                                      ? "Yes"
                                      : "No"}
                                  </Badge>
                                </div>
                              ) : typeof enrichment.value === "string" &&
                                (enrichment.value.startsWith("http://") ||
                                  enrichment.value.startsWith("https://")) ? (
                                <a
                                  href={String(enrichment.value)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-body-medium text-gray-700 hover:text-gray-900 break-all"
                                >
                                  {enrichment.value}
                                </a>
                              ) : (
                                <p className="text-body-medium text-gray-800 leading-relaxed">
                                  {enrichment.value}
                                </p>
                              )}
                            </div>

                            {/* Corroboration Data */}
                            {enrichment && enrichment.corroboration && (
                              <div className="mt-3 pt-3 border-t border-gray-200">
                                <div className="flex items-center gap-2 mb-2">
                                  {enrichment.corroboration.sources_agree ? (
                                    <span className="text-body-small text-gray-700">
                                      All sources agree
                                    </span>
                                  ) : (
                                    <span className="text-body-small text-gray-700">
                                      Sources vary
                                    </span>
                                  )}
                                </div>
                                <div className="space-y-2">
                                  {enrichment.corroboration.evidence
                                    .filter((e) => e.value !== null)
                                    .map((evidence, idx) => (
                                      <div
                                        key={idx}
                                        className="bg-gray-50 rounded p-2 space-y-1"
                                      >
                                        <div className="flex items-start justify-between gap-2">
                                          <a
                                            href={evidence.source_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-body-x-small text-gray-700 hover:text-gray-900"
                                          >
                                            {
                                              new URL(evidence.source_url)
                                                .hostname
                                            }
                                          </a>
                                        </div>
                                        {evidence.exact_text && (
                                          <p className="text-body-x-small text-gray-600 italic">
                                            &quot;{evidence.exact_text}&quot;
                                          </p>
                                        )}
                                        <p className="text-body-x-small text-gray-800">
                                          Found:{" "}
                                          {JSON.stringify(evidence.value)}
                                        </p>
                                      </div>
                                    ))}
                                </div>
                              </div>
                            )}

                            {/* Source Context (fallback if no corroboration) */}
                            {enrichment &&
                              !enrichment.corroboration &&
                              enrichment.sourceContext &&
                              enrichment.sourceContext.length > 0 && (
                                <div className="mt-3 pt-3 border-t border-gray-200">
                                  <button
                                    onClick={() => {
                                      const sourceKey = `${field.name}-sources`;
                                      setExpandedSources((prev) => {
                                        const newSet = new Set<string>(prev);
                                        if (!prev.has(sourceKey)) {
                                          newSet.add(sourceKey);
                                        } else {
                                          newSet.delete(sourceKey);
                                        }
                                        return newSet;
                                      });
                                    }}
                                    className="flex items-center gap-1 text-body-small text-gray-700 hover:text-gray-900 transition-colors w-full"
                                  >
                                    <span>
                                      Sources ({enrichment.sourceContext.length}
                                      )
                                    </span>
                                    {expandedSources.has(
                                      `${field.name}-sources`,
                                    ) ? (
                                      <ChevronUp style={{ width: '16px', height: '16px' }} />
                                    ) : (
                                      <ChevronDown style={{ width: '16px', height: '16px' }} />
                                    )}
                                  </button>
                                  {expandedSources.has(
                                    `${field.name}-sources`,
                                  ) && (
                                    <div className="space-y-1.5 pl-4 mt-2">
                                      {enrichment.sourceContext.map(
                                        (source, idx) => (
                                          <div key={idx} className="group">
                                            <a
                                              href={source.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="flex items-start gap-2 text-body-x-small text-gray-700 hover:text-gray-900"
                                            >
                                              <span className="break-all">
                                                {new URL(source.url).hostname}
                                              </span>
                                            </a>
                                            {source.snippet && (
                                              <p className="text-body-x-small text-gray-600 italic mt-0.5 pl-4 line-clamp-2">
                                                &quot;{source.snippet}&quot;
                                              </p>
                                            )}
                                          </div>
                                        ),
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                          </Card>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Original Data */}
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <div className="h-px flex-1 bg-gray-200" />
                    <h3 className="text-label-medium text-gray-900 font-semibold">
                      Original Data
                    </h3>
                    <div className="h-px flex-1 bg-gray-200" />
                  </div>

                  <Card className="p-4 bg-gray-50 border-gray-200 rounded-md">
                    <div className="space-y-3">
                      {Object.entries(selectedRow.row).map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-start justify-between gap-4"
                        >
                          <Label className="text-label-medium text-gray-600 min-w-[120px]">
                            {key}
                          </Label>
                          <span className="text-body-medium text-gray-800 text-right break-all">
                            {value || (
                              <span className="italic text-gray-400">
                                Empty
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>

                {/* Action Buttons */}
                <div className="pt-6 pb-4 border-t border-gray-200 space-y-3">
                  <button
                    onClick={() => {
                      copyRowData(selectedRow.index);
                      toast.success("Row data copied to clipboard!");
                    }}
                    className="w-full rounded-8 px-10 py-6 gap-4 text-label-medium text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center justify-center"
                  >
                    <Copy style={{ width: '16px', height: '16px' }} />
                    Copy Row Data
                  </button>
                  {selectedRow.result?.enrichments.website?.value && (
                    <a
                      href={String(selectedRow.result.enrichments.website.value)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full rounded-8 px-10 py-6 gap-4 text-label-medium text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center justify-center"
                    >
                      <Globe style={{ width: '16px', height: '16px' }} />
                      Visit Website
                      <ExternalLink style={{ width: '16px', height: '16px' }} />
                    </a>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Chat Panel - positioned absolutely on the right */}
      <ChatPanel
        messages={agentMessages}
        onSendMessage={handleChatMessage}
        onStopQuery={handleStopQuery}
        isProcessing={isChatProcessing}
        totalRows={rows.length}
        results={results}
        onExpandedChange={setIsChatExpanded}
      />
    </div>
  );
}
