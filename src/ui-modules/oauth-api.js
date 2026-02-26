import { promises as fsPromises } from 'fs';
import path from 'path';
import { getRequestBody } from '../utils/common.js';
import { pathsEqual } from '../utils/provider-utils.js';
import logger from '../utils/logger.js';
import {
    handleGeminiCliOAuth,
    handleGeminiAntigravityOAuth,
    batchImportGeminiTokensStream,
    handleQwenOAuth,
    handleKiroOAuth,
    handleIFlowOAuth,
    handleCodexOAuth,
    batchImportKiroRefreshTokensStream,
    importAwsCredentials
} from '../auth/oauth-handlers.js';

/**
 * 生成 OAuth 授权 URL
 */
export async function handleGenerateAuthUrl(req, res, currentConfig, providerType) {
    try {
        let authUrl = '';
        let authInfo = {};
        
        // 解析 options
        let options = {};
        try {
            options = await getRequestBody(req);
        } catch (e) {
            // 如果没有请求体，使用默认空对象
        }

        // 根据提供商类型生成授权链接并启动回调服务器
        if (providerType === 'gemini-cli-oauth') {
            const result = await handleGeminiCliOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'gemini-antigravity') {
            const result = await handleGeminiAntigravityOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'openai-qwen-oauth') {
            const result = await handleQwenOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'claude-kiro-oauth') {
            // Kiro OAuth 支持多种认证方式
            // options.method 可以是: 'google' | 'github' | 'builder-id'
            const result = await handleKiroOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'openai-iflow') {
            // iFlow OAuth 授权
            const result = await handleIFlowOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else if (providerType === 'openai-codex-oauth') {
            // Codex OAuth（OAuth2 + PKCE）
            const result = await handleCodexOAuth(currentConfig, options);
            authUrl = result.authUrl;
            authInfo = result.authInfo;
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `Unsupported provider type: ${providerType}`
                }
            }));
            return true;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            authUrl: authUrl,
            authInfo: authInfo
        }));
        return true;
        
    } catch (error) {
        logger.error(`[UI API] Failed to generate auth URL for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to generate auth URL: ${error.message}`
            }
        }));
        return true;
    }
}

/**
 * 处理手动 OAuth 回调
 */
export async function handleManualOAuthCallback(req, res) {
    try {
        const body = await getRequestBody(req);
        const { provider, callbackUrl, authMethod } = body;

        if (!provider || !callbackUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'provider and callbackUrl are required'
            }));
            return true;
        }

        logger.info(`[OAuth Manual Callback] Processing manual callback for ${provider}`);
        logger.info(`[OAuth Manual Callback] Callback URL: ${callbackUrl}`);

        // 解析回调URL
        const url = new URL(callbackUrl);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const token = url.searchParams.get('token');

        if (!code && !token) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Callback URL must contain code or token parameter'
            }));
            return true;
        }

        // 特殊处理 Codex OAuth 回调
        if (provider === 'openai-codex-oauth' && code && state) {
            const { handleCodexOAuthCallback } = await import('../auth/oauth-handlers.js');
            const result = await handleCodexOAuthCallback(code, state);

            res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return true;
        }

        // 通过fetch请求本地OAuth回调服务器处理
        // 使用localhost而不是原始hostname，确保请求到达本地服务器
        const localUrl = new URL(callbackUrl);
        localUrl.hostname = 'localhost';
        localUrl.protocol = 'http:';

        try {
            const response = await fetch(localUrl.href);

            if (response.ok) {
                logger.info(`[OAuth Manual Callback] Successfully processed callback for ${provider}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'OAuth callback processed successfully'
                }));
            } else {
                const errorText = await response.text();
                logger.error(`[OAuth Manual Callback] Callback processing failed:`, errorText);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: `Callback processing failed: ${response.status}`
                }));
            }
        } catch (fetchError) {
            logger.error(`[OAuth Manual Callback] Failed to process callback:`, fetchError);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: `Failed to process callback: ${fetchError.message}`
            }));
        }

        return true;
    } catch (error) {
        logger.error('[OAuth Manual Callback] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: error.message
        }));
        return true;
    }
}

/**
 * 批量导入 Kiro refreshToken（带实时进度 SSE）
 */
export async function handleBatchImportKiroTokens(req, res) {
    try {
        const body = await getRequestBody(req);
        const { refreshTokens, region } = body;
        
        if (!refreshTokens || !Array.isArray(refreshTokens) || refreshTokens.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'refreshTokens array is required and must not be empty'
            }));
            return true;
        }
        
        logger.info(`[Kiro Batch Import] Starting batch import of ${refreshTokens.length} tokens with SSE...`);
        
        // 设置 SSE 响应头
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        
        // 发送 SSE 事件的辅助函数（带错误处理）
        const sendSSE = (event, data) => {
            if (!res.writableEnded && !res.destroyed) {
                try {
                    res.write(`event: ${event}\n`);
                    res.write(`data: ${JSON.stringify(data)}\n\n`);
                } catch (err) {
                    logger.error('[Kiro Batch Import] Failed to write SSE:', err.message);
                    return false;
                }
            }
            return true;
        };
        
        // 发送开始事件
        sendSSE('start', { total: refreshTokens.length });
        
        // 执行流式批量导入
        const result = await batchImportKiroRefreshTokensStream(
            refreshTokens, 
            region || 'us-east-1',
            (progress) => {
                // 每处理完一个 token 发送进度更新
                sendSSE('progress', progress);
            }
        );
        
        logger.info(`[Kiro Batch Import] Completed: ${result.success} success, ${result.failed} failed`);
        
        // 发送完成事件
        sendSSE('complete', {
            success: true,
            total: result.total,
            successCount: result.success,
            failedCount: result.failed,
            details: result.details
        });
        
        res.end();
        return true;
        
    } catch (error) {
        logger.error('[Kiro Batch Import] Error:', error);
        // 如果已经开始发送 SSE，则发送错误事件
        if (res.headersSent && !res.writableEnded && !res.destroyed) {
            try {
                res.write(`event: error\n`);
                res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
                res.end();
            } catch (writeErr) {
                logger.error('[Kiro Batch Import] Failed to write error:', writeErr.message);
            }
        } else if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
        }
        return true;
    }
}

/**
 * 批量导入 Gemini Token（带实时进度 SSE）
 */
export async function handleBatchImportGeminiTokens(req, res) {
    try {
        const body = await getRequestBody(req);
        const { providerType, tokens, skipDuplicateCheck } = body;
        
        if (!providerType || !tokens || !Array.isArray(tokens) || tokens.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'providerType and tokens array are required and must not be empty'
            }));
            return true;
        }
        
        logger.info(`[Gemini Batch Import] Starting batch import for ${providerType} with ${tokens.length} tokens...`);
        
        // 设置 SSE 响应头
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        
        // 发送 SSE 事件的辅助函数
        const sendSSE = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        
        // 发送开始事件
        sendSSE('start', { total: tokens.length });
        
        // 执行流式批量导入
        const result = await batchImportGeminiTokensStream(
            providerType,
            tokens,
            (progress) => {
                sendSSE('progress', progress);
            },
            skipDuplicateCheck !== false // 默认为 true
        );
        
        logger.info(`[Gemini Batch Import] Completed: ${result.success} success, ${result.failed} failed`);
        
        // 发送完成事件
        sendSSE('complete', {
            success: true,
            total: result.total,
            successCount: result.success,
            failedCount: result.failed,
            details: result.details
        });
        
        res.end();
        return true;
        
    } catch (error) {
        logger.error('[Gemini Batch Import] Error:', error);
        if (res.headersSent) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
        }
        return true;
    }
}

/**
 * 导入 AWS SSO 凭据用于 Kiro（支持单个或批量导入）
 */
export async function handleImportAwsCredentials(req, res) {
    try {
        const body = await getRequestBody(req);
        const { credentials } = body;
        
        if (!credentials) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'credentials is required'
            }));
            return true;
        }
        
        // 检查是否为批量导入（数组）
        if (Array.isArray(credentials)) {
            // 批量导入模式 - 使用 SSE 流式响应
            if (credentials.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'credentials array must not be empty'
                }));
                return true;
            }
            
            // 验证每个凭据对象的必需字段
            const validationErrors = [];
            for (let i = 0; i < credentials.length; i++) {
                const cred = credentials[i];
                const missingFields = [];
                if (!cred.clientId) missingFields.push('clientId');
                if (!cred.clientSecret) missingFields.push('clientSecret');
                if (!cred.accessToken) missingFields.push('accessToken');
                if (!cred.refreshToken) missingFields.push('refreshToken');
                
                if (missingFields.length > 0) {
                    validationErrors.push({
                        index: i + 1,
                        missingFields: missingFields
                    });
                }
            }
            
            // 如果有验证错误，返回详细信息
            if (validationErrors.length > 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: `Validation failed for ${validationErrors.length} credential(s)`,
                    validationErrors: validationErrors
                }));
                return true;
            }
            
            logger.info(`[Kiro AWS Batch Import] Starting batch import of ${credentials.length} credentials with SSE...`);
            
            // 设置 SSE 响应头
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            
            // 发送 SSE 事件的辅助函数
            const sendSSE = (event, data) => {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };
            
            // 发送开始事件
            sendSSE('start', { total: credentials.length });
            
            // 批量导入
            let successCount = 0;
            let failedCount = 0;
            const details = [];
            
            for (let i = 0; i < credentials.length; i++) {
                const cred = credentials[i];
                const progressData = {
                    index: i + 1,
                    total: credentials.length,
                    current: null
                };
                
                try {
                    const result = await importAwsCredentials(cred);
                    
                    if (result.success) {
                        progressData.current = {
                            index: i + 1,
                            success: true,
                            path: result.path
                        };
                        successCount++;
                    } else {
                        progressData.current = {
                            index: i + 1,
                            success: false,
                            error: result.error,
                            existingPath: result.existingPath
                        };
                        failedCount++;
                    }
                } catch (error) {
                    progressData.current = {
                        index: i + 1,
                        success: false,
                        error: error.message
                    };
                    failedCount++;
                }
                
                details.push(progressData.current);
                
                // 发送进度更新
                sendSSE('progress', {
                    ...progressData,
                    successCount,
                    failedCount
                });
            }
            
            logger.info(`[Kiro AWS Batch Import] Completed: ${successCount} success, ${failedCount} failed`);
            
            // 发送完成事件
            sendSSE('complete', {
                success: true,
                total: credentials.length,
                successCount,
                failedCount,
                details
            });
            
            res.end();
            return true;
            
        } else if (typeof credentials === 'object') {
            // 单个导入模式
            // 验证必需字段 - 需要四个字段都存在
            const missingFields = [];
            if (!credentials.clientId) missingFields.push('clientId');
            if (!credentials.clientSecret) missingFields.push('clientSecret');
            if (!credentials.accessToken) missingFields.push('accessToken');
            if (!credentials.refreshToken) missingFields.push('refreshToken');
            
            if (missingFields.length > 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: `Missing required fields: ${missingFields.join(', ')}`
                }));
                return true;
            }
            
            logger.info('[Kiro AWS Import] Starting AWS credentials import...');
            
            const result = await importAwsCredentials(credentials);
            
            if (result.success) {
                logger.info(`[Kiro AWS Import] Successfully imported credentials to: ${result.path}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    path: result.path,
                    message: 'AWS credentials imported successfully'
                }));
            } else {
                // 重复凭据返回 409 Conflict，其他错误返回 500
                const statusCode = result.error === 'duplicate' ? 409 : 500;
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: result.error,
                    existingPath: result.existingPath || null
                }));
            }
            return true;
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'credentials must be an object or array'
            }));
            return true;
        }
        
    } catch (error) {
        logger.error('[Kiro AWS Import] Error:', error);
        // 如果已经开始发送 SSE，则发送错误事件
        if (res.headersSent) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
        }
        return true;
    }
}

/**
 * 自动售后 AWS 凭据导入
 * POST /api/kiro/import-after-sale-credentials
 */
export async function handleImportAfterSaleCredentials(req, res) {
    const sendError = (status, message) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: message }));
        return true;
    };

    try {
        const body = await getRequestBody(req);
        const { clientId, clientSecret, refreshToken, accountInfo, orderId, region, startUrl } = body;

        // 1. 参数校验
        const requiredFields = { clientId, clientSecret, refreshToken, accountInfo, orderId };
        for (const [name, value] of Object.entries(requiredFields)) {
            if (!value || (typeof value === 'string' && !value.trim())) {
                return sendError(400, `缺少必填字段: ${name}`);
            }
        }
        if (!Number.isInteger(orderId) || orderId <= 0) {
            return sendError(400, 'orderId 必须为正整数');
        }

        // 2. 初始化商城客户端，查询订单获取 deliveryId + accountId
        const { CONFIG } = await import('../core/config-manager.js');
        const { AfterSaleShopClient } = await import('../auth/after-sale-shop-client.js');

        const shopBaseUrl = CONFIG.AUTO_AFTER_SALE_SHOP_BASE_URL || 'https://kiroshop.xyz';
        const shopEmail = CONFIG.AUTO_AFTER_SALE_SHOP_EMAIL;
        const shopPassword = CONFIG.AUTO_AFTER_SALE_SHOP_PASSWORD;

        if (!shopEmail || !shopPassword) {
            return sendError(400, '请先在配置中填写商城邮箱和密码');
        }

        const shopClient = new AfterSaleShopClient(shopBaseUrl, shopEmail, shopPassword);

        let orderData;
        try {
            orderData = await shopClient.getOrderDetail(orderId);
        } catch (err) {
            return sendError(500, `商城 API 调用失败: ${err.message}`);
        }

        if (!orderData.deliveries || orderData.deliveries.length === 0) {
            return sendError(400, '该订单无交付记录');
        }

        const deliveryId = orderData.deliveries[0].id;
        const accountDataArr = orderData.deliveries[0].account_data || [];

        // 新匹配逻辑：解析 accountInfo（"名称-密码"）匹配 subscription_info
        let matchedAccount = null;
        const dashIdx = accountInfo.indexOf('-');
        if (dashIdx > 0) {
            const inputName = accountInfo.substring(0, dashIdx);
            const inputPwd = accountInfo.substring(dashIdx + 1);
            matchedAccount = accountDataArr.find(acc => {
                const parsed = parseSubscriptionInfo(acc.subscription_info);
                return parsed && parsed.name === inputName && parsed.password === inputPwd;
            });
        }
        // fallback：subscription_info 匹配失败，尝试 account_info 精确匹配
        if (!matchedAccount) {
            matchedAccount = accountDataArr.find(acc => acc.account_info === accountInfo);
        }
        if (!matchedAccount) {
            return sendError(400, '未在订单中找到匹配的账号（accountInfo 不匹配）');
        }
        const accountId = matchedAccount.id;

        // 重复导入防御：检查 provider_pools 中是否已存在相同 orderId + accountId 且未过期
        try {
            const poolsCheckPath = CONFIG.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
            const poolsCheckRaw = await fsPromises.readFile(poolsCheckPath, 'utf8');
            const poolsCheckData = JSON.parse(poolsCheckRaw);
            const kiroPoolCheck = poolsCheckData['claude-kiro-oauth'] || [];
            const duplicate = kiroPoolCheck.find(p => {
                const m = p.afterSaleMeta;
                return m && m.orderId === orderId && m.accountId === accountId && !m.afterSaleExpired;
            });
            if (duplicate) {
                return sendError(400, `该账号已导入（uuid: ${duplicate.uuid}），请勿重复导入`);
            }
        } catch (e) {
            logger.warn('[AfterSale] Duplicate check failed, proceeding:', e.message);
        }

        // 3. 调用 importAwsCredentials 创建 provider 节点（region 重试，和封号换号逻辑一致）
        const configRegions = CONFIG.AUTO_AFTER_SALE_REGIONS;
        const regions = (Array.isArray(configRegions) && configRegions.length > 0)
            ? configRegions
            : ["us-east-1", "eu-north-1"];

        let importResult = null;
        let successRegion = null;

        for (const tryRegion of regions) {
            logger.info(`[AfterSale] Trying import with region ${tryRegion} (${regions.indexOf(tryRegion) + 1}/${regions.length})`);
            importResult = await importAwsCredentials({
                clientId: clientId.trim(),
                clientSecret: clientSecret.trim(),
                accessToken: refreshToken.trim(),
                refreshToken: refreshToken.trim(),
                authMethod: 'builder-id',
                startUrl: startUrl || '',
                region: tryRegion,
                idcRegion: tryRegion,
                failOnRefreshError: CONFIG.AUTO_AFTER_SALE_FAIL_ON_REFRESH_ERROR !== false
            });

            if (importResult.success) {
                successRegion = tryRegion;
                break;
            }
            // 重复凭据直接跳出，不用尝试其他 region
            if (importResult.error === 'duplicate') {
                return sendError(409, '该凭据已导入（refreshToken 重复），请勿重复导入');
            }
            logger.warn(`[AfterSale] Import failed with region ${tryRegion}: ${importResult.error}`);
        }

        if (!importResult || !importResult.success) {
            return sendError(500, `AWS 凭据导入失败（已尝试 ${regions.join(', ')}）: ${importResult?.error || 'unknown'}`);
        }

        // 4. 追加 importSource + afterSaleMeta 到新节点（两步操作）
        const poolsFilePath = CONFIG.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        const poolsRaw = await fsPromises.readFile(poolsFilePath, 'utf8');
        const poolsData = JSON.parse(poolsRaw);
        const kiroPool = poolsData['claude-kiro-oauth'] || [];

        const newNode = kiroPool.find(p =>
            p.KIRO_OAUTH_CREDS_FILE_PATH === importResult.path ||
            p.KIRO_OAUTH_CREDS_FILE_PATH === './' + importResult.path ||
            pathsEqual(p.KIRO_OAUTH_CREDS_FILE_PATH, importResult.path)
        );

        if (!newNode) {
            // 导入已成功（凭据文件已创建并关联到 pool），只是无法追加 afterSaleMeta
            // 返回 200 + warning 而非 500，避免前端误报失败
            logger.warn(`[AfterSale] Import succeeded but could not locate new node for path: ${importResult.path}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                warning: '导入成功但未能追加售后元数据，请手动检查',
                provider: { uuid: null, importSource: 'auto-after-sale' }
            }));
            return true;
        }

        newNode.importSource = 'auto-after-sale';
        newNode.tags = ['导入'];
        newNode.afterSaleMeta = {
            orderId,
            deliveryId,
            accountId,
            accountInfo,
            subscriptionInfoRaw: matchedAccount.subscription_info || '',
            startUrl: startUrl || '',
            afterSaleExpired: false
        };

        // 5. 保存 provider_pools.json
        await fsPromises.writeFile(poolsFilePath, JSON.stringify(poolsData, null, 2), 'utf8');
        logger.info(`[AfterSale] Import success: uuid=${newNode.uuid}, orderId=${orderId}, accountId=${accountId}`);

        // 同步更新 ProviderPoolManager 内存状态
        // 不重新 initializeProviderStatus()（会触发刷新等副作用导致竞态覆盖），
        // 而是直接在内存中找到对应节点，原地追加 afterSaleMeta 等字段
        try {
            const { getProviderPoolManager } = await import('../services/service-manager.js');
            const poolManager = getProviderPoolManager();
            if (poolManager) {
                // 1. 更新 providerPools 中的原始配置
                const memPool = poolManager.providerPools['claude-kiro-oauth'] || [];
                const memNode = memPool.find(p =>
                    p.uuid === newNode.uuid ||
                    p.KIRO_OAUTH_CREDS_FILE_PATH === importResult.path ||
                    p.KIRO_OAUTH_CREDS_FILE_PATH === './' + importResult.path
                );
                if (memNode) {
                    memNode.importSource = 'auto-after-sale';
                    memNode.tags = ['导入'];
                    memNode.afterSaleMeta = newNode.afterSaleMeta;
                }

                // 2. 更新 providerStatus 中的 config 引用
                const statusPool = poolManager.providerStatus['claude-kiro-oauth'] || [];
                const statusNode = statusPool.find(ps =>
                    ps.config.uuid === newNode.uuid ||
                    ps.config.KIRO_OAUTH_CREDS_FILE_PATH === importResult.path ||
                    ps.config.KIRO_OAUTH_CREDS_FILE_PATH === './' + importResult.path
                );
                if (statusNode) {
                    statusNode.config.importSource = 'auto-after-sale';
                    statusNode.config.tags = ['导入'];
                    statusNode.config.afterSaleMeta = newNode.afterSaleMeta;
                }

                // 3. 立即写文件，清掉 pending debounce（防止旧数据覆盖）
                await poolManager._flushImmediately('claude-kiro-oauth');
                logger.info(`[AfterSale] Memory state synced for uuid=${newNode.uuid}`);
            }
        } catch (e) {
            logger.warn('[AfterSale] Failed to sync memory state:', e.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: '自动售后账号导入成功',
            provider: {
                uuid: newNode.uuid,
                importSource: 'auto-after-sale',
                afterSaleMeta: newNode.afterSaleMeta
            }
        }));
        return true;

    } catch (error) {
        logger.error('[AfterSale] Import error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}

/**
 * 解析 subscription_info 为 "名称-密码" 格式
 * 格式：积分----链接----名称----密码----MFA密钥（---- 分隔 5 段）
 * @returns {{ name: string, password: string, raw: string } | null}
 */
function parseSubscriptionInfo(subscriptionInfo) {
    if (!subscriptionInfo || typeof subscriptionInfo !== 'string') return null;
    const parts = subscriptionInfo.split('----');
    if (parts.length < 4) return null;
    const name = parts[2]?.trim();
    const password = parts[3]?.trim();
    if (!name || !password) return null;
    return { name, password, raw: subscriptionInfo };
}

/**
 * 获取订单账号列表
 * GET /api/kiro/order-accounts?orderId={orderId}
 */
export async function handleGetOrderAccounts(req, res) {
    const sendError = (status, message) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: message }));
        return true;
    };

    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const orderId = parseInt(url.searchParams.get('orderId'));

        if (!orderId || !Number.isInteger(orderId) || orderId <= 0) {
            return sendError(400, 'orderId 必须为正整数');
        }

        const { CONFIG } = await import('../core/config-manager.js');
        const { AfterSaleShopClient } = await import('../auth/after-sale-shop-client.js');

        const shopBaseUrl = CONFIG.AUTO_AFTER_SALE_SHOP_BASE_URL || 'https://kiroshop.xyz';
        const shopEmail = CONFIG.AUTO_AFTER_SALE_SHOP_EMAIL;
        const shopPassword = CONFIG.AUTO_AFTER_SALE_SHOP_PASSWORD;

        if (!shopEmail || !shopPassword) {
            return sendError(400, '请先在配置中填写商城邮箱和密码');
        }

        const shopClient = new AfterSaleShopClient(shopBaseUrl, shopEmail, shopPassword);

        let orderData;
        try {
            orderData = await shopClient.getOrderDetail(orderId);
        } catch (err) {
            return sendError(500, `商城 API 调用失败: ${err.message}`);
        }

        if (!orderData.deliveries || orderData.deliveries.length === 0) {
            return sendError(400, '该订单无交付记录');
        }

        const delivery = orderData.deliveries[0];
        const deliveryId = delivery.id;
        const accountDataArr = delivery.account_data || [];

        // 读取 provider_pools 检查已导入状态
        const poolsFilePath = CONFIG.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let importedSet = new Set();
        try {
            const poolsRaw = await fsPromises.readFile(poolsFilePath, 'utf8');
            const poolsData = JSON.parse(poolsRaw);
            const kiroPool = poolsData['claude-kiro-oauth'] || [];
            for (const p of kiroPool) {
                const meta = p.afterSaleMeta;
                if (meta && meta.orderId === orderId && meta.accountId && !meta.afterSaleExpired) {
                    importedSet.add(meta.accountId);
                }
            }
        } catch (e) {
            logger.warn('[OrderAccounts] Failed to read provider_pools for import check:', e.message);
        }

        const accounts = accountDataArr.map(acc => {
            const parsed = parseSubscriptionInfo(acc.subscription_info);
            let displayName, accountValue;
            if (parsed) {
                displayName = `${parsed.name}-${parsed.password}`;
                accountValue = displayName;
            } else {
                displayName = acc.account_info ? `${acc.account_info}（格式异常）` : `账号#${acc.id}（格式异常）`;
                accountValue = acc.account_info || '';
            }

            // 解析凭据：优先 account_json，fallback account_info
            let clientId = '', clientSecret = '', refreshToken = '';
            if (acc.account_json) {
                try {
                    let jsonArr = typeof acc.account_json === 'string' ? JSON.parse(acc.account_json) : acc.account_json;
                    const obj = Array.isArray(jsonArr) ? jsonArr[0] : jsonArr;
                    if (obj) {
                        clientId = obj.clientId || '';
                        clientSecret = obj.clientSecret || '';
                        refreshToken = obj.refreshToken || '';
                    }
                } catch (e) {
                    logger.warn('[OrderAccounts] account_json parse failed:', e.message);
                }
            }
            if (!clientId && acc.account_info) {
                const infoParts = acc.account_info.split('----');
                if (infoParts.length >= 6) {
                    refreshToken = refreshToken || (infoParts[3]?.trim() || '');
                    clientId = infoParts[4]?.trim() || '';
                    clientSecret = infoParts[5]?.trim() || '';
                }
            }
            // 也可从顶层字段 fallback
            clientId = clientId || acc.client_id || '';
            clientSecret = clientSecret || acc.client_secret || '';
            refreshToken = refreshToken || acc.refresh_token || '';

            // startUrl 从 subscription_info 第2段
            let startUrl = acc.subscription_url || '';
            if (!startUrl && acc.subscription_info) {
                const subParts = acc.subscription_info.split('----');
                if (subParts.length >= 2) startUrl = subParts[1]?.trim() || '';
            }

            // region 从 account_json 解析
            let region = '';
            if (acc.account_json) {
                try {
                    let jsonArr = typeof acc.account_json === 'string' ? JSON.parse(acc.account_json) : acc.account_json;
                    const obj = Array.isArray(jsonArr) ? jsonArr[0] : jsonArr;
                    if (obj) {
                        region = obj.region || obj.idcRegion || '';
                    }
                } catch (e) { /* ignore */ }
            }

            return {
                accountId: acc.id,
                deliveryId,
                displayName,
                accountValue,
                imported: importedSet.has(acc.id),
                clientId,
                clientSecret,
                refreshToken,
                startUrl,
                region
            };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, accounts }));
        return true;

    } catch (error) {
        logger.error('[OrderAccounts] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return true;
    }
}
