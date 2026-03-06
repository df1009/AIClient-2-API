#!/usr/bin/env node

/**
 * Proxy Relay - 本地代理加速客户端
 *
 * 通过您的本地网络加速 AI API 访问。
 *
 * 用法:
 *   node proxy-relay.js --token tun-xxx [--proxy http://127.0.0.1:7890]
 */

import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const VERSION = '1.0.0';

// ========== 平台配置（管理员维护） ==========
const PLATFORM_SERVER = 'wss://ai.shopfanli.com/ws/tunnel';
const PLATFORM_NAME = 'API 加速服务';
// =============================================

function parseArgs(argv) {
    const args = { token: '', proxy: '', reconnectInterval: 5000 };
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--token': case '-t': args.token = argv[++i] || ''; break;
            case '--proxy': case '-p': args.proxy = argv[++i] || ''; break;
            case '--reconnect-interval': args.reconnectInterval = parseInt(argv[++i], 10) || 5000; break;
            case '--version': case '-v': console.log(`proxy-relay v${VERSION}`); process.exit(0);
            case '--help': case '-h': printHelp(); process.exit(0);
        }
    }
    return args;
}

function printHelp() {
    console.log(`
proxy-relay v${VERSION} - ${PLATFORM_NAME}

用法:
  node proxy-relay.js --token <token> [options]

必填参数:
  --token,  -t <token>     加速令牌

可选参数:
  --proxy,  -p <url>       本地代理地址 (如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080)
                           不指定则使用系统网络直连
  --reconnect-interval <ms> 断线重连间隔 (默认 5000ms)
  --version, -v            显示版本
  --help, -h               显示帮助
`);
}

function log(level, ...messages) {
    const ts = new Date().toLocaleTimeString();
    const prefix = { info: '✓', warn: '⚠', error: '✗', status: '●' };
    console.log(`[${ts}] ${prefix[level] || '·'}`, ...messages);
}

function createProxyAgent(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        const url = new URL(proxyUrl);
        const protocol = url.protocol.toLowerCase();
        if (protocol === 'socks5:' || protocol === 'socks4:' || protocol === 'socks:') {
            return new SocksProxyAgent(proxyUrl);
        }
        return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
        log('error', `无法解析代理地址: ${e.message}`);
        return null;
    }
}

async function executeRequest(reqMsg, proxyAgent) {
    const { requestId, url, method, headers, body, stream } = reqMsg;
    const fetchOptions = { method: method || 'POST', headers: headers || {} };

    if (proxyAgent) {
        fetchOptions.agent = proxyAgent;
    }

    if (body && method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const controller = new AbortController();
    fetchOptions.signal = controller.signal;
    const timeoutId = setTimeout(() => controller.abort(), 180000);

    try {
        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);
        return { response, requestId, stream };
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

async function handleNonStreamResponse(ws, response, requestId) {
    const responseBody = await response.text();
    const respHeaders = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });

    ws.send(JSON.stringify({
        requestId,
        type: 'response',
        status: response.status,
        headers: respHeaders,
        body: responseBody
    }));
}

async function handleStreamResponse(ws, response, requestId) {
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ws.readyState !== WebSocket.OPEN) break;

            const base64Data = Buffer.from(value).toString('base64');
            ws.send(JSON.stringify({
                requestId,
                type: 'stream_chunk',
                data: base64Data
            }));
        }
    } finally {
        reader.releaseLock();
    }

    const respHeaders = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });

    ws.send(JSON.stringify({
        requestId,
        type: 'stream_end',
        status: response.status,
        headers: respHeaders
    }));
}

function connect(args) {
    const { token, proxy, reconnectInterval } = args;
    const server = PLATFORM_SERVER;
    const wsUrl = `${server}${server.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
    const proxyAgent = createProxyAgent(proxy);
    let ws;
    let reconnectTimer = null;
    let isShuttingDown = false;
    let activeRequests = 0;

    function scheduleReconnect() {
        if (isShuttingDown) return;
        if (reconnectTimer) return;
        log('info', `${reconnectInterval / 1000}秒后重连...`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            doConnect();
        }, reconnectInterval);
    }

    function doConnect() {
        if (isShuttingDown) return;
        log('status', `正在连接${PLATFORM_NAME}...`);

        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            log('error', `连接失败: ${e.message}`);
            scheduleReconnect();
            return;
        }

        ws.on('open', () => {
            log('info', '连接成功');
            log('info', `加速令牌: ${token.slice(0, 8)}...`);
            if (proxy) log('info', `本地代理: ${proxy}`);
            log('status', '加速服务运行中，等待请求...');
        });

        ws.on('message', async (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }

            if (msg.type !== 'request') return;

            activeRequests++;
            const shortUrl = msg.url ? new URL(msg.url).hostname : 'unknown';
            log('info', `[${msg.requestId.slice(0, 8)}] ${msg.stream ? '流式' : '普通'}请求 -> ${shortUrl}${proxyAgent ? ' (代理)' : ' (直连)'}`);

            try {
                const { response, requestId, stream } = await executeRequest(msg, proxyAgent);

                if (stream) {
                    await handleStreamResponse(ws, response, requestId);
                } else {
                    await handleNonStreamResponse(ws, response, requestId);
                }
                log('info', `[${requestId.slice(0, 8)}] 完成 (${response.status})`);
            } catch (err) {
                log('error', `[${msg.requestId.slice(0, 8)}] 失败: ${err.message}`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        requestId: msg.requestId,
                        type: 'error',
                        message: err.message
                    }));
                }
            } finally {
                activeRequests--;
            }
        });

        ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : '';
            if (code === 4001 || code === 4003) {
                log('error', `认证失败: ${reasonStr || '令牌无效，请检查您的加速令牌'}`);
                return;
            }
            log('warn', `连接断开 (${code})`);
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            if (err.code === 'ECONNREFUSED') {
                log('error', '无法连接到服务器，请检查网络');
            } else {
                log('error', `连接错误: ${err.message}`);
            }
        });

        ws.on('ping', () => {
            try { ws.pong(); } catch {}
        });
    }

    doConnect();

    process.on('SIGINT', () => {
        isShuttingDown = true;
        log('info', '正在关闭...');
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Client shutdown');
        }
        setTimeout(() => process.exit(0), 1000);
    });

    process.on('SIGTERM', () => {
        isShuttingDown = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Client shutdown');
        }
        setTimeout(() => process.exit(0), 1000);
    });
}

// --- Main ---
const args = parseArgs(process.argv);

if (!args.token) {
    console.error('错误: 必须提供 --token 参数\n');
    printHelp();
    process.exit(1);
}

log('status', `proxy-relay v${VERSION}`);
connect(args);
