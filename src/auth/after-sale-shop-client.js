import axios from 'axios';
import logger from '../utils/logger.js';

const LOG_PREFIX = '[AfterSale]';

export class AfterSaleShopClient {
    /**
     * @param {string} baseUrl - 商城 API 地址，如 "https://kiroshop.xyz"
     * @param {string} email - 商城登录邮箱
     * @param {string} password - 商城登录密码
     */
    constructor(baseUrl, email, password) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.email = email;
        this.password = password;
        this._token = null;           // 内存缓存 shopToken
        this._tokenPromise = null;    // 互斥锁：防止并发登录
    }

    /**
     * 确保 token 有效，首次调用或 token 失效时自动登录
     * 使用 Promise 缓存实现互斥锁，防止并发请求同时触发多次登录
     * @returns {Promise<string>} shopToken
     */
    async _ensureToken() {
        if (this._token) return this._token;
        if (this._tokenPromise) return this._tokenPromise;

        this._tokenPromise = this._login();
        try {
            this._token = await this._tokenPromise;
            return this._token;
        } finally {
            this._tokenPromise = null;
        }
    }

    /**
     * 登录商城获取 JWT Token
     * POST {baseUrl}/shop/api/auth/login
     * @returns {Promise<string>} token
     * @throws {Error} 登录失败时抛出
     */
    async _login() {
        const url = `${this.baseUrl}/shop/api/auth/login`;
        logger.info(`${LOG_PREFIX} Logging in to shop: ${this.baseUrl}`);
        try {
            const resp = await axios.post(url, {
                email: this.email,
                password: this.password
            }, { timeout: 15000 });

            if (resp.data?.success && resp.data?.token) {
                logger.info(`${LOG_PREFIX} Shop login successful`);
                return resp.data.token;
            }
            throw new Error('Shop login failed: unexpected response');
        } catch (error) {
            const status = error.response?.status;
            const msg = error.response?.data?.message || error.message;
            logger.error(`${LOG_PREFIX} Shop login failed (HTTP ${status}): ${msg}`);
            throw new Error(`Shop login failed: ${msg}`);
        }
    }

    /**
     * 清除缓存的 token（配置变更时调用）
     */
    clearToken() {
        this._token = null;
        this._tokenPromise = null;
    }

    /**
     * 带 token 的请求封装，401 时自动重新登录并重试（仅重试 1 次）
     * @param {string} method - HTTP 方法
     * @param {string} path - API 路径（不含 baseUrl）
     * @param {Object} [body] - 请求体
     * @returns {Promise<Object>} 响应 data
     */
    async _requestWithAuth(method, path, body = null) {
        const token = await this._ensureToken();
        const url = `${this.baseUrl}${path}`;
        const config = {
            method,
            url,
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15000
        };
        if (body) config.data = body;

        try {
            const resp = await axios(config);
            return resp.data;
        } catch (error) {
            if (error.response?.status === 401) {
                // token 过期，清除并重新登录
                logger.warn(`${LOG_PREFIX} Got 401, refreshing token and retrying...`);
                this._token = null;
                const newToken = await this._ensureToken();
                config.headers.Authorization = `Bearer ${newToken}`;
                const retryResp = await axios(config);
                return retryResp.data;
            }
            throw error; // 非 401 错误直接抛出
        }
    }

    /**
     * 查询订单详情
     * GET {baseUrl}/shop/api/orders/{orderId}
     * @param {number} orderId
     * @returns {Promise<Object>} 订单对象（含 deliveries）
     */
    async getOrderDetail(orderId) {
        return this._requestWithAuth('GET', `/shop/api/orders/${orderId}`);
    }

    /**
     * 检测封号
     * POST {baseUrl}/shop/api/orders/{orderId}/check-ban
     * @param {number} orderId
     * @param {number} deliveryId
     * @returns {Promise<Object>} { success, total, banned_count, results: [...] }
     */
    async checkBan(orderId, deliveryId) {
        return this._requestWithAuth('POST', `/shop/api/orders/${orderId}/check-ban`, {
            delivery_id: deliveryId
        });
    }

    /**
     * 自助换号
     * POST {baseUrl}/shop/api/orders/{orderId}/replace-banned
     * @param {number} orderId
     * @param {number} deliveryId
     * @param {number} accountId
     * @returns {Promise<Object>} { success, new_account: {...} }
     * @throws {Error} HTTP 400 时抛出（含 response.status）
     */
    async replaceBanned(orderId, deliveryId, accountId) {
        return this._requestWithAuth('POST', `/shop/api/orders/${orderId}/replace-banned`, {
            delivery_id: deliveryId,
            account_id: accountId
        });
    }
}

export default AfterSaleShopClient;
