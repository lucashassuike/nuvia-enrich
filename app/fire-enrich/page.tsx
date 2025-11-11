"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2 } from "lucide-react";
import { CSVUploader } from "./csv-uploader";
import { UnifiedEnrichmentView } from "./unified-enrichment-view";
import { EnrichmentTable } from "./enrichment-table";
import { CSVRow, EnrichmentField } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Input from "@/components/ui/input";
import { toast } from "sonner";

export default function CSVEnrichmentPage() {
  const [step, setStep] = useState<"upload" | "setup" | "enrichment">("upload");
  const [csvData, setCsvData] = useState<{
    rows: CSVRow[];
    columns: string[];
  } | null>(null);
  const [emailColumn, setEmailColumn] = useState<string>("");
  const [selectedFields, setSelectedFields] = useState<EnrichmentField[]>([]);
  const [isCheckingEnv, setIsCheckingEnv] = useState(true);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  // Firecrawl no longer used
  const [openaiApiKey, setOpenaiApiKey] = useState<string>("");
  const [isValidatingApiKey, setIsValidatingApiKey] = useState(false);
  const [missingKeys, setMissingKeys] = useState<{ openai: boolean }>({ openai: false });
  const [pendingCSVData, setPendingCSVData] = useState<{
    rows: CSVRow[];
    columns: string[];
  } | null>(null);
  
  // Check environment status on component mount
  useEffect(() => {
    const checkEnvironment = async () => {
      try {
        const response = await fetch("/api/check-env");
        if (!response.ok) {
          throw new Error("Failed to check environment");
        }
        const data = await response.json();
        const env = data.environmentStatus;
        const hasAzureOpenAI =
          env.AZURE_OPENAI_API_KEY &&
          env.AZURE_OPENAI_ENDPOINT &&
          env.AZURE_OPENAI_DEPLOYMENT &&
          env.AZURE_OPENAI_API_VERSION;
        const hasEnvOpenAI = env.OPENAI_API_KEY;
        const hasSavedOpenAI = localStorage.getItem("openai_api_key");
        const needsOpenAI = !hasEnvOpenAI && !hasSavedOpenAI && !hasAzureOpenAI;
        if (needsOpenAI) {
          setMissingKeys({ openai: true });
          setShowApiKeyModal(true);
        }
      } catch (error) {
        console.error("Failed to check environment:", error);
      } finally {
        setIsCheckingEnv(false);
      }
    };
    checkEnvironment();
  }, []);
  
    const handleCSVUpload = async (rows: CSVRow[], columns: string[]) => {
      // Check if we have Firecrawl API key
      const response = await fetch("/api/check-env");
      const data = await response.json();
      const hasOpenAI = data.environmentStatus.OPENAI_API_KEY;
      const savedOpenAIKey = localStorage.getItem("openai_api_key");
  
      // Apenas exige OpenAI; ignora Firecrawl
      if (!hasOpenAI && !savedOpenAIKey) {
        setPendingCSVData({ rows, columns });
        setMissingKeys({ openai: true });
        setShowApiKeyModal(true);
      } else {
        setCsvData({ rows, columns });
        setStep("setup");
      }
    };
  
    const handleStartEnrichment = (
      email: string,
      fields: EnrichmentField[],
    ) => {
      setEmailColumn(email);
      setSelectedFields(fields);
      setStep("enrichment");
    };
  
    const handleBack = () => {
      if (step === "setup") {
        setStep("upload");
      } else if (step === "enrichment") {
        setStep("setup");
      }
    };
  
    const resetProcess = () => {
      setStep("upload");
      setCsvData(null);
      setEmailColumn("");
      setSelectedFields([]);
    };
  
    // Remove Firecrawl CTA
  
    const handleApiKeySubmit = async () => {
      // Check environment again to see what's missing
      const response = await fetch("/api/check-env");
      const data = await response.json();
      const hasEnvOpenAI = data.environmentStatus.OPENAI_API_KEY;
      const hasSavedOpenAI = localStorage.getItem("openai_api_key");
  
      const needsOpenAI = !hasEnvOpenAI && !hasSavedOpenAI;
  
      if (needsOpenAI && !openaiApiKey.trim()) {
        toast.error("Please enter a valid OpenAI API key");
        return;
      }
  
      setIsValidatingApiKey(true);
  
      try {
        // Save OpenAI key if provided
        if (openaiApiKey) {
          localStorage.setItem("openai_api_key", openaiApiKey);
        }
  
        toast.success("API keys saved successfully!");
        setShowApiKeyModal(false);
  
        if (pendingCSVData) {
          setCsvData(pendingCSVData);
          setStep("setup");
          setPendingCSVData(null);
        }
      } catch (error) {
        toast.error("Invalid API key. Please check and try again.");
        console.error("API key validation error:", error);
      } finally {
        setIsValidatingApiKey(false);
      }
    };
  
    return (
      <div className="px-4 sm:px-6 lg:px-8 py-4 max-w-7xl mx-auto font-inter">
        {/* Header */}
        <div className="flex justify-between items-center py-3">
          <div className="text-sm font-semibold tracking-tight text-[#1F2937]">Nuvia</div>
          <div />
        </div>

        {/* Hero */}
        <div className="text-center pt-8 pb-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border bg-white shadow-sm text-xs text-gray-700 mb-4">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#7A5DF6]" />
            AI Lead Enrichment
          </div>
          <h1 className="text-[2.5rem] lg:text-[3.8rem] text-[#1F2937] dark:text-white font-semibold tracking-tight leading-[0.9] opacity-0 animate-fade-up [animation-duration:500ms] [animation-delay:200ms] [animation-fill-mode:forwards]">
            <span className="relative px-1">
              Nuvia Enrich v2
            </span>
            <span className="block leading-[1.1] text-transparent bg-clip-text bg-gradient-to-tr from-[#7A5DF6] to-[#a693ff] opacity-0 animate-fade-up [animation-duration:500ms] [animation-delay:400ms] [animation-fill-mode:forwards]">
              Drag, Drop, Enrich
            </span>
          </h1>
          <p className="mt-4 text-sm md:text-base text-gray-600 max-w-xl mx-auto">
            Enrich your leads with clean & accurate data crawled from all over the internet.
          </p>
          <p className="mt-1 text-xs text-gray-500">Powered by Nuvia</p>
        </div>
  
        {/* Main Content */}
        {isCheckingEnv ? (
          <div className="text-center py-10">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-4" />
            <p className="text-sm text-muted-foreground">Initializing...</p>
          </div>
        ) : (
          <div className="bg-white p-4 sm:p-6 rounded-xl shadow-md border">
            {step === "setup" && (
              <Button
                variant="code"
                size="sm"
                onClick={handleBack}
                className="mb-4 flex items-center gap-1.5"
              >
                <ArrowLeft size={16} />
                Back
              </Button>
            )}

            {step === "upload" && <CSVUploader onUpload={handleCSVUpload} />}
  
            {step === "setup" && csvData && (
              <UnifiedEnrichmentView
                rows={csvData.rows}
                columns={csvData.columns}
                onStartEnrichment={handleStartEnrichment}
              />
            )}
  
            {step === "enrichment" && csvData && (
              <>
                <div className="mb-4">
                  <h2 className="text-xl font-semibold mb-1">
                    Enrichment Results
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Click on any row to view detailed information
                  </p>
                </div>
                <EnrichmentTable
                  rows={csvData.rows}
                  fields={selectedFields}
                  emailColumn={emailColumn}
                />
                <div className="mt-6 text-center">
                  <Button variant="default" onClick={resetProcess}>
                    Start New Enrichment
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
  
        <footer className="py-8 text-center text-sm text-gray-600 dark:text-gray-400">
          <p>
            Powered by Nuvia
          </p>
        </footer>
  
        {/* API Key Modal */}
        <Dialog open={showApiKeyModal} onOpenChange={setShowApiKeyModal}>
          <DialogContent className="sm:max-w-md bg-white dark:bg-zinc-900">
            <DialogHeader>
              <DialogTitle>API Keys Required</DialogTitle>
              <DialogDescription>
                This tool requires an OpenAI API key to enrich your CSV data.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-4">
              {/* Firecrawl input removed */}
  
              {missingKeys.openai && (
                <>
                  <Button
                    onClick={() =>
                      window.open(
                        "https://platform.openai.com/api-keys",
                        "_blank",
                      )
                    }
                    variant="outline"
                    size="sm"
                    className="flex items-center justify-center gap-2 cursor-pointer"
                  >
                    Get OpenAI API Key
                  </Button>
                  <div className="flex flex-col gap-2">
                    <label htmlFor="openai-key" className="text-sm font-medium">
                      OpenAI API Key
                    </label>
                    <Input
                      id="openai-key"
                      type="password"
                      placeholder="sk-..."
                      value={openaiApiKey}
                      onChange={(e) => setOpenaiApiKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !isValidatingApiKey) {
                          handleApiKeySubmit();
                        }
                      }}
                      disabled={isValidatingApiKey}
                    />
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowApiKeyModal(false)}
                disabled={isValidatingApiKey}
              >
                Cancel
              </Button>
              <Button
                onClick={handleApiKeySubmit}
                disabled={
                  isValidatingApiKey || (missingKeys.openai && !openaiApiKey.trim())
                }
                variant="code"
              >
                {isValidatingApiKey ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Validating...
                  </>
                ) : (
                  "Submit"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
}
