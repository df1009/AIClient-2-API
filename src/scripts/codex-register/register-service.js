/**
 * Codex 账号自动注册服务
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../../utils/logger.js';
import { getProviderPoolManager } from '../../services/service-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = __dirname;
const SCRIPT_PATH = path.join(SCRIPT_DIR, 'chatgpt_register.py');
const REGISTER_CONFIG_PATH = path.join(SCRIPT_DIR, 'register-config.json');

let registerTaskRunning = false;
let registerTaskLog = [];
let registerTaskResult = null;
let maintenanceTimer = null;

const MAINTENANCE_INTERVAL = 10 * 60 * 1000;
const TARGET_POOL_SIZE = 50;

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

    const env = {
        ...process.env,
        TOTAL_ACCOUNTS: String(count),
        MAIL_PROVIDER: config.mail_provider || 'tempmail',
        TEMPMAIL_ADMIN_AUTH: config.tempmail_admin_auth || '',
        TEMPMAIL_API_BASE: config.tempmail_api_base || '',
        TEMPMAIL_DOMAIN: config.tempmail_domain || '',
        DUCKMAIL_BEARER: config.duckmail_bearer || '',
        HTTP_PROXY: config.proxy || '',
        HTTPS_PROXY: config.proxy || '',
        ALL_PROXY: config.proxy || '',
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

        let successCount = 0;
        let failCount = 0;

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim());
            lines.forEach(line => {
                registerTaskLog.push(`[${new Date().toLocaleTimeString()}] ${line}`);
                logger.info(`[CodexRegister] ${line}`);
                if (line.includes('[OK]') || line.includes('注册成功')) successCount++;
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
            registerTaskResult = { success: code === 0, registered: successCount, failed: failCount, exitCode: code };
            registerTaskLog.push(`[${new Date().toLocaleTimeString()}] 任务完成，成功: ${successCount}，失败: ${failCount}`);
            logger.info(`[CodexRegister] 任务完成，成功: ${successCount}，失败: ${failCount}`);

            if (successCount > 0) {
                try { await importNewTokensToPool(); } catch (e) { logger.error('[CodexRegister] 自动导入失败:', e.message); }
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

async function importNewTokensToPool() {
    const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../..');
    const tokenDir = path.join(PROJECT_ROOT, 'configs', 'codex');
    if (!fs.existsSync(tokenDir)) return;

    const poolManager = getProviderPoolManager();
    if (!poolManager) return;

    const pool = poolManager.providerStatus['openai-codex-oauth'] || [];
    // 用 email 去重，避免路径格式不一致导致重复导入
    // 注意：CODEX_OAUTH_CREDS_FILE_PATH 是相对于项目根目录的路径，需用 SCRIPT_DIR 向上推算
    const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../..');
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

    if (credentials.length === 0) return;

    logger.info(`[CodexRegister] 导入 ${credentials.length} 个新账号到池...`);
    const { batchImportCodexCredentialsStream } = await import('../../auth/oauth-handlers.js');
    await batchImportCodexCredentialsStream(credentials, null, true); // skipDuplicateCheck=true，已用 email 去重

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

        if (status.unhealthy > 0) {
            const removed = await removeUnhealthyAccounts();
            const cur = getCodexPoolStatus();
            const need = Math.min(removed, TARGET_POOL_SIZE - cur.healthy);
            if (need > 0) await runRegisterScript(need, 3);
        } else {
            logger.info('[CodexRegister] 无异常账号，轮换：注册1个新账号...');
            await runRegisterScript(1, 1);
            const cur = getCodexPoolStatus();
            if (cur.healthy > TARGET_POOL_SIZE) {
                await removeOldestAccounts(cur.healthy - TARGET_POOL_SIZE);
            }
        }
        logger.info('[CodexRegister] 维护任务完成');
    } catch (e) {
        logger.error('[CodexRegister] 维护任务失败:', e.message);
    }
}

export function startMaintenanceScheduler() {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    logger.info(`[CodexRegister] 启动定时维护，间隔: ${MAINTENANCE_INTERVAL / 60000} 分钟`);
    maintenanceTimer = setInterval(runMaintenanceTask, MAINTENANCE_INTERVAL);
}

export function stopMaintenanceScheduler() {
    if (maintenanceTimer) {
        clearInterval(maintenanceTimer);
        maintenanceTimer = null;
        logger.info('[CodexRegister] 已停止定时维护');
    }
}

export function getMaintenanceSchedulerStatus() {
    return { running: maintenanceTimer !== null, interval: MAINTENANCE_INTERVAL, targetPoolSize: TARGET_POOL_SIZE };
}
