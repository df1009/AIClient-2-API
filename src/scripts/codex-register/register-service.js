/**
 * Codex 账号自动注册服务
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../../utils/logger.js';
import { getProviderPoolManager } from '../../services/service-manager.js';

function loadAutoProxyPoolFromMihomo(config) {
    const source = config.auto_proxy_pool_source || 'mihomo-proxy-pool';
    if (source !== 'mihomo-proxy-pool') {
        return { proxyPool: [], proxyPoolNames: [] };
    }

    const host = config.auto_proxy_pool_host || '127.0.0.1';
    const startPort = Number(config.auto_proxy_pool_start_port || 18001);
    const endPort = Number(config.auto_proxy_pool_end_port || 18032);
    const configPath = path.join(process.env.HOME || '', '.config', 'mihomo-proxy-pool', 'config.yaml');

    if (!fs.existsSync(configPath)) {
        logger.warn(`[CodexRegister] Mihomo proxy pool config not found: ${configPath}`);
        return { proxyPool: [], proxyPoolNames: [] };
    }

    const raw = fs.readFileSync(configPath, 'utf8');
    const portToName = new Map();
    let currentProxyGroup = null;
    let currentListenerPort = null;
    let currentListenerProxy = null;

    for (const line of raw.split('\n')) {
        const proxyGroupMatch = line.match(/^\s*- name:\s*['\"]?(proxy-(\d+))['\"]?\s*$/);
        if (proxyGroupMatch) {
            currentProxyGroup = proxyGroupMatch[1];
            continue;
        }

        if (currentProxyGroup) {
            const proxyNameMatch = line.match(/^\s*-\s*['\"](.+?)['\"]\s*$/);
            if (proxyNameMatch) {
                const port = Number(currentProxyGroup.replace('proxy-', ''));
                if (!Number.isNaN(port)) {
                    portToName.set(port, proxyNameMatch[1]);
                }
                currentProxyGroup = null;
                continue;
            }
        }

        const listenerNameMatch = line.match(/^\s*- name:\s*(proxy-(\d+))\s*$/);
        if (listenerNameMatch) {
            currentListenerPort = null;
            currentListenerProxy = null;
            continue;
        }

        const portMatch = line.match(/^\s*port:\s*(\d+)\s*$/);
        if (portMatch) {
            currentListenerPort = Number(portMatch[1]);
            continue;
        }

        const proxyMatch = line.match(/^\s*proxy:\s*['\"]?(proxy-(\d+))['\"]?\s*$/);
        if (proxyMatch) {
            currentListenerProxy = proxyMatch[1];
            const groupPort = Number(currentListenerProxy.replace('proxy-', ''));
            if (currentListenerPort && groupPort === currentListenerPort && currentListenerPort >= startPort && currentListenerPort <= endPort) {
                const nodeName = portToName.get(currentListenerPort);
                if (nodeName) {
                    portToName.set(currentListenerPort, nodeName);
                }
            }
        }
    }

    const proxyPool = [];
    const proxyPoolNames = [];
    for (let port = startPort; port <= endPort; port += 1) {
        const nodeName = portToName.get(port);
        if (!nodeName) continue;
        proxyPool.push(`http://${host}:${port}`);
        proxyPoolNames.push(nodeName);
    }

    logger.info(`[CodexRegister] Auto proxy pool loaded: ${proxyPool.length} node(s) from Mihomo`);
    return { proxyPool, proxyPoolNames };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const SCRIPT_PATH = path.join(SCRIPT_DIR, 'chatgpt_register.py');
const REGISTER_CONFIG_PATH = path.join(SCRIPT_DIR, 'register-config.json');

let registerTaskRunning = false;
let registerTaskLog = [];
let registerTaskResult = null;
let maintenanceTimer = null;
let healthCheckTimer = null;
let healthCheckRunning = false;
let healthCheckLastResult = null;

function getTargetPoolSize() {
    const config = getRegisterConfig();
    return config.target_pool_size || 50;
}

function getMaintenanceInterval() {
    const config = getRegisterConfig();
    return config.maintenance_interval_ms || 10 * 60 * 1000;
}

function getCheckInterval() {
    const config = getRegisterConfig();
    return config.check_interval_ms || 60 * 1000;
}

function getCheckWorkers() {
    const config = getRegisterConfig();
    return config.check_workers || 5;
}

function getRegisterCount() {
    const config = getRegisterConfig();
    return config.register_count || 3;
}

function getRegisterWorkers() {
    const config = getRegisterConfig();
    return config.register_workers || 3;
}

export function getRegisterConfig() {
    try {
        if (fs.existsSync(REGISTER_CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(REGISTER_CONFIG_PATH, 'utf8'));
        }
    } catch (e) {
        logger.warn('[CodexRegister] 读取注册配置失败:', e.message);
    }
    return {};
}

export function saveRegisterConfig(config) {
    fs.writeFileSync(REGISTER_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export function getRegisterTaskStatus() {
    return {
        running: registerTaskRunning,
        log: registerTaskLog.slice(-200),
        result: registerTaskResult,
        maintenanceRunning: maintenanceTimer !== null,
    };
}

export async function runRegisterScript(count, workers = 3) {
    if (registerTaskRunning) {
        throw new Error('注册任务正在运行中，请等待完成');
    }

    registerTaskRunning = true;
    registerTaskLog = [];
    registerTaskResult = null;

    const config = getRegisterConfig();
    const tokenDir = path.join(process.cwd(), 'configs', 'codex');
    fs.mkdirSync(tokenDir, { recursive: true });

    let proxyPool = Array.isArray(config.proxy_pool)
        ? config.proxy_pool.filter(item => typeof item === 'string' && item.trim())
        : [];
    let proxyPoolNames = Array.isArray(config.proxy_pool_names)
        ? config.proxy_pool_names.filter(item => typeof item === 'string' && item.trim())
        : [];

    if ((config.proxy_mode || '').trim().toLowerCase() === 'auto_pool') {
        const autoPool = loadAutoProxyPoolFromMihomo(config);
        if (autoPool.proxyPool.length > 0) {
            proxyPool = autoPool.proxyPool;
            proxyPoolNames = autoPool.proxyPoolNames;
        }
    }

    const singleProxy = (config.proxy_mode || '').trim().toLowerCase() === 'auto_pool' ? '' : (config.proxy || '');

    const env = {
        ...process.env,
        TOTAL_ACCOUNTS: String(count),
        MAIL_PROVIDER: config.mail_provider || 'tempmail',
        TEMPMAIL_ADMIN_AUTH: config.tempmail_admin_auth || '',
        TEMPMAIL_API_BASE: config.tempmail_api_base || '',
        TEMPMAIL_DOMAIN: config.tempmail_domain || '',
        DUCKMAIL_BEARER: config.duckmail_bearer || '',
        HTTP_PROXY: singleProxy,
        HTTPS_PROXY: singleProxy,
        ALL_PROXY: singleProxy,
        PROXY: singleProxy,
        PROXY_MODE: config.proxy_mode || '',
        PROXY_STRATEGY: config.proxy_strategy || '',
        PROXY_POOL: JSON.stringify(proxyPool),
        PROXY_POOL_NAMES: JSON.stringify(proxyPoolNames),
        ENABLE_OAUTH: 'true',
        OAUTH_REQUIRED: 'false',
        TOKEN_JSON_DIR: tokenDir,
        AK_FILE: path.join(SCRIPT_DIR, 'ak.txt'),
        RK_FILE: path.join(SCRIPT_DIR, 'rk.txt'),
        OUTPUT_FILE: path.join(SCRIPT_DIR, 'registered_accounts.txt'),
    };

    return new Promise((resolve, reject) => {
        const venv311Python = path.join(SCRIPT_DIR, 'venv311', 'bin', 'python3');
        const venvPython = path.join(SCRIPT_DIR, 'venv', 'bin', 'python3');
        const venv13Python = path.join(SCRIPT_DIR, 'venv13', 'bin', 'python3');
        let actualPython = 'python3';
        if (fs.existsSync(venv311Python)) actualPython = venv311Python;
        else if (fs.existsSync(venv13Python)) actualPython = venv13Python;
        else if (fs.existsSync(venvPython)) actualPython = venvPython;

        const args = [SCRIPT_PATH, '--batch', '--count', String(count), '--workers', String(workers)];

        logger.info(`[CodexRegister] 启动注册: ${actualPython} ${args.join(' ')}`);
        registerTaskLog.push(`[${new Date().toLocaleTimeString()}] 启动注册任务，数量: ${count}，并发: ${workers}`);

        const proc = spawn(actualPython, args, { cwd: SCRIPT_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });

        let accountCreatedCount = 0;
        let oauthSuccessCount = 0;
        let oauthFailCount = 0;
        let failCount = 0;

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            lines.forEach(line => {
                registerTaskLog.push(`[${new Date().toLocaleTimeString()}] ${line}`);
                logger.info(`[CodexRegister] ${line}`);
                if (line.includes('账号创建成功')) accountCreatedCount++;
                if (line.includes('OAuth 成功，可导入供应商池')) oauthSuccessCount++;
                if (line.includes('OAuth 失败，仅账号创建成功，不可导入供应商池')) oauthFailCount++;
                if (line.includes('[FAIL]') || line.includes('注册失败')) failCount++;
            });
        });

        proc.stderr.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            lines.forEach(line => {
                registerTaskLog.push(`[${new Date().toLocaleTimeString()}] [STDERR] ${line}`);
            });
        });

        proc.on('close', async (code) => {
            registerTaskRunning = false;
            registerTaskResult = {
                success: code === 0,
                accountCreated: accountCreatedCount,
                oauthSuccess: oauthSuccessCount,
                oauthFail: oauthFailCount,
                failed: failCount,
                exitCode: code,
            };
            registerTaskLog.push(`[${new Date().toLocaleTimeString()}] 任务完成，账号创建成功: ${accountCreatedCount}，OAuth成功: ${oauthSuccessCount}，OAuth失败: ${oauthFailCount}，注册失败: ${failCount}`);
            logger.info(`[CodexRegister] 任务完成，账号创建成功: ${accountCreatedCount}，OAuth成功: ${oauthSuccessCount}，OAuth失败: ${oauthFailCount}，注册失败: ${failCount}`);

            if (oauthSuccessCount > 0) {
                try { await importNewTokensToPool(); } catch (e) { logger.error('[CodexRegister] 自动导入失败:', e.message); }
            } else if (accountCreatedCount > 0) {
                logger.warn('[CodexRegister] 本次仅账号创建成功，但没有 OAuth 成功账号，跳过导入供应商池');
            }
            resolve(registerTaskResult);
        });

        proc.on('error', (err) => {
            registerTaskRunning = false;
            registerTaskResult = { success: false, error: err.message };
            registerTaskLog.push(`[${new Date().toLocaleTimeString()}] [ERR] 启动失败: ${err.message}`);
            logger.error('[CodexRegister] 启动失败:', err.message);
            reject(err);
        });
    });
}

/**
 * 检测单个 Codex 账号是否可用
 * 通过调用 getUsageLimits 接口验证，401/网络错误均视为不可用
 */
async function checkSingleAccount(providerEntry) {
    try {
        const { getServiceAdapter } = await import('../../providers/adapter.js');
        const config = { ...providerEntry.config, MODEL_PROVIDER: 'openai-codex-oauth' };
        const adapter = getServiceAdapter(config);
        await adapter.getUsageLimits();
        return { uuid: providerEntry.config.uuid, healthy: true };
    } catch (e) {
        const status = e.response?.status;
        const healthy = !(status === 401 || status === 403 || e.credentialMarkedUnhealthy);
        // 网络超时等非鉴权错误，保守处理视为健康（避免误删）
        if (!status && !e.credentialMarkedUnhealthy) {
            logger.warn(`[CodexCheck] UUID ${providerEntry.config.uuid} 检测超时/网络错误，保守视为健康: ${e.message}`);
            return { uuid: providerEntry.config.uuid, healthy: true };
        }
        return { uuid: providerEntry.config.uuid, healthy };
    }
}

/**
 * 真正从池中删除账号（providerPools + providerStatus + 文件）
 */
async function deleteAccountFromPool(uuid) {
    const poolManager = getProviderPoolManager();
    if (!poolManager) return false;
    const providerType = 'openai-codex-oauth';

    // 找到凭证文件路径
    const pool = poolManager.providerPools?.[providerType] || [];
    const entry = pool.find(p => p.uuid === uuid);
    const credPath = entry?.CODEX_OAUTH_CREDS_FILE_PATH;

    // 从 providerPools 删除
    if (poolManager.providerPools?.[providerType]) {
        poolManager.providerPools[providerType] = poolManager.providerPools[providerType].filter(p => p.uuid !== uuid);
    }
    // 从 providerStatus 删除
    if (poolManager.providerStatus?.[providerType]) {
        poolManager.providerStatus[providerType] = poolManager.providerStatus[providerType].filter(p => p.config.uuid !== uuid);
    }
    // 触发保存
    poolManager._debouncedSave(providerType);

    // 删除凭证文件
    if (credPath) {
        try {
            const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../..');
            const absPath = path.isAbsolute(credPath) ? credPath : path.resolve(PROJECT_ROOT, credPath);
            if (fs.existsSync(absPath)) {
                fs.unlinkSync(absPath);
                logger.info(`[CodexCheck] 已删除凭证文件: ${absPath}`);
            }
        } catch (e) {
            logger.warn(`[CodexCheck] 删除凭证文件失败: ${e.message}`);
        }
    }
    return true;
}

/**
 * 并发健康检测，不可用账号直接删除
 */
export async function runAccountHealthCheck() {
    if (healthCheckRunning) {
        logger.info('[CodexCheck] 健康检测已在运行，跳过');
        return healthCheckLastResult;
    }
    healthCheckRunning = true;
    const startTime = Date.now();
    logger.info('[CodexCheck] 开始账号健康检测...');

    try {
        const poolManager = getProviderPoolManager();
        if (!poolManager) {
            healthCheckRunning = false;
            return { checked: 0, removed: 0, error: 'No poolManager' };
        }

        const pool = poolManager.providerStatus?.['openai-codex-oauth'] || [];
        if (pool.length === 0) {
            logger.info('[CodexCheck] 池为空，跳过检测');
            healthCheckRunning = false;
            healthCheckLastResult = { checked: 0, removed: 0, time: Date.now() };
            return healthCheckLastResult;
        }

        const workers = getCheckWorkers();
        logger.info(`[CodexCheck] 检测 ${pool.length} 个账号，并发: ${workers}`);

        // 并发控制：分批处理
        const results = [];
        for (let i = 0; i < pool.length; i += workers) {
            const batch = pool.slice(i, i + workers);
            const batchResults = await Promise.all(batch.map(p => checkSingleAccount(p)));
            results.push(...batchResults);
        }

        // 删除不可用账号
        const toRemove = results.filter(r => !r.healthy);
        for (const item of toRemove) {
            logger.info(`[CodexCheck] 账号不可用，删除: ${item.uuid}`);
            await deleteAccountFromPool(item.uuid);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        healthCheckLastResult = {
            checked: results.length,
            healthy: results.filter(r => r.healthy).length,
            removed: toRemove.length,
            time: Date.now(),
            elapsedSec: elapsed,
        };
        logger.info(`[CodexCheck] 检测完成，共 ${results.length} 个，健康 ${healthCheckLastResult.healthy} 个，删除 ${toRemove.length} 个，耗时 ${elapsed}s`);
        return healthCheckLastResult;
    } catch (e) {
        logger.error('[CodexCheck] 健康检测出错:', e.message);
        return { checked: 0, removed: 0, error: e.message };
    } finally {
        healthCheckRunning = false;
    }
}

export function getHealthCheckStatus() {
    return {
        running: healthCheckRunning,
        timerActive: healthCheckTimer !== null,
        interval: getCheckInterval(),
        workers: getCheckWorkers(),
        lastResult: healthCheckLastResult,
    };
}

export function startHealthCheckScheduler() {
    if (healthCheckTimer) clearInterval(healthCheckTimer);
    const interval = getCheckInterval();
    logger.info(`[CodexCheck] 启动定时健康检测，间隔: ${interval / 1000}s`);
    // 启动时立即跑一次
    runAccountHealthCheck().catch(e => logger.error('[CodexCheck] 首次检测失败:', e.message));
    healthCheckTimer = setInterval(() => {
        runAccountHealthCheck().catch(e => logger.error('[CodexCheck] 定时检测失败:', e.message));
    }, interval);
}

export function stopHealthCheckScheduler() {
    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
        logger.info('[CodexCheck] 已停止定时健康检测');
    }
}

async function importNewTokensToPool() {
    const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../..');
    const tokenDir = path.join(PROJECT_ROOT, 'configs', 'codex');
    if (!fs.existsSync(tokenDir)) return;

    const poolManager = getProviderPoolManager();
    if (!poolManager) return;

    const pool = poolManager.providerStatus['openai-codex-oauth'] || [];
    // 用 email 去重，避免路径格式不一致导致重复导入
    // 注意：CODEX_OAUTH_CREDS_FILE_PATH 是相对于项目根目录的路径，需用 SCRIPT_DIR 向上推算
    const existingEmails = new Set(
        pool.map(p => {
            const filePath = p.config.CODEX_OAUTH_CREDS_FILE_PATH || '';
            try {
                // 尝试相对于项目根目录解析
                const absPath = path.isAbsolute(filePath)
                    ? filePath
                    : path.resolve(PROJECT_ROOT, filePath);
                if (fs.existsSync(absPath)) {
                    const cred = JSON.parse(fs.readFileSync(absPath, 'utf8'));
                    return cred.email || '';
                }
            } catch (e) { /* skip */ }
            return '';
        }).filter(Boolean)
    );

    const files = fs.readdirSync(tokenDir).filter(f => f.endsWith('.json'));
    const credentials = [];

    for (const file of files) {
        const absPath = path.resolve(path.join(tokenDir, file));
        try {
            const cred = JSON.parse(fs.readFileSync(absPath, 'utf8'));
            if (cred.type === 'codex' && cred.access_token && !existingEmails.has(cred.email)) {
                credentials.push(cred);
            }
        } catch (e) { /* skip */ }
    }

    if (credentials.length === 0) {
        logger.warn('[CodexRegister] 未发现可导入的 OAuth 成功账号（configs/codex 下无新增有效 token 文件）');
        return;
    }

    logger.info(`[CodexRegister] 检测到 ${credentials.length} 个 OAuth 成功账号，开始导入供应商池...`);
    const { batchImportCodexCredentialsStream } = await import('../../auth/oauth-handlers.js');
    const importResult = await batchImportCodexCredentialsStream(credentials, null, true); // skipDuplicateCheck=true，已用 email 去重

    // 导入成功后，删除同邮箱的原始文件（email.json），仅保留正式关联文件（timestamp_codex-email.json）
    try {
        for (const detail of importResult?.details || []) {
            if (!detail?.success || !detail?.email) continue;
            const rawFilePath = path.join(tokenDir, `${detail.email}.json`);
            const linkedFilePath = detail.path ? path.resolve(path.join(path.resolve(SCRIPT_DIR, '../../..'), detail.path)) : null;
            if (fs.existsSync(rawFilePath) && (!linkedFilePath || path.resolve(rawFilePath) !== path.resolve(linkedFilePath))) {
                fs.unlinkSync(rawFilePath);
                logger.info(`[CodexRegister] 已删除原始凭据文件: ${path.basename(rawFilePath)}`);
            }
        }
    } catch (e) {
        logger.warn(`[CodexRegister] 删除原始凭据文件失败: ${e.message}`);
    }

    // 导入完成后，从文件重新加载 providerPools 到 poolManager，确保内存与文件一致
    try {
        const poolManager = getProviderPoolManager();
        if (poolManager) {
            const poolsFilePath = path.join(path.resolve(SCRIPT_DIR, '../../..'), 'configs', 'provider_pools.json');
            const poolsData = JSON.parse(fs.readFileSync(poolsFilePath, 'utf8'));
            poolManager.providerPools = poolsData;
            poolManager.initializeProviderStatus();
            logger.info(`[CodexRegister] 池已从文件重新加载，当前 codex 账号数: ${(poolManager.providerStatus['openai-codex-oauth'] || []).length}`);
        }
    } catch (e) {
        logger.warn(`[CodexRegister] 重新加载池失败: ${e.message}`);
    }

    logger.info(`[CodexRegister] 导入完成`);
}

export function getCodexPoolStatus() {
    const poolManager = getProviderPoolManager();
    if (!poolManager) return { total: 0, healthy: 0, unhealthy: 0, providers: [] };

    const pool = poolManager.providerStatus['openai-codex-oauth'] || [];
    return {
        total: pool.length,
        healthy: pool.filter(p => p.config.isHealthy && !p.config.isDisabled && !p.config.isReplaced).length,
        unhealthy: pool.filter(p => !p.config.isHealthy || p.config.isDisabled || p.config.isReplaced).length,
        providers: pool.map(p => ({
            uuid: p.config.uuid,
            email: (p.config.CODEX_OAUTH_CREDS_FILE_PATH || '').split('/').pop()?.replace(/^[\d_]+codex-/, '').replace('.json', '') || 'unknown',
            isHealthy: p.config.isHealthy,
            isDisabled: p.config.isDisabled,
            usageCount: p.config.usageCount,
            errorCount: p.config.errorCount,
            lastUsed: p.config.lastUsed,
            timestamp: parseInt((p.config.CODEX_OAUTH_CREDS_FILE_PATH || '').split('/').pop()?.split('_')[0] || '0'),
        }))
    };
}

export async function removeUnhealthyAccounts() {
    const poolManager = getProviderPoolManager();
    if (!poolManager) return 0;

    const pool = poolManager.providerStatus['openai-codex-oauth'] || [];
    const unhealthy = pool.filter(p => !p.config.isHealthy || p.config.isDisabled || p.config.isReplaced);

    let removed = 0;
    for (const p of unhealthy) {
        try {
            // 只禁用，不删除文件，防止误删
            if (poolManager.disableProvider) poolManager.disableProvider('openai-codex-oauth', { uuid: p.config.uuid });
            else p.config.isDisabled = true;
            removed++;
        } catch (e) {
            logger.warn(`[CodexRegister] 禁用账号失败: ${p.config.uuid}`, e.message);
        }
    }
    if (removed > 0) logger.info(`[CodexRegister] 禁用了 ${removed} 个异常账号（文件保留）`);
    return removed;
}

export async function removeOldestAccounts(count = 1) {
    const poolManager = getProviderPoolManager();
    if (!poolManager) return 0;

    const pool = poolManager.providerStatus['openai-codex-oauth'] || [];
    const healthy = pool
        .filter(p => p.config.isHealthy && !p.config.isDisabled && !p.config.isReplaced)
        .map(p => ({
            uuid: p.config.uuid,
            credPath: p.config.CODEX_OAUTH_CREDS_FILE_PATH,
            timestamp: parseInt((p.config.CODEX_OAUTH_CREDS_FILE_PATH || '').split('/').pop()?.split('_')[0] || '0'),
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

    const toRemove = healthy.slice(0, count);
    let removed = 0;
    for (const item of toRemove) {
        try {
            // 只禁用，不删除文件，防止误删
            if (poolManager.disableProvider) poolManager.disableProvider('openai-codex-oauth', { uuid: item.uuid });
            else {
                const p = pool.find(x => x.config.uuid === item.uuid);
                if (p) p.config.isDisabled = true;
            }
            removed++;
        } catch (e) {
            logger.warn(`[CodexRegister] 禁用最老账号失败: ${item.uuid}`, e.message);
        }
    }
    return removed;
}

export async function runMaintenanceTask() {
    if (registerTaskRunning) {
        logger.info('[CodexRegister] 维护任务跳过：注册任务运行中');
        return;
    }
    logger.info('[CodexRegister] 执行维护任务...');
    try {
        const status = getCodexPoolStatus();
        logger.info(`[CodexRegister] 账号池: 总=${status.total} 健康=${status.healthy} 异常=${status.unhealthy}`);

        const regCount = getRegisterCount();
        const regWorkers = getRegisterWorkers();
        if (status.unhealthy > 0) {
            const removed = await removeUnhealthyAccounts();
            const cur = getCodexPoolStatus();
            const need = Math.min(removed, getTargetPoolSize() - cur.healthy);
            if (need > 0) await runRegisterScript(Math.min(need, regCount), regWorkers);
        } else {
            logger.info(`[CodexRegister] 无异常账号，轮换：注册 ${regCount} 个新账号...`);
            await runRegisterScript(regCount, regWorkers);
            const cur = getCodexPoolStatus();
            if (cur.healthy > getTargetPoolSize()) {
                await removeOldestAccounts(cur.healthy - getTargetPoolSize());
            }
        }
        logger.info('[CodexRegister] 维护任务完成');
    } catch (e) {
        logger.error('[CodexRegister] 维护任务失败:', e.message);
    }
}

export function startMaintenanceScheduler() {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    const interval = getMaintenanceInterval();
    logger.info(`[CodexRegister] 启动定时维护，间隔: ${interval / 60000} 分钟`);
    maintenanceTimer = setInterval(runMaintenanceTask, interval);
}

export function stopMaintenanceScheduler() {
    if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
        logger.info('[CodexRegister] 已停止定时维护');
    }
}

export function getMaintenanceSchedulerStatus() {
    return {
        running: maintenanceTimer !== null,
        interval: getMaintenanceInterval(),
        targetPoolSize: getTargetPoolSize(),
        registerCount: getRegisterCount(),
        registerWorkers: getRegisterWorkers(),
    };
}
