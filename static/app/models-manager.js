/**
 * Models Manager - 管理可用模型列表的显示和复制功能
 * Models Manager - Manages the display and copy functionality of available models
 */

import { t } from './i18n.js';

// 模型数据缓存
let modelsCache = null;
let customModelsCache = null;

const authHeaders = () => ({
    'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`,
    'Content-Type': 'application/json'
});

/**
 * 获取所有提供商的可用模型
 * @returns {Promise<Object>} 模型数据
 */
async function fetchProviderModels() {
    if (modelsCache) {
        return modelsCache;
    }
    
    try {
        const response = await fetch('/api/provider-models', {
            headers: authHeaders()
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        modelsCache = await response.json();
        return modelsCache;
    } catch (error) {
        console.error('[Models Manager] Failed to fetch provider models:', error);
        throw error;
    }
}

async function fetchCustomModels() {
    try {
        const response = await fetch('/api/custom-models', { headers: authHeaders() });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        customModelsCache = await response.json();
        return customModelsCache;
    } catch (error) {
        console.error('[Models Manager] Failed to fetch custom models:', error);
        customModelsCache = {};
        return {};
    }
}

async function addCustomModel(providerType, modelName) {
    const response = await fetch('/api/custom-models', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ providerType, modelName })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Failed to add model');
    return data;
}

async function deleteCustomModel(providerType, modelName) {
    const response = await fetch('/api/custom-models', {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ providerType, modelName })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Failed to delete model');
    return data;
}

/**
 * 复制文本到剪贴板
 * @param {string} text - 要复制的文本
 * @returns {Promise<boolean>} 是否复制成功
 */
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
    } catch (error) {
        console.error('[Models Manager] Failed to copy to clipboard:', error);
        return false;
    }
}

/**
 * 显示复制成功的 Toast 提示
 * @param {string} modelName - 模型名称
 */
function showCopyToast(modelName) {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;
    
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.innerHTML = `
        <i class="fas fa-check-circle"></i>
        <span>${t('models.copied') || '已复制'}: ${modelName}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    // 自动移除
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 2000);
}

/**
 * 渲染模型列表
 * @param {Object} models - 模型数据
 * @param {Object} customModels - 自定义模型数据
 */
function renderModelsList(models, customModels = {}) {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    const providerTypes = Object.keys(models);
    if (providerTypes.length === 0) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-cube"></i>
                <p data-i18n="models.empty">${t('models.empty') || '暂无可用模型'}</p>
            </div>
        `;
        return;
    }
    
    let html = '';
    
    for (const providerType of providerTypes) {
        const modelList = models[providerType];
        if (!modelList || modelList.length === 0) continue;
        
        const providerDisplayName = getProviderDisplayName(providerType);
        const providerIcon = getProviderIcon(providerType);
        const customSet = new Set(customModels[providerType] || []);
        
        html += `
            <div class="provider-models-group" data-provider="${providerType}">
                <div class="provider-models-header" onclick="window.toggleProviderModels('${providerType}')">
                    <div class="provider-models-title">
                        <i class="${providerIcon}"></i>
                        <h3>${providerDisplayName}</h3>
                        <span class="provider-models-count">${modelList.length}</span>
                    </div>
                    <div class="provider-models-toggle">
                        <i class="fas fa-chevron-down"></i>
                    </div>
                </div>
                <div class="provider-models-content" id="models-${providerType}">
                    ${modelList.map(model => {
                        const isCustom = customSet.has(model);
                        return `
                        <div class="model-item ${isCustom ? 'model-item-custom' : ''}" onclick="window.copyModelName('${escapeHtml(model)}', this)" title="${t('models.clickToCopy') || '点击复制'}">
                            <div class="model-item-icon">
                                <i class="fas fa-cube"></i>
                            </div>
                            <span class="model-item-name">${escapeHtml(model)}</span>
                            ${isCustom ? `<span class="model-custom-badge">${t('models.custom') || '自定义'}</span>
                            <div class="model-item-delete" onclick="event.stopPropagation(); window.deleteCustomModelUI('${escapeHtml(providerType)}', '${escapeHtml(model)}')" title="${t('models.deleteCustom') || '删除自定义模型'}">
                                <i class="fas fa-trash-alt"></i>
                            </div>` : `
                            <div class="model-item-copy">
                                <i class="fas fa-copy"></i>
                            </div>`}
                        </div>`;
                    }).join('')}
                    <div class="model-add-custom" onclick="event.stopPropagation(); window.showAddCustomModelInput('${escapeHtml(providerType)}')" title="${t('models.addCustom') || '添加自定义模型'}">
                        <i class="fas fa-plus"></i>
                        <span>${t('models.addCustom') || '添加自定义模型'}</span>
                    </div>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

/**
 * 获取提供商显示名称
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(providerType) {
    const displayNames = {
        'gemini-cli-oauth': 'Gemini CLI (OAuth)',
        'gemini-antigravity': 'Gemini Antigravity',
        'claude-custom': 'Claude Custom',
        'claude-kiro-oauth': 'Claude Kiro (OAuth)',
        'openai-custom': 'OpenAI Custom',
        'openaiResponses-custom': 'OpenAI Responses Custom',
        'openai-qwen-oauth': 'Qwen (OAuth)',
        'openai-iflow': 'iFlow',
        'openai-codex-oauth': 'OpenAI Codex (OAuth)'
    };

    return displayNames[providerType] || providerType;
}

/**
 * 获取提供商图标
 * @param {string} providerType - 提供商类型
 * @returns {string} 图标类名
 */
function getProviderIcon(providerType) {
    if (providerType.includes('gemini')) {
        return 'fas fa-gem';
    } else if (providerType.includes('claude')) {
        return 'fas fa-robot';
    } else if (providerType.includes('openai') || providerType.includes('qwen') || providerType.includes('iflow')) {
        return 'fas fa-brain';
    }
    return 'fas fa-server';
}

/**
 * HTML 转义
 * @param {string} text - 原始文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 切换提供商模型列表的展开/折叠状态
 * @param {string} providerType - 提供商类型
 */
function toggleProviderModels(providerType) {
    const group = document.querySelector(`.provider-models-group[data-provider="${providerType}"]`);
    if (!group) return;
    
    const header = group.querySelector('.provider-models-header');
    const content = group.querySelector('.provider-models-content');
    
    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        header.classList.remove('collapsed');
    } else {
        content.classList.add('collapsed');
        header.classList.add('collapsed');
    }
}

/**
 * 复制模型名称
 * @param {string} modelName - 模型名称
 * @param {HTMLElement} element - 点击的元素
 */
async function copyModelName(modelName, element) {
    const success = await copyToClipboard(modelName);
    
    if (success) {
        // 添加复制成功的视觉反馈
        element.classList.add('copied');
        setTimeout(() => {
            element.classList.remove('copied');
        }, 1000);
        
        // 显示 Toast 提示
        showCopyToast(modelName);
    }
}

/**
 * 显示添加自定义模型的输入框
 */
function showAddCustomModelInput(providerType) {
    const existing = document.getElementById(`add-custom-input-${providerType}`);
    if (existing) {
        existing.querySelector('input').focus();
        return;
    }

    const content = document.getElementById(`models-${providerType}`);
    if (!content) return;

    const addBtn = content.querySelector('.model-add-custom');
    const wrapper = document.createElement('div');
    wrapper.id = `add-custom-input-${providerType}`;
    wrapper.className = 'custom-model-input-wrapper';
    wrapper.innerHTML = `
        <input type="text" class="custom-model-input" placeholder="${t('models.inputPlaceholder') || '输入模型名称'}" />
        <button class="custom-model-confirm" onclick="window.confirmAddCustomModel('${escapeHtml(providerType)}')">
            <i class="fas fa-check"></i>
        </button>
        <button class="custom-model-cancel" onclick="window.cancelAddCustomModel('${escapeHtml(providerType)}')">
            <i class="fas fa-times"></i>
        </button>
    `;

    content.insertBefore(wrapper, addBtn);
    const input = wrapper.querySelector('input');
    input.focus();
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') window.confirmAddCustomModel(providerType);
        if (e.key === 'Escape') window.cancelAddCustomModel(providerType);
    });
}

async function confirmAddCustomModel(providerType) {
    const wrapper = document.getElementById(`add-custom-input-${providerType}`);
    if (!wrapper) return;
    const input = wrapper.querySelector('input');
    const modelName = input.value.trim();
    if (!modelName) return;

    try {
        await addCustomModel(providerType, modelName);
        showToast(t('models.addSuccess') || '添加成功', 'success');
        await refreshModels();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function cancelAddCustomModel(providerType) {
    const wrapper = document.getElementById(`add-custom-input-${providerType}`);
    if (wrapper) wrapper.remove();
}

async function deleteCustomModelUI(providerType, modelName) {
    if (!confirm(`${t('models.confirmDelete') || '确定删除自定义模型'} "${modelName}" ?`)) return;
    try {
        await deleteCustomModel(providerType, modelName);
        showToast(t('models.deleteSuccess') || '删除成功', 'success');
        await refreshModels();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function showToast(message, type = 'success') {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
    toast.innerHTML = `<i class="fas ${icon}"></i><span>${message}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

/**
 * 初始化模型管理器
 */
async function initModelsManager() {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    try {
        const [models, customs] = await Promise.all([
            fetchProviderModels(),
            fetchCustomModels()
        ]);
        renderModelsList(models, customs);
    } catch (error) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-exclamation-triangle"></i>
                <p>${t('models.loadError') || '加载模型列表失败'}</p>
            </div>
        `;
    }
}

/**
 * 刷新模型列表
 */
async function refreshModels() {
    modelsCache = null;
    customModelsCache = null;
    await initModelsManager();
}

// 导出到全局作用域供 HTML 调用
window.toggleProviderModels = toggleProviderModels;
window.copyModelName = copyModelName;
window.refreshModels = refreshModels;
window.showAddCustomModelInput = showAddCustomModelInput;
window.confirmAddCustomModel = confirmAddCustomModel;
window.cancelAddCustomModel = cancelAddCustomModel;
window.deleteCustomModelUI = deleteCustomModelUI;

// 监听组件加载完成事件
window.addEventListener('componentsLoaded', () => {
    initModelsManager();
});

// 导出函数
export {
    initModelsManager,
    refreshModels,
    fetchProviderModels
};