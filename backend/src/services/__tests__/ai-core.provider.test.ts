/**
 * AI provider failover: Llama primary, Gemini fallback.
 * We mock axios (Llama) and @google/genai (Gemini) and assert routing.
 */
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ 
    __esModule: true, 
    default: { 
        post: (...a: any[]) => mockAxiosPost(...a),
        create: () => ({ post: (...a: any[]) => mockAxiosPost(...a) })
    } 
}));

const mockGenerate = jest.fn();
jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: { generateContent: (...a: any[]) => mockGenerate(...a) },
    })),
}));

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function loadService() {
    let svc: any;
    jest.isolateModules(() => { svc = require('../ai-core.service'); });
    return svc;
}

const OLD_ENV = process.env;
beforeEach(() => {
    jest.resetModules();
    mockAxiosPost.mockReset();
    mockGenerate.mockReset();
    process.env = { ...OLD_ENV };
    // Provider selection is module-initialized. Keep the developer's local
    // environment from silently changing these isolated routing scenarios.
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_PRIMARY_URL;
    delete process.env.AI_PRIMARY_MODEL;
    delete process.env.AI_PRIMARY_FALLBACK_MODELS;
    delete process.env.AI_FALLBACK_MODEL;
    process.env.ALLOW_LIVE_AI_TESTS = 'true';
});
afterAll(() => { process.env = OLD_ENV; });

describe('aiCoreService provider failover', () => {
    it('uses Llama when LLAMA_API_TOKEN is set', async () => {
        process.env.LLAMA_API_TOKEN = 'llama-key';
        process.env.GEMINI_API_KEY = 'gem-key';
        mockAxiosPost.mockResolvedValue({ data: { choices: [{ message: { content: '{"ok":true}' } }] } });
        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured([{ role: 'user', content: 'hi' }]);
        expect(out).toEqual({ ok: true });
        expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('falls back to Gemini when Llama errors', async () => {
        process.env.LLAMA_API_TOKEN = 'llama-key';
        process.env.GEMINI_API_KEY = 'gem-key';
        mockAxiosPost.mockRejectedValue(new Error('llama 503'));
        mockGenerate.mockResolvedValue({ text: '{"ok":"gemini"}' });
        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured([{ role: 'user', content: 'hi' }]);
        expect(out).toEqual({ ok: 'gemini' });
        expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('uses Gemini directly when only GEMINI_API_KEY is set', async () => {
        delete process.env.LLAMA_API_TOKEN;
        process.env.GEMINI_API_KEY = 'gem-key';
        mockGenerate.mockResolvedValue({ text: '{"src":"gem"}' });
        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured([{ role: 'user', content: 'hi' }]);
        expect(out).toEqual({ src: 'gem' });
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    it('throws when no provider is configured', async () => {
        delete process.env.LLAMA_API_TOKEN;
        delete process.env.GEMINI_API_KEY;
        const { aiCoreService } = loadService();
        await expect(aiCoreService.generateStructured([{ role: 'user', content: 'hi' }])).rejects.toThrow(/not configured/i);
    });

    it('propagates the Llama error when Llama fails and no Gemini fallback exists', async () => {
        process.env.LLAMA_API_TOKEN = 'llama-key';
        delete process.env.GEMINI_API_KEY;
        mockAxiosPost.mockRejectedValue(new Error('llama down'));
        const { aiCoreService } = loadService();
        await expect(aiCoreService.generateStructured([{ role: 'user', content: 'hi' }])).rejects.toThrow(/llama down/);
    });

    it('AI_PROVIDERS reflects configured providers', () => {
        process.env.LLAMA_API_TOKEN = 'llama-key';
        delete process.env.GEMINI_API_KEY;
        const { AI_PROVIDERS } = loadService();
        expect(AI_PROVIDERS.llamaAvailable()).toBe(true);
        expect(AI_PROVIDERS.geminiAvailable()).toBe(false);
        expect(AI_PROVIDERS.anyAvailable()).toBe(true);
    });

    it('de-identifies every provider egress and model ingress', async () => {
        process.env.LLAMA_API_TOKEN = 'llama-key';
        delete process.env.GEMINI_API_KEY;
        mockAxiosPost.mockResolvedValue({
            data: {
                choices: [{
                    message: {
                        content: '{"summary":"Patient Name: Ada Obi; email ada@example.com; clinically stable"}',
                    },
                }],
            },
        });

        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured(
            [{
                role: 'user',
                content: 'Patient Name: Ada Obi; call +2348012345678; MRN DCR-MRN-0000000001-X; prescription DCR-RX-2026-0000000123-A',
            }],
            500,
            { operation: 'privacy-regression', knownIdentifiers: ['Ada', 'Ada Obi'] },
        );

        const providerBody = mockAxiosPost.mock.calls[0][1];
        const sent = JSON.stringify(providerBody.messages);
        expect(sent).not.toMatch(/Ada Obi|2348012345678|DCR-MRN|DCR-RX/);
        expect(JSON.stringify(out)).not.toMatch(/Ada Obi|ada@example\.com/);
        expect(out.summary).toContain('[NAME_REDACTED]');
        expect(out.summary).toContain('[EMAIL_REDACTED]');
    });

    it('trims trailing newlines and normalizes underscore delimiters in LLAMA_API_TOKEN for direct Meta API', async () => {
        process.env.LLAMA_API_TOKEN = 'LLM_1457_secret-token\n\n';
        process.env.LLAMA_MODEL = 'Llama-4-Maverick-17B-128E-Instruct-FP8';
        delete process.env.GEMINI_API_KEY;
        mockAxiosPost.mockResolvedValue({ data: { choices: [{ message: { content: '{"ok":true}' } }] } });

        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured([{ role: 'user', content: 'hi' }]);

        expect(out).toEqual({ ok: true });
        const [url, body, config] = mockAxiosPost.mock.calls[0];
        expect(url).toBe('https://api.meta.ai/v1/chat/completions');
        expect(body.model).toBe('muse-wonder-1.0');
        expect(config.headers.Authorization).toBe('Bearer LLM|1457|secret-token');
    });

    it('normalizes Llama-4-Maverick-17B-128E-Instruct-FP8 to meta-llama/llama-4-maverick when routing via OpenRouter', async () => {
        process.env.LLAMA_API_TOKEN = 'sk-or-v1-test-key\n';
        process.env.LLAMA_MODEL = 'Llama-4-Maverick-17B-128E-Instruct-FP8';
        delete process.env.GEMINI_API_KEY;
        mockAxiosPost.mockResolvedValue({ data: { choices: [{ message: { content: '{"ok":"llama4"}' } }] } });

        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured([{ role: 'user', content: 'hi' }]);

        expect(out).toEqual({ ok: 'llama4' });
        const [url, body, config] = mockAxiosPost.mock.calls[0];
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(body.model).toBe('meta-llama/llama-4-maverick');
        expect(config.headers.Authorization).toBe('Bearer sk-or-v1-test-key');
    });

    it('fails over to Baseten with model meta-models/muse-spark-open-1026 when Meta API fails', async () => {
        process.env.LLAMA_API_TOKEN = 'llama-key';
        process.env.BASETEN_API_KEY = 'baseten-test-key';
        delete process.env.GEMINI_API_KEY;

        // First call (Meta API) fails with 503; second call (Baseten failover) succeeds
        mockAxiosPost
            .mockRejectedValueOnce(new Error('Meta API 503 Service Unavailable'))
            .mockResolvedValueOnce({
                data: {
                    choices: [{
                        message: {
                            content: '{"ok":"baseten-success","provider":"baseten"}',
                        },
                    }],
                },
            });

        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured([{ role: 'user', content: 'test baseten failover' }]);

        expect(out).toEqual({ ok: 'baseten-success', provider: 'baseten' });
        expect(mockAxiosPost).toHaveBeenCalledTimes(2);

        // First call was to direct Meta API
        const [firstUrl] = mockAxiosPost.mock.calls[0];
        expect(firstUrl).toBe('https://api.meta.ai/v1/chat/completions');

        // Second call was to Baseten hackathon endpoint with official model ID
        const [secondUrl, secondBody, secondConfig] = mockAxiosPost.mock.calls[1];
        expect(secondUrl).toBe('https://inference.baseten.co/v1/chat/completions');
        expect(secondBody.model).toBe('meta-models/muse-spark-open-1026');
        expect(secondConfig.headers.Authorization).toBe('Bearer baseten-test-key');
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('falls back to Gemini when both Meta API and Baseten fail', async () => {
        process.env.LLAMA_API_TOKEN = 'llama-key';
        process.env.BASETEN_API_KEY = 'baseten-test-key';
        process.env.GEMINI_API_KEY = 'gem-key';

        mockAxiosPost
            .mockRejectedValueOnce(new Error('Meta API 503'))
            .mockRejectedValueOnce(new Error('Baseten candidate 1 429 Rate Limit'))
            .mockRejectedValueOnce(new Error('Baseten candidate 2 429 Rate Limit'));

        mockGenerate.mockResolvedValue({ text: '{"fallback":"gemini"}' });

        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured([{ role: 'user', content: 'test dual failover' }]);

        expect(out).toEqual({ fallback: 'gemini' });
        expect(mockAxiosPost).toHaveBeenCalledTimes(3);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('uses Baseten directly when only BASETEN_API_KEY is configured', async () => {
        delete process.env.LLAMA_API_TOKEN;
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.GEMINI_API_KEY;
        process.env.BASETEN_API_KEY = 'baseten-direct-key';

        mockAxiosPost.mockResolvedValueOnce({
            data: {
                choices: [{
                    message: {
                        content: '{"direct":"baseten"}',
                    },
                }],
            },
        });

        const { aiCoreService } = loadService();
        const out = await aiCoreService.generateStructured([{ role: 'user', content: 'hello' }]);

        expect(out).toEqual({ direct: 'baseten' });
        const [url, body, config] = mockAxiosPost.mock.calls[0];
        expect(url).toBe('https://inference.baseten.co/v1/chat/completions');
        expect(body.model).toBe('meta-models/muse-spark-open-1026');
        expect(config.headers.Authorization).toBe('Bearer baseten-direct-key');
    });

    it('normalizes meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8 to muse-wonder-1.0 on direct Meta API', async () => {
        process.env.LLAMA_API_TOKEN = 'LLM_1234_key';
        process.env.LLAMA_MODEL = 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8';
        delete process.env.GEMINI_API_KEY;
        mockAxiosPost.mockResolvedValue({ data: { choices: [{ message: { content: '{"ok":true}' } }] } });

        const { aiCoreService } = loadService();
        await aiCoreService.generateStructured([{ role: 'user', content: 'hi' }]);

        const [url, body] = mockAxiosPost.mock.calls[0];
        expect(url).toBe('https://api.meta.ai/v1/chat/completions');
        expect(body.model).toBe('muse-wonder-1.0');
    });
});

