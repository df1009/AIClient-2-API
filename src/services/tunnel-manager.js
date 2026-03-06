import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';

const HEARTBEAT_INTERVAL = 30000;
const PONG_TIMEOUT = 10000;
const DEFAULT_REQUEST_TIMEOUT = 120000;

class TunnelManager {
    constructor() {
        this.wss = null;
        this.tunnels = new Map();
        this.pendingRequests = new Map();
        this.heartbeatTimer = null;
        this.config = {};
    }

    initialize(httpServer, config) {
        this.config = config;
        this.wss = new WebSocketServer({ noServer: true });

        httpServer.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            const tunnelPath = config.TUNNEL_PATH || '/ws/tunnel';

            if (url.pathname === tunnelPath) {
                this.wss.handleUpgrade(request, socket, head, (ws) => {
                    this._handleConnection(ws, request, url);
                });
            }
        });

        this._startHeartbeat();
        logger.info(`[Tunnel] Manager initialized, path: ${config.TUNNEL_PATH || '/ws/tunnel'}`);
    }

    _handleConnection(ws, request, url) {
        const token = url.searchParams.get('token');
        if (!token) {
            logger.warn('[Tunnel] Connection rejected: missing token');
            ws.close(4001, 'Token required');
            return;
        }

        const validTokens = this.config.TUNNEL_TOKENS || {};
        if (Object.keys(validTokens).length > 0 && !validTokens[token]) {
            logger.warn(`[Tunnel] Connection rejected: invalid token ${token.slice(0, 8)}...`);
            ws.close(4003, 'Invalid token');
            return;
        }

        const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || request.headers['x-real-ip']
            || request.socket.remoteAddress;

        const tunnelInfo = {
            ws,
            token,
            ip,
            connectedAt: Date.now(),
            lastPong: Date.now(),
            alive: true
        };

        if (!this.tunnels.has(token)) {
            this.tunnels.set(token, []);
        }
        this.tunnels.get(token).push(tunnelInfo);

        const tokenLabel = validTokens[token]?.name || token.slice(0, 8);
        logger.info(`[Tunnel] Client connected: ${tokenLabel} from ${ip} (total: ${this.tunnels.get(token).length})`);

        ws.on('message', (data) => {
            this._handleMessage(data, tunnelInfo);
        });

        ws.on('close', (code, reason) => {
            this._removeConnection(tunnelInfo);
            logger.info(`[Tunnel] Client disconnected: ${tokenLabel} (code: ${code})`);
        });

        ws.on('error', (err) => {
            logger.error(`[Tunnel] WebSocket error for ${tokenLabel}: ${err.message}`);
            this._removeConnection(tunnelInfo);
        });

        ws.on('pong', () => {
            tunnelInfo.lastPong = Date.now();
            tunnelInfo.alive = true;
        });
    }

    _handleMessage(data, tunnelInfo) {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (e) {
            logger.error('[Tunnel] Invalid JSON message received');
            return;
        }

        const { requestId } = msg;
        if (!requestId) return;

        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
            logger.warn(`[Tunnel] No pending request for ID: ${requestId}`);
            return;
        }

        switch (msg.type) {
            case 'response':
                this.pendingRequests.delete(requestId);
                clearTimeout(pending.timer);
                pending.resolve({
                    status: msg.status || 200,
                    headers: msg.headers || {},
                    body: msg.body
                });
                break;

            case 'stream_chunk':
                if (pending.onChunk) {
                    pending.onChunk(msg.data);
                }
                break;

            case 'stream_end':
                this.pendingRequests.delete(requestId);
                clearTimeout(pending.timer);
                if (pending.onEnd) {
                    pending.onEnd({
                        status: msg.status || 200,
                        headers: msg.headers || {}
                    });
                }
                break;

            case 'error':
                this.pendingRequests.delete(requestId);
                clearTimeout(pending.timer);
                pending.reject(new Error(msg.message || 'Tunnel request failed'));
                break;

            default:
                logger.warn(`[Tunnel] Unknown message type: ${msg.type}`);
        }
    }

    _removeConnection(tunnelInfo) {
        const { token } = tunnelInfo;
        const connections = this.tunnels.get(token);
        if (!connections) return;

        const idx = connections.indexOf(tunnelInfo);
        if (idx !== -1) connections.splice(idx, 1);
        if (connections.length === 0) this.tunnels.delete(token);
    }

    _startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            if (!this.wss) return;

            for (const [token, connections] of this.tunnels.entries()) {
                for (let i = connections.length - 1; i >= 0; i--) {
                    const info = connections[i];
                    if (!info.alive) {
                        logger.warn(`[Tunnel] Terminating unresponsive connection: ${token.slice(0, 8)}`);
                        info.ws.terminate();
                        connections.splice(i, 1);
                        continue;
                    }
                    info.alive = false;
                    try {
                        info.ws.ping();
                    } catch (e) {
                        info.ws.terminate();
                        connections.splice(i, 1);
                    }
                }
                if (connections.length === 0) this.tunnels.delete(token);
            }
        }, HEARTBEAT_INTERVAL);
    }

    _getConnection(tunnelId) {
        const connections = this.tunnels.get(tunnelId);
        if (!connections || connections.length === 0) return null;
        const alive = connections.filter(c => c.ws.readyState === 1);
        if (alive.length === 0) return null;
        return alive[Math.floor(Math.random() * alive.length)];
    }

    hasActiveTunnel(tunnelId) {
        if (!tunnelId) return false;
        return !!this._getConnection(tunnelId);
    }

    /**
     * Send a non-streaming request through the tunnel.
     * Returns a Promise that resolves with { status, headers, body }.
     */
    sendRequest(tunnelId, requestOptions) {
        return new Promise((resolve, reject) => {
            const conn = this._getConnection(tunnelId);
            if (!conn) {
                reject(new Error(`No active tunnel for ${tunnelId}`));
                return;
            }

            const requestId = randomUUID();
            const timeout = this.config.TUNNEL_TIMEOUT || DEFAULT_REQUEST_TIMEOUT;

            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Tunnel request timeout after ${timeout}ms`));
            }, timeout);

            this.pendingRequests.set(requestId, { resolve, reject, timer });

            try {
                conn.ws.send(JSON.stringify({
                    requestId,
                    type: 'request',
                    url: requestOptions.url,
                    method: requestOptions.method || 'POST',
                    headers: requestOptions.headers || {},
                    body: requestOptions.body || '',
                    stream: false
                }));
            } catch (e) {
                this.pendingRequests.delete(requestId);
                clearTimeout(timer);
                reject(new Error(`Failed to send through tunnel: ${e.message}`));
            }
        });
    }

    /**
     * Send a streaming request through the tunnel.
     * Returns an async generator that yields chunks.
     */
    async *sendStreamRequest(tunnelId, requestOptions) {
        const conn = this._getConnection(tunnelId);
        if (!conn) {
            throw new Error(`No active tunnel for ${tunnelId}`);
        }

        const requestId = randomUUID();
        const timeout = this.config.TUNNEL_TIMEOUT || DEFAULT_REQUEST_TIMEOUT;
        const chunkQueue = [];
        let streamResolve = null;
        let streamDone = false;
        let streamError = null;

        const timer = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            streamError = new Error(`Tunnel stream timeout after ${timeout}ms`);
            if (streamResolve) streamResolve();
        }, timeout);

        this.pendingRequests.set(requestId, {
            resolve: () => {},
            reject: (err) => {
                streamError = err;
                if (streamResolve) streamResolve();
            },
            timer,
            onChunk: (data) => {
                chunkQueue.push(data);
                if (streamResolve) streamResolve();
            },
            onEnd: (info) => {
                streamDone = true;
                clearTimeout(timer);
                this.pendingRequests.delete(requestId);
                if (streamResolve) streamResolve();
            }
        });

        try {
            conn.ws.send(JSON.stringify({
                requestId,
                type: 'request',
                url: requestOptions.url,
                method: requestOptions.method || 'POST',
                headers: requestOptions.headers || {},
                body: requestOptions.body || '',
                stream: true
            }));
        } catch (e) {
            this.pendingRequests.delete(requestId);
            clearTimeout(timer);
            throw new Error(`Failed to send stream through tunnel: ${e.message}`);
        }

        while (true) {
            while (chunkQueue.length > 0) {
                yield chunkQueue.shift();
            }

            if (streamDone) break;
            if (streamError) throw streamError;

            await new Promise(r => { streamResolve = r; });
            streamResolve = null;
        }
    }

    getStatus() {
        const tunnels = [];
        for (const [token, connections] of this.tunnels.entries()) {
            const name = this.config.TUNNEL_TOKENS?.[token]?.name || token.slice(0, 8);
            tunnels.push({
                token: token.slice(0, 8) + '...',
                name,
                connections: connections.length,
                alive: connections.filter(c => c.ws.readyState === 1).length,
                connectedAt: connections[0]?.connectedAt,
                ip: connections[0]?.ip
            });
        }
        return {
            enabled: true,
            totalTunnels: this.tunnels.size,
            totalConnections: [...this.tunnels.values()].reduce((s, c) => s + c.length, 0),
            pendingRequests: this.pendingRequests.size,
            tunnels
        };
    }

    shutdown() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const [, connections] of this.tunnels.entries()) {
            for (const info of connections) {
                info.ws.close(1001, 'Server shutting down');
            }
        }
        this.tunnels.clear();
        for (const [id, pending] of this.pendingRequests.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Tunnel manager shutting down'));
        }
        this.pendingRequests.clear();
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        logger.info('[Tunnel] Manager shut down');
    }
}

let tunnelManagerInstance = null;

export function getTunnelManager() {
    if (!tunnelManagerInstance) {
        tunnelManagerInstance = new TunnelManager();
    }
    return tunnelManagerInstance;
}

export function initializeTunnelManager(httpServer, config) {
    const manager = getTunnelManager();
    manager.initialize(httpServer, config);
    return manager;
}
