import { NextResponse } from 'next/server';

export async function GET() {
  const environmentStatus = {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    FIRESTARTER_DISABLE_CREATION_DASHBOARD:
      process.env.FIRESTARTER_DISABLE_CREATION_DASHBOARD === "true",
    // Novas flags para Azure/Explorium
    AZURE_OPENAI_API_KEY: !!process.env.AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_ENDPOINT: !!process.env.AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_DEPLOYMENT: !!process.env.AZURE_OPENAI_DEPLOYMENT,
    AZURE_OPENAI_API_VERSION: !!process.env.AZURE_OPENAI_API_VERSION,
    EXPLORIUM_API_KEY: !!process.env.EXPLORIUM_API_KEY,
  };

  return NextResponse.json({ environmentStatus });
}