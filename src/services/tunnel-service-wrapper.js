/**
 * Tunnel Service Wrapper
 *
 * Wraps a provider service so that its HTTP calls go through the WebSocket
 * tunnel instead of being sent directly from the server.  The wrapper
 * reconstructs the full URL and headers that the underlying provider would
 * have used and delegates them to the tunnel client.
 */

import logger from '../utils/logger.js';
import { getTunnelManager } from './tunnel-manager.js';

/**
 * Build the full target URL and auth headers for a given provider service.
 */
function resolveProviderEndpoint(service, endpoint) {
    const meta = { url: '', headers: {} };

    if (service.baseUrl || service.config?.OPENAI_BASE_URL || service.config?.CLAUDE_BASE_URL) {
        const base = (service.baseUrl
            || service.config?.OPENAI_BASE_URL
            || service.config?.CLAUDE_BASE_URL
            || '').replace(/\/+$/, '');
        meta.url = `${base}${endpoint}`;
    }

    if (service.axiosInstance?.defaults) {
        const d = service.axiosInstance.defaults;
        if (d.baseURL) {
            meta.url = `${d.baseURL.replace(/\/+$/, '')}${endpoint}`;
        }
        if (d.headers) {
            const h = d.headers;
            if (h.Authorization) meta.headers['Authorization'] = h.Authorization;
            if (h['x-api-key']) meta.headers['x-api-key'] = h['x-api-key'];
            if (h['anthropic-version']) meta.headers['anthropic-version'] = h['anthropic-version'];
            if (h['Content-Type']) meta.headers['Content-Type'] = h['Content-Type'];
        }
    }

    if (service.client?.defaults) {
        const d = service.client.defaults;
        if (d.baseURL) {
            meta.url = `${d.baseURL.replace(/\/+$/, '')}${endpoint}`;
        }
        if (d.headers) {
            const h = d.headers;
            if (h['x-api-key']) meta.headers['x-api-key'] = h['x-api-key'];
            if (h['anthropic-version']) meta.headers['anthropic-version'] = h['anthropic-version'];
            if (h['Content-Type']) meta.headers['Content-Type'] = h['Content-Type'];
        }
    }

    if (!meta.headers['Content-Type']) {
        meta.headers['Content-Type'] = 'application/json';
    }

    return meta;
}

/**
 * Detect what endpoint a provider service uses for a given method call.
 */
function getEndpointForMethod(service, methodName) {
    const svc = getUnwrappedService(service);
    const className = svc.constructor?.name || '';

    const endpointMap = {
        'OpenAIApiService': { generate: '/chat/completions', stream: '/chat/completions', models: '/models' },
        'OpenAIResponsesApiService': { generate: '/responses', stream: '/responses', models: '/models' },
        'ClaudeApiService': { generate: '/messages', stream: '/messages', models: null },
        'KiroApiService': { generate: '/messages', stream: '/messages', models: null },
        'QwenApiService': { generate: '/chat/completions', stream: '/chat/completions', models: '/models' },
        'IFlowApiService': { generate: '/chat/completions', stream: '/chat/completions', models: '/models' },
        'CodexApiService': { generate: '/chat/completions', stream: '/chat/completions', models: '/models' },
        'ForwardApiService': { generate: '', stream: '', models: '/models' },
    };

    const map = endpointMap[className];
    if (!map) return null;
    return map[methodName] ?? null;
}

function getUnwrappedService(service) {
    const inner = service.openAIApiService
        || service.openAIResponsesApiService
        || service.claudeApiService
        || service.kiroApiService
        || service.geminiApiService
        || service.antigravityApiService
        || service.qwenApiService
        || service.iflowApiService
        || service.codexApiService
        || service.forwardApiService;
    return inner || service;
}

function isGeminiProvider(service) {
    const svc = getUnwrappedService(service);
    const name = svc.constructor?.name || '';
    return name === 'GeminiApiService' || name === 'AntigravityApiService';
}

/**
 * Create a wrapped service that tunnels generateContent and generateContentStream.
 * Falls through to the original service for methods that don't need tunneling.
 */
export function createTunnelServiceWrapper(originalService, tunnelId, config) {
    const inner = getUnwrappedService(originalService);

    if (isGeminiProvider(originalService)) {
        return createGeminiTunnelWrapper(originalService, inner, tunnelId, config);
    }

    return createAxiosTunnelWrapper(originalService, inner, tunnelId, config);
}

function createAxiosTunnelWrapper(originalService, inner, tunnelId, config) {
    const wrapper = Object.create(originalService);

    wrapper.generateContent = async function (model, requestBody) {
        if (requestBody._monitorRequestId) {
            inner.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }

        const endpoint = getEndpointForMethod(originalService, 'generate') || '/chat/completions';
        const meta = resolveProviderEndpoint(inner, endpoint);

        if (!meta.url) {
            logger.warn('[Tunnel] Could not resolve URL, falling back to direct call');
            return originalService.generateContent(model, requestBody);
        }

        logger.info(`[Tunnel] Routing non-stream request via tunnel ${tunnelId.slice(0, 8)} -> ${new URL(meta.url).hostname}`);

        const tm = getTunnelManager();
        const resp = await tm.sendRequest(tunnelId, {
            url: meta.url,
            method: 'POST',
            headers: meta.headers,
            body: JSON.stringify(requestBody)
        });

        if (resp.status >= 400) {
            const error = new Error(`Tunnel upstream error: ${resp.status}`);
            error.response = { status: resp.status, data: tryParse(resp.body) };
            throw error;
        }

        return tryParse(resp.body);
    };

    wrapper.generateContentStream = async function* (model, requestBody) {
        if (requestBody._monitorRequestId) {
            inner.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }

        const endpoint = getEndpointForMethod(originalService, 'stream') || '/chat/completions';
        const meta = resolveProviderEndpoint(inner, endpoint);

        if (!meta.url) {
            logger.warn('[Tunnel] Could not resolve URL for stream, falling back');
            yield* originalService.generateContentStream(model, requestBody);
            return;
        }

        const streamBody = { ...requestBody, stream: true };

        logger.info(`[Tunnel] Routing stream request via tunnel ${tunnelId.slice(0, 8)} -> ${new URL(meta.url).hostname}`);

        const tm = getTunnelManager();
        let buffer = '';

        for await (const base64Chunk of tm.sendStreamRequest(tunnelId, {
            url: meta.url,
            method: 'POST',
            headers: meta.headers,
            body: JSON.stringify(streamBody)
        })) {
            const text = Buffer.from(base64Chunk, 'base64').toString('utf-8');
            buffer += text;

            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, newlineIndex).trim();
                buffer = buffer.substring(newlineIndex + 1);

                if (line.startsWith('data: ')) {
                    const jsonData = line.substring(6).trim();
                    if (jsonData === '[DONE]') return;
                    try {
                        yield JSON.parse(jsonData);
                    } catch (e) {
                        // not JSON, skip
                    }
                } else if (line.startsWith('{')) {
                    try {
                        yield JSON.parse(line);
                    } catch (e) {}
                }
            }
        }

        if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ')) {
                    const jsonData = trimmed.substring(6).trim();
                    if (jsonData !== '[DONE]') {
                        try { yield JSON.parse(jsonData); } catch (e) {}
                    }
                } else if (trimmed.startsWith('{')) {
                    try { yield JSON.parse(trimmed); } catch (e) {}
                }
            }
        }
    };

    wrapper.listModels = originalService.listModels.bind(originalService);
    wrapper.refreshToken = originalService.refreshToken?.bind(originalService);
    wrapper.forceRefreshToken = originalService.forceRefreshToken?.bind(originalService);
    wrapper.isExpiryDateNear = originalService.isExpiryDateNear?.bind(originalService);
    wrapper.countTokens = originalService.countTokens?.bind(originalService);
    wrapper.estimateInputTokens = originalService.estimateInputTokens?.bind(originalService);

    return wrapper;
}

function createGeminiTunnelWrapper(originalService, inner, tunnelId, config) {
    const wrapper = Object.create(originalService);

    const isAntigravity = inner.constructor?.name === 'AntigravityApiService';
    const apiVersion = inner.apiVersion || 'v1internal';

    function getGeminiUrl(action) {
        if (isAntigravity) {
            const baseURL = (inner.baseURLs && inner.baseURLs[0]) || 'https://cloudcode-pa.googleapis.com';
            return `${baseURL}/${apiVersion}:${action}`;
        }
        const endpoint = inner.codeAssistEndpoint || inner.config?.GEMINI_BASE_URL || 'https://cloudcode-pa.googleapis.com';
        return `${endpoint.replace(/\/+$/, '')}/${apiVersion}:${action}`;
    }

    async function getAuthHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        try {
            if (inner.authClient) {
                const token = inner.authClient.credentials?.access_token;
                if (token) {
                    headers['Authorization'] = `Bearer ${token}`;
                }
            }
        } catch (e) {
            logger.warn('[Tunnel] Failed to get Gemini auth token');
        }
        if (isAntigravity && inner.userAgent) {
            headers['User-Agent'] = inner.userAgent;
        }
        return headers;
    }

    wrapper.generateContent = async function (model, requestBody) {
        if (requestBody._monitorRequestId) {
            inner.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }

        const url = getGeminiUrl('generateContent');
        const headers = await getAuthHeaders();

        logger.info(`[Tunnel] Routing Gemini request via tunnel ${tunnelId.slice(0, 8)} -> ${new URL(url).hostname}`);

        const tm = getTunnelManager();
        const resp = await tm.sendRequest(tunnelId, {
            url,
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        });

        if (resp.status >= 400) {
            const error = new Error(`Tunnel upstream error: ${resp.status}`);
            error.response = { status: resp.status, data: tryParse(resp.body) };
            throw error;
        }

        return tryParse(resp.body);
    };

    wrapper.generateContentStream = async function* (model, requestBody) {
        if (requestBody._monitorRequestId) {
            inner.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }

        const url = getGeminiUrl('streamGenerateContent');
        const headers = await getAuthHeaders();

        logger.info(`[Tunnel] Routing Gemini stream via tunnel ${tunnelId.slice(0, 8)} -> ${new URL(url).hostname}`);

        const tm = getTunnelManager();
        let buffer = '';

        for await (const base64Chunk of tm.sendStreamRequest(tunnelId, {
            url: `${url}?alt=sse`,
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        })) {
            const text = Buffer.from(base64Chunk, 'base64').toString('utf-8');
            buffer += text;

            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, newlineIndex).trim();
                buffer = buffer.substring(newlineIndex + 1);

                if (line.startsWith('data: ')) {
                    const jsonData = line.substring(6).trim();
                    try {
                        yield JSON.parse(jsonData);
                    } catch (e) {}
                } else if (line.startsWith('{')) {
                    try {
                        yield JSON.parse(line);
                    } catch (e) {}
                }
            }
        }

        if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ')) {
                    try { yield JSON.parse(trimmed.substring(6).trim()); } catch (e) {}
                } else if (trimmed.startsWith('{')) {
                    try { yield JSON.parse(trimmed); } catch (e) {}
                }
            }
        }
    };

    wrapper.listModels = originalService.listModels.bind(originalService);
    wrapper.refreshToken = originalService.refreshToken?.bind(originalService);
    wrapper.forceRefreshToken = originalService.forceRefreshToken?.bind(originalService);
    wrapper.isExpiryDateNear = originalService.isExpiryDateNear?.bind(originalService);

    return wrapper;
}

function tryParse(str) {
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}
