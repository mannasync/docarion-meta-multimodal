import { GoogleGenAI } from '@google/genai';
import axios from 'axios';
import crypto from 'crypto';
import { aiPythonService, CircuitState } from './ai-python.service';

import log from '../utils/logger';
import {
    AIPrivacyOptions,
    enforceAIPrivacyBoundary,
} from './ai-privacy.service';
import { inspectAndScrubPHI } from './phi-scrubber.service';
import { v4 as uuidv4 } from 'uuid';

// ============================================================
// Docarion AI Core — Multi-Provider Task-Tier Cost Router
// ------------------------------------------------------------
// Tier routing:
//   - 'spark':   Meta Muse Spark (muse-spark-1.3) / Llama 4 Scout.
//                Fast, low-latency conversational NLU & counter intake.
//   - 'wonder':  Meta Muse Wonder (muse-wonder-1.0) / Llama 4 Maverick.
//                Deep reasoning for DDx, SOAP, and clinical synthesis.
//   - 'economy': Baseten ($100 credit) / Fireworks ($25 credit) / Spark.
//                High-frequency entity extraction & label parsing.
//
// Cost conservation:
//   - In-memory SHA-256 prompt response cache with TTL prevents repeat
//     demo / test token burn ($0.00 token cost on repeated hits).
//   - Gemini fallback (GEMINI_API_KEY) ensures 100% uptime.
// ============================================================

export type ModelTier = 'economy' | 'spark' | 'wonder' | 'sam';

export interface MultimodalContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system' | 'model';
    content: string | MultimodalContentPart[];
}

export interface AIModelTelemetry {
    requestId: string;
    provider: 'meta-direct' | 'meta-openrouter' | 'baseten' | 'fireworks' | 'gemini-fallback' | 'cached' | 'deterministic-fallback';
    modelId: string;
    tier: ModelTier;
    latencyMs: number;
    cached?: boolean;
    phiScrubber?: {
        inspected: boolean;
        redactedCount: number;
        categories: string[];
    };
}

export interface AIRequestOptions extends AIPrivacyOptions {
    tier?: ModelTier;
    fresh?: boolean;
    temperature?: number;
    maxTokens?: number;
    onTelemetry?: (telemetry: AIModelTelemetry) => void;
}

// ---- Providers Credentials ----
function normalizeLlamaToken(raw: string): string {
    const trimmed = (raw || '').trim();
    return trimmed.replace(/^LLM_(\d+)_/, 'LLM|$1|');
}

const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const LLAMA_API_TOKEN = normalizeLlamaToken(
    process.env.LLAMA_API_TOKEN || process.env.LLAMA_API_KEY || ''
);
const BASETEN_API_KEY = (process.env.BASETEN_API_KEY || '').trim();
const FIREWORKS_API_KEY = (process.env.FIREWORKS_API_KEY || '').trim();

// Prefer direct LLAMA_API_TOKEN first when present; otherwise use OPENROUTER_API_KEY.
const PRIMARY_API_KEY = (LLAMA_API_TOKEN || OPENROUTER_API_KEY).trim();
const USING_OPENROUTER =
    PRIMARY_API_KEY.startsWith('sk-or-') || (!LLAMA_API_TOKEN && !!OPENROUTER_API_KEY);

export function resolveBasetenChatUrl(rawUrl?: string): string {
    const trimmed = (rawUrl || '').trim();
    if (!trimmed) return 'https://inference.baseten.co/v1/chat/completions';
    if (trimmed.endsWith('/chat/completions')) return trimmed;
    if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
    if (trimmed.endsWith('/v1/')) return `${trimmed}chat/completions`;
    return `${trimmed.replace(/\/+$/, '')}/chat/completions`;
}

export const DEFAULT_META_SPARK_MODEL = (process.env.META_SPARK_MODEL_ID || 'muse-spark-1.3').trim();
export const DEFAULT_META_WONDER_MODEL = (process.env.META_WONDER_MODEL_ID || 'muse-wonder-1.0').trim();
export const DEFAULT_BASETEN_MODEL = (process.env.BASETEN_MODEL_ID || process.env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026').trim();
export const DEFAULT_BASETEN_URL = 'https://inference.baseten.co/v1/chat/completions';

function normalizeModelForProvider(model: string, usingOpenRouter: boolean, tier: ModelTier = 'wonder'): string {
    const trimmed = model.trim();
    if (usingOpenRouter) {
        if (tier === 'spark') return 'meta-llama/llama-4-scout';
        if (/(maverick|muse-wonder)/i.test(trimmed)) return 'meta-llama/llama-4-maverick';
        if (/(scout|muse-spark)/i.test(trimmed)) return 'meta-llama/llama-4-scout';
        if (/llama-3\.3-70b/i.test(trimmed)) return 'meta-llama/llama-3.3-70b-instruct';
        return trimmed;
    }
    // Direct Meta API (https://api.meta.ai/v1/chat/completions)
    const sparkModel = (process.env.META_SPARK_MODEL_ID || 'muse-spark-1.3').trim();
    const wonderModel = (process.env.META_WONDER_MODEL_ID || 'muse-wonder-1.0').trim();
    if (tier === 'spark' || /(muse-spark|scout)/i.test(trimmed)) {
        return sparkModel;
    }
    if (/(maverick|llama-4|llama-3|muse-wonder)/i.test(trimmed)) {
        return wonderModel;
    }
    return trimmed || wonderModel;
}

function resolveDirectMetaUrl(rawUrl?: string): string {
    const trimmed = (rawUrl || '').trim();
    if (!trimmed || /^https:\/\/api\.llama\.com\/v1\/chat\/completions\/?$/i.test(trimmed)) {
        return 'https://api.meta.ai/v1/chat/completions';
    }
    return trimmed;
}

const PRIMARY_API_URL = (
    process.env.AI_PRIMARY_URL ||
    (USING_OPENROUTER
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : resolveDirectMetaUrl(process.env.LLAMA_API_URL))
).trim();

const PRIMARY_MODEL = normalizeModelForProvider(
    process.env.AI_PRIMARY_MODEL ||
        process.env.LLAMA_MODEL ||
        (USING_OPENROUTER ? 'meta-llama/llama-4-maverick' : 'muse-wonder-1.0'),
    USING_OPENROUTER,
    'wonder'
);

const PRIMARY_FALLBACK_MODELS = (
    process.env.AI_PRIMARY_FALLBACK_MODELS ||
    (USING_OPENROUTER ? 'meta-llama/llama-3.3-70b-instruct' : '')
)
    .split(',')
    .map(s => normalizeModelForProvider(s, USING_OPENROUTER, 'wonder'))
    .filter(s => Boolean(s) && s !== PRIMARY_MODEL);

const PRIMARY_TIMEOUT_MS = parseInt(
    process.env.AI_PRIMARY_TIMEOUT_MS || process.env.LLAMA_TIMEOUT_MS || '30000',
    10
);

const OPENROUTER_FALLBACK_MODEL = USING_OPENROUTER
    ? (process.env.AI_FALLBACK_MODEL || 'meta-llama/llama-3.3-70b-instruct').trim()
    : '';

// ---- Gemini (fallback) ----
const rawGeminiApiKey = (process.env.GEMINI_API_KEY || '').trim();
const geminiApiKey = /^test_gemini_key_/i.test(rawGeminiApiKey) ? '' : rawGeminiApiKey;
const gemini = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

export const AI_PROVIDERS = {
    testCallsEnabled: () => process.env.NODE_ENV !== 'test' || process.env.ALLOW_LIVE_AI_TESTS === 'true',
    llamaAvailable: () => AI_PROVIDERS.testCallsEnabled() && !!PRIMARY_API_KEY,
    primaryAvailable: () => AI_PROVIDERS.testCallsEnabled() && !!PRIMARY_API_KEY,
    basetenAvailable: () => AI_PROVIDERS.testCallsEnabled() && !!BASETEN_API_KEY,
    fireworksAvailable: () => AI_PROVIDERS.testCallsEnabled() && !!FIREWORKS_API_KEY,
    geminiAvailable: () => AI_PROVIDERS.testCallsEnabled() && !!gemini,
    anyAvailable: () => AI_PROVIDERS.testCallsEnabled() && (!!PRIMARY_API_KEY || !!BASETEN_API_KEY || !!FIREWORKS_API_KEY || !!gemini),
};

// ------------------------------------------------------------
// Deterministic SHA-256 Prompt Response Cache (Zero-Burn Shield)
// ------------------------------------------------------------
interface CacheEntry {
    output: string;
    expiresAt: number;
    telemetry: AIModelTelemetry;
}

const promptCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function computeCacheKey(tier: ModelTier, messages: ChatMessage[]): string {
    const raw = `${tier}:${JSON.stringify(messages)}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function getFromCache(key: string): CacheEntry | null {
    const entry = promptCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        promptCache.delete(key);
        return null;
    }
    return entry;
}

function setInCache(key: string, output: string, telemetry: AIModelTelemetry): void {
    promptCache.set(key, {
        output,
        expiresAt: Date.now() + CACHE_TTL_MS,
        telemetry: { ...telemetry, cached: true },
    });
}

// Extract the first balanced JSON object from a raw model string.
function extractJson<T>(raw: string): T {
    let text = (raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(text) as T;
    } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(text.substring(start, end + 1)) as T;
        }
        throw new Error(`AI response did not contain valid JSON. Raw: ${text.substring(0, 200)}`);
    }
}

// Full ordered primary model pool: primary first, then fallbacks.
const PRIMARY_MODEL_POOL = [PRIMARY_MODEL, ...PRIMARY_FALLBACK_MODELS];

function getModelPoolForTier(tier: ModelTier): string[] {
    const directSpark = (process.env.META_SPARK_MODEL_ID || 'muse-spark-1.3').trim();
    if (tier === 'spark') {
        const sparkPrimary = USING_OPENROUTER ? 'meta-llama/llama-4-scout' : directSpark;
        return [sparkPrimary, PRIMARY_MODEL, ...PRIMARY_FALLBACK_MODELS];
    }
    if (tier === 'economy') {
        const economyPrimary = USING_OPENROUTER ? 'meta-llama/llama-4-scout' : directSpark;
        return [economyPrimary, ...PRIMARY_MODEL_POOL];
    }
    return PRIMARY_MODEL_POOL;
}

// One OpenAI-compatible chat call for a specific model (or batch of models).
async function primaryChatBatch(
    modelBatch: string[],
    messages: ChatMessage[],
    opts: { maxTokens: number; temperature: number; json: boolean },
    overrideProvider?: { url: string; apiKey: string; usingOpenRouter: boolean }
): Promise<string> {
    const usingOpenRouter = overrideProvider ? overrideProvider.usingOpenRouter : USING_OPENROUTER;
    const apiUrl = overrideProvider ? overrideProvider.url : PRIMARY_API_URL;
    const apiKey = overrideProvider ? overrideProvider.apiKey : PRIMARY_API_KEY;

    const chatMessages = messages.map(m => ({
        role: m.role === 'assistant' || m.role === 'model' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
        content: typeof m.content === 'string'
            ? m.content
            : m.content.map(p => {
                if (p.type === 'text') return { type: 'text', text: p.text || '' };
                if (p.type === 'image_url') return { type: 'image_url', image_url: { url: p.image_url?.url || '' } };
                return p;
            }),
    }));

    // Direct Meta models (muse-wonder-1.0 / muse-spark-1.3) include internal reasoning_tokens
    // within max_completion_tokens, so ensure sufficient token headroom for structured JSON.
    const completionTokens = usingOpenRouter
        ? opts.maxTokens
        : Math.max(opts.maxTokens * 4, 2048);

    const body: Record<string, unknown> = {
        model: modelBatch[0],
        messages: chatMessages,
        temperature: opts.temperature,
        max_completion_tokens: completionTokens,
    };
    if (usingOpenRouter) {
        body.max_tokens = opts.maxTokens;
    }
    if (opts.json && usingOpenRouter) {
        body.response_format = { type: 'json_object' };
    }

    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(usingOpenRouter
            ? {
                  'HTTP-Referer': (process.env.OPENROUTER_SITE_URL || 'https://docarion.com').trim(),
                  'X-Title': (process.env.OPENROUTER_APP_NAME || 'Docarion').trim(),
              }
            : {}),
    };

    const response = await axios.post(apiUrl, body, {
        headers,
        timeout: PRIMARY_TIMEOUT_MS,
    });

    const content =
        response.data?.choices?.[0]?.message?.content ||
        response.data?.completion_message?.content?.text ||
        '';
    if (!content) throw new Error('Primary AI provider returned an empty response');
    return content as string;
}

// A model the provider says does not exist (404, e.g. a retired ":free" id, or
// one refused by the account's data policy) is skipped for an hour instead of
// costing every request a failed round trip. A rate-limited model (429) is
// skipped for a minute. Per instance, in memory; nothing is persisted.
const MODEL_404_SKIP_MS = 60 * 60 * 1000;
const MODEL_429_SKIP_MS = 60 * 1000;
const modelUnavailableUntil = new Map<string, number>();

export function isModelTemporarilyUnavailable(model: string, now: number = Date.now()): boolean {
    const until = modelUnavailableUntil.get(model);
    if (until === undefined) return false;
    if (until <= now) {
        modelUnavailableUntil.delete(model);
        return false;
    }
    return true;
}

export function noteModelFailure(model: string, status: number | undefined, now: number = Date.now()): void {
    if (status === 404) modelUnavailableUntil.set(model, now + MODEL_404_SKIP_MS);
    else if (status === 429) modelUnavailableUntil.set(model, now + MODEL_429_SKIP_MS);
}

/** Test hook: forget every remembered model failure and clear cache. */
export function __resetModelAvailabilityForTests(): void {
    modelUnavailableUntil.clear();
    promptCache.clear();
}

// Try each model in the tier-specific pool sequentially before failing over.
async function primaryChat(
    messages: ChatMessage[],
    opts: { maxTokens: number; temperature: number; json: boolean; tier?: ModelTier }
): Promise<{ text: string; modelUsed: string; provider: 'meta-direct' | 'meta-openrouter' | 'baseten' | 'fireworks' }> {
    let lastErr: any;
    const tier = opts.tier || 'wonder';

    // Economy tier option 1: Baseten if configured ($100 credit + 2M TPM)
    if (tier === 'economy' && BASETEN_API_KEY) {
        try {
            const basetenUrl = resolveBasetenChatUrl(process.env.BASETEN_API_URL);
            const basetenModel = (process.env.BASETEN_MODEL_ID || process.env.BASETEN_MODEL || DEFAULT_BASETEN_MODEL).trim();
            const candidateModels = [basetenModel, 'meta-models/muse-spark-open'].filter(
                (m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx
            );
            for (const model of candidateModels) {
                if (isModelTemporarilyUnavailable(model)) continue;
                try {
                    const text = await primaryChatBatch([model], messages, {
                        ...opts,
                        maxTokens: Math.max(opts.maxTokens * 4, 2048),
                    }, {
                        url: basetenUrl,
                        apiKey: BASETEN_API_KEY,
                        usingOpenRouter: true,
                    });
                    return { text, modelUsed: model, provider: 'baseten' };
                } catch (bErr: any) {
                    lastErr = bErr;
                    noteModelFailure(model, bErr?.response?.status);
                }
            }
        } catch (err: any) {
            log.warn(`AI Core: Baseten economy tier failed (${err?.response?.status || err?.message}); trying Meta/primary.`);
        }
    }

    // Economy tier option 2: Fireworks if configured ($25 credit)
    if (tier === 'economy' && FIREWORKS_API_KEY) {
        try {
            const fireworksUrl = (process.env.FIREWORKS_API_URL || 'https://api.fireworks.ai/inference/v1/chat/completions').trim();
            const fireworksModel = (process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/llama-v3p3-70b-instruct').trim();
            const text = await primaryChatBatch([fireworksModel], messages, opts, {
                url: fireworksUrl,
                apiKey: FIREWORKS_API_KEY,
                usingOpenRouter: true,
            });
            return { text, modelUsed: fireworksModel, provider: 'fireworks' };
        } catch (err: any) {
            log.warn(`AI Core: Fireworks economy tier failed (${err?.response?.status || err?.message}); trying Meta/primary.`);
        }
    }

    // Primary Meta API / OpenRouter pool
    if (PRIMARY_API_KEY) {
        const pool = getModelPoolForTier(tier);
        for (const model of pool) {
            if (isModelTemporarilyUnavailable(model)) continue;
            try {
                const text = await primaryChatBatch([model], messages, opts);
                return {
                    text,
                    modelUsed: model,
                    provider: USING_OPENROUTER ? 'meta-openrouter' : 'meta-direct',
                };
            } catch (err: any) {
                lastErr = err;
                const status: number | undefined = err?.response?.status;
                noteModelFailure(model, status);
                log.warn(`AI Core: primary model [${model}] failed (${status || err?.message}); ${status === 404 ? 'skipping it for an hour' : 'trying next model'}.`);
            }
        }
    }

    // If direct Meta API failed and a separate OPENROUTER_API_KEY is also present, fail over to OpenRouter Llama 4 Maverick
    if (!USING_OPENROUTER && OPENROUTER_API_KEY) {
        try {
            const text = await primaryChatBatch(['meta-llama/llama-4-maverick'], messages, opts, {
                url: 'https://openrouter.ai/api/v1/chat/completions',
                apiKey: OPENROUTER_API_KEY,
                usingOpenRouter: true,
            });
            return {
                text,
                modelUsed: 'meta-llama/llama-4-maverick',
                provider: 'meta-openrouter',
            };
        } catch (err: any) {
            lastErr = err;
            log.warn(`AI Core: secondary OpenRouter Llama 4 Maverick failed (${err?.response?.status || err?.message}).`);
        }
    }

    // Failover to Baseten hackathon endpoint if primary Meta models failed (or if PRIMARY_API_KEY is unset)
    if (BASETEN_API_KEY) {
        try {
            const basetenUrl = resolveBasetenChatUrl(process.env.BASETEN_API_URL);
            const basetenModel = (process.env.BASETEN_MODEL_ID || process.env.BASETEN_MODEL || DEFAULT_BASETEN_MODEL).trim();
            const candidateModels = [basetenModel, 'meta-models/muse-spark-open'].filter(
                (m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx
            );
            for (const model of candidateModels) {
                if (isModelTemporarilyUnavailable(model)) continue;
                try {
                    const text = await primaryChatBatch([model], messages, {
                        ...opts,
                        maxTokens: Math.max(opts.maxTokens * 4, 2048),
                    }, {
                        url: basetenUrl,
                        apiKey: BASETEN_API_KEY,
                        usingOpenRouter: true,
                    });
                    return { text, modelUsed: model, provider: 'baseten' };
                } catch (bErr: any) {
                    lastErr = bErr;
                    noteModelFailure(model, bErr?.response?.status);
                }
            }
        } catch (err: any) {
            lastErr = err;
            log.warn(`AI Core: Baseten failover failed (${err?.response?.status || err?.message}).`);
        }
    }

    throw lastErr || new Error('All primary models failed');
}

// ---- Gemini calls ----
function geminiPrompt(messages: ChatMessage[]): { system?: string; prompt: string } {
    const systemMsg = messages.find(m => m.role === 'system');
    const system = typeof systemMsg?.content === 'string'
        ? systemMsg.content
        : systemMsg?.content?.map(p => p.type === 'text' ? p.text : '').join(' ');
    const prompt = messages
        .filter(m => m.role !== 'system')
        .map(m => {
            const role = m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user';
            const text = typeof m.content === 'string'
                ? m.content
                : m.content.map(p => p.type === 'text' ? p.text : '').join(' ');
            return `${role}: ${text}`;
        })
        .join('\n\n');
    return { system, prompt };
}

function prepareMessages(
    messages: ChatMessage[],
    privacy: AIPrivacyOptions,
    requestId: string,
): ChatMessage[] {
    return messages.map((message, index) => {
        if (typeof message.content === 'string') {
            return {
                ...message,
                content: enforceAIPrivacyBoundary(
                    message.content,
                    'egress',
                    {
                        ...privacy,
                        operation: `${privacy.operation || 'ai-core'}:message-${index}:${message.role}`,
                    },
                    requestId,
                ).text,
            };
        }
        const parts: MultimodalContentPart[] = message.content.map((part, pIdx) => {
            if (part.type === 'text' && part.text) {
                return {
                    ...part,
                    text: enforceAIPrivacyBoundary(
                        part.text,
                        'egress',
                        {
                            ...privacy,
                            operation: `${privacy.operation || 'ai-core'}:message-${index}:${message.role}:part-${pIdx}`,
                        },
                        requestId,
                    ).text,
                };
            }
            return part;
        });
        return { ...message, content: parts };
    });
}

function prepareModelOutput(
    raw: string,
    privacy: AIPrivacyOptions,
    requestId: string,
): string {
    return enforceAIPrivacyBoundary(
        raw,
        'ingress',
        {
            ...privacy,
            operation: `${privacy.operation || 'ai-core'}:model-output`,
        },
        requestId,
    ).text;
}

export const aiCoreService = {
    /**
     * Generate structured JSON output with cost tier, caching, and telemetry.
     */
    async generateStructuredWithTelemetry<T>(
        messages: ChatMessage[],
        maxTokens: number = 2000,
        options: AIRequestOptions = {},
    ): Promise<{ data: T; telemetry: AIModelTelemetry }> {
        if (!AI_PROVIDERS.anyAvailable()) {
            log.warn('AI Core: no provider configured (OPENROUTER_API_KEY/LLAMA_API_TOKEN or GEMINI_API_KEY). Cannot generate.');
            throw new Error('AI Core Service not configured');
        }

        const tier: ModelTier = options.tier || 'wonder';
        const requestId = `ai-${uuidv4()}`;
        const startTime = Date.now();

        // 1. Audit PHI redactions on egress text
        let totalRedactions = 0;
        const redactedCategoriesSet = new Set<string>();
        for (const msg of messages) {
            const str = typeof msg.content === 'string'
                ? msg.content
                : msg.content.map(p => p.type === 'text' ? p.text : '').join(' ');
            const audit = inspectAndScrubPHI(str);
            totalRedactions += audit.redactionCount;
            audit.redactedCategories.forEach(c => redactedCategoriesSet.add(c));
        }

        // 2. Check SHA-256 prompt cache unless options.fresh === true (bypassed in test env to preserve mock assertions)
        const cacheKey = computeCacheKey(tier, messages);
        if (!options.fresh && process.env.NODE_ENV !== 'test') {
            const cached = getFromCache(cacheKey);
            if (cached) {
                const parsed = extractJson<T>(cached.output);
                const telemetry: AIModelTelemetry = {
                    ...cached.telemetry,
                    requestId,
                    cached: true,
                    latencyMs: Date.now() - startTime,
                    phiScrubber: {
                        inspected: true,
                        redactedCount: totalRedactions,
                        categories: Array.from(redactedCategoriesSet),
                    },
                };
                if (options.onTelemetry) options.onTelemetry(telemetry);
                return { data: parsed, telemetry };
            }
        }

        let lastErr: any;
        const safeMessages = prepareMessages(messages, options, requestId);

        // Tier 1: Primary provider pool (Meta API / OpenRouter / Baseten / Fireworks)
        if (PRIMARY_API_KEY || BASETEN_API_KEY || FIREWORKS_API_KEY) {
            try {
                const chatRes = await primaryChat(safeMessages, {
                    maxTokens,
                    temperature: options.temperature ?? 0.3,
                    json: true,
                    tier,
                });
                const cleanOutput = prepareModelOutput(chatRes.text, options, requestId);
                const data = extractJson<T>(cleanOutput);
                const telemetry: AIModelTelemetry = {
                    requestId,
                    provider: chatRes.provider,
                    modelId: chatRes.modelUsed,
                    tier,
                    latencyMs: Date.now() - startTime,
                    cached: false,
                    phiScrubber: {
                        inspected: true,
                        redactedCount: totalRedactions,
                        categories: Array.from(redactedCategoriesSet),
                    },
                };
                setInCache(cacheKey, cleanOutput, telemetry);
                if (options.onTelemetry) options.onTelemetry(telemetry);
                return { data, telemetry };
            } catch (error: any) {
                lastErr = error;
                log.warn(`AI Core: primary pool failed for tier [${tier}] (${error?.response?.status || error?.message}).`);
            }
        }

        // Tier 2: paid OpenRouter fallback
        if (USING_OPENROUTER && OPENROUTER_FALLBACK_MODEL) {
            try {
                const raw = await primaryChatBatch([OPENROUTER_FALLBACK_MODEL], safeMessages, { maxTokens, temperature: 0.3, json: true });
                const cleanOutput = prepareModelOutput(raw, options, requestId);
                const data = extractJson<T>(cleanOutput);
                const telemetry: AIModelTelemetry = {
                    requestId,
                    provider: 'meta-openrouter',
                    modelId: OPENROUTER_FALLBACK_MODEL,
                    tier,
                    latencyMs: Date.now() - startTime,
                    cached: false,
                    phiScrubber: {
                        inspected: true,
                        redactedCount: totalRedactions,
                        categories: Array.from(redactedCategoriesSet),
                    },
                };
                setInCache(cacheKey, cleanOutput, telemetry);
                if (options.onTelemetry) options.onTelemetry(telemetry);
                return { data, telemetry };
            } catch (error: any) {
                lastErr = error;
                log.warn(`AI Core: paid fallback ${OPENROUTER_FALLBACK_MODEL} failed (${error?.response?.status || error?.message}).`);
            }
        }

        // Tier 3: Gemini fallback
        if (gemini) {
            try {
                const { system, prompt } = geminiPrompt(safeMessages);
                const response = await gemini.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: prompt,
                    config: { systemInstruction: system, temperature: 0.3, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
                });
                const cleanOutput = prepareModelOutput(response.text || '', options, requestId);
                const data = extractJson<T>(cleanOutput);
                const telemetry: AIModelTelemetry = {
                    requestId,
                    provider: 'gemini-fallback',
                    modelId: GEMINI_MODEL,
                    tier,
                    latencyMs: Date.now() - startTime,
                    cached: false,
                    phiScrubber: {
                        inspected: true,
                        redactedCount: totalRedactions,
                        categories: Array.from(redactedCategoriesSet),
                    },
                };
                setInCache(cacheKey, cleanOutput, telemetry);
                if (options.onTelemetry) options.onTelemetry(telemetry);
                return { data, telemetry };
            } catch (error: any) {
                lastErr = error;
                log.error('AI Core: Gemini fallback failed.', error?.message);
            }
        }

        throw lastErr || new Error('AI Core: all providers failed');
    },

    /**
     * Generate content with structured JSON output (backwards-compatible wrapper).
     * Primary (OpenRouter/Llama) first; Gemini fallback on failure/absence.
     */
    async generateStructured<T>(
        messages: ChatMessage[],
        maxTokens: number = 2000,
        privacy: AIRequestOptions = {},
    ): Promise<T> {
        const { data, telemetry } = await aiCoreService.generateStructuredWithTelemetry<T>(messages, maxTokens, privacy);
        if (privacy.onTelemetry) privacy.onTelemetry(telemetry);
        return data;
    },

    /**
     * Multimodal generation with images (base64 or URLs).
     */
    async generateMultimodalStructured<T>(
        messages: ChatMessage[],
        maxTokens: number = 2500,
        options: AIRequestOptions = {},
    ): Promise<{ data: T; telemetry: AIModelTelemetry }> {
        return aiCoreService.generateStructuredWithTelemetry<T>(messages, maxTokens, {
            ...options,
            tier: options.tier || 'wonder',
        });
    },

    /**
     * Standard text generation.
     * Primary (OpenRouter/Llama) first; Gemini fallback on failure/absence.
     */
    async generateText(
        prompt: string,
        systemInstruction?: string,
        privacy: AIPrivacyOptions = {},
    ): Promise<string> {
        if (!AI_PROVIDERS.anyAvailable()) {
            log.warn('AI Core: no provider configured. Returning empty string.');
            return '';
        }

        const messages: ChatMessage[] = [];
        if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
        messages.push({ role: 'user', content: prompt });

        let lastErr: any;
        const requestId = `ai-${uuidv4()}`;
        const safeMessages = prepareMessages(messages, privacy, requestId);

        // Tier 1: free-model pool (OpenRouter) / configured primary model.
        if (PRIMARY_API_KEY) {
            try {
                const chatRes = await primaryChat(safeMessages, { maxTokens: 2000, temperature: 0.7, json: false });
                return prepareModelOutput(chatRes.text, privacy, requestId);
            } catch (error: any) {
                lastErr = error;
                log.warn(`AI Core: primary/free text-gen failed (${error?.response?.status || error?.message}).`);
            }
        }

        // Tier 2: paid OpenRouter fallback model.
        if (USING_OPENROUTER && OPENROUTER_FALLBACK_MODEL) {
            try {
                const raw = await primaryChatBatch([OPENROUTER_FALLBACK_MODEL], safeMessages, { maxTokens: 2000, temperature: 0.7, json: false });
                return prepareModelOutput(raw, privacy, requestId);
            } catch (error: any) {
                lastErr = error;
                log.warn(`AI Core: paid fallback ${OPENROUTER_FALLBACK_MODEL} text-gen failed (${error?.response?.status || error?.message}).`);
            }
        }

        // Tier 3: Gemini.
        if (gemini) {
            try {
                const { system, prompt: safePrompt } = geminiPrompt(safeMessages);
                const response = await gemini.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: safePrompt,
                    config: { systemInstruction: system, temperature: 0.7 },
                });
                return prepareModelOutput(response.text || '', privacy, requestId);
            } catch (error: any) {
                lastErr = error;
                log.error('AI Core: Gemini text-gen fallback failed.', error?.message);
            }
        }

        throw lastErr || new Error('AI Core: all providers failed (text)');
    },

    callPythonNLP: async (text: string, operation: string, privacy?: AIPrivacyOptions) => {
        if (!aiCoreService.isPythonServiceAvailable()) return null;
        
        const { text: safeText } = enforceAIPrivacyBoundary(text, 'egress', {
            operation: `python-${operation}`,
            ...(privacy || {})
        });

        let result = null;
        if (operation === 'extractEntities') {
            result = await aiPythonService.extractEntities(safeText, 'clinical_note');
        } else if (operation === 'extractMedications') {
            result = await aiPythonService.extractMedications(safeText);
        } else if (operation === 'classifyDocument') {
            result = await aiPythonService.classifyDocument(safeText);
        } else if (operation === 'summarizeClinical') {
            result = await aiPythonService.summarizeClinical(safeText, 'standard');
        }

        if (!result || !result.success) return null;
        return result.data;
    },

    callPythonPrediction: async (data: any, endpoint: string) => {
        if (!aiCoreService.isPythonServiceAvailable()) return null;
        
        let result = null;
        if (endpoint === 'readmission') {
            result = await aiPythonService.predictReadmissionRisk(data);
        } else if (endpoint === 'sepsis') {
            result = await aiPythonService.calculateSepsisScore(data);
        } else if (endpoint === 'los') {
            result = await aiPythonService.estimateLOS(data);
        }
        
        if (!result || !result.success) return null;
        return result.data;
    },

    isPythonServiceAvailable: () => {
        const processEnvEnabled = process.env.AI_PYTHON_SERVICE_ENABLED !== 'false';
        return processEnvEnabled && aiPythonService.getCircuitState().state !== CircuitState.OPEN;
    }

};

export default aiCoreService;
