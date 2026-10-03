import type { Pricing } from "./index.ts";

export const OPENROUTER_BODY_MODEL = "mistralai/mistral-small-2603";
export const OPENROUTER_DOCUMENT_MODEL = "google/gemini-3.1-flash-lite";

export interface ApprovedOpenRouterModel {
  readonly model: string;
  /** Exact endpoint slug, not a base slug that would admit other regions/tiers. */
  readonly endpoint: string;
  readonly pricing: Readonly<Pricing>;
  readonly maxPrice: Readonly<{ prompt: number; completion: number }>;
  readonly reasoning: Readonly<
    { effort: "none" | "minimal" } | { enabled: false }
  >;
}

function approved(
  model: string,
  endpoint: string,
  input: string,
  output: string,
  reasoning: ApprovedOpenRouterModel["reasoning"],
  reservedInput = input,
): ApprovedOpenRouterModel {
  return Object.freeze({
    model,
    endpoint,
    pricing: Object.freeze({
      version: `openrouter-${model}-2026-10-03`,
      inputUsdPerMillionTokens: reservedInput,
      outputUsdPerMillionTokens: output,
    }),
    maxPrice: Object.freeze({
      prompt: Number(input),
      completion: Number(output),
    }),
    reasoning: Object.freeze(reasoning),
  });
}

/**
 * Reviewed against the public models, model endpoints and ZDR endpoint APIs on
 * 2026-10-03. See docs/validation/openrouter-cost-benefit-a02.md. Missing routes
 * or changed prices must fail closed; no free/auto/batch/flex fallback is allowed.
 */
const models: Readonly<Record<string, ApprovedOpenRouterModel>> = Object.freeze(
  {
    [OPENROUTER_BODY_MODEL]: approved(
      OPENROUTER_BODY_MODEL,
      "mistral/zdr",
      "0.15",
      "0.6",
      { effort: "none" },
    ),
    [OPENROUTER_DOCUMENT_MODEL]: approved(
      OPENROUTER_DOCUMENT_MODEL,
      "google-vertex/global",
      "0.25",
      "1.5",
      { effort: "minimal" },
    ),
    "google/gemini-2.5-flash": approved(
      "google/gemini-2.5-flash",
      "google-vertex/global",
      "0.3",
      "2.5",
      { enabled: false },
    ),
    "anthropic/claude-haiku-4.5": approved(
      "anthropic/claude-haiku-4.5",
      "amazon-bedrock/global",
      "1",
      "5",
      { enabled: false },
      // Reserve at the highest advertised cache-write price (1h), even though
      // CrashMemory does not request prompt caching or extended cache lifetimes.
      "2",
    ),
  },
);

export function approvedOpenRouterModel(
  model: string,
): ApprovedOpenRouterModel | undefined {
  return Object.hasOwn(models, model) ? models[model] : undefined;
}
