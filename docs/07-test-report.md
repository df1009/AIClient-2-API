# 测试报告

## 第十四节：补充测试

测试时间：2026-02-23 18:40 ~ 19:00
测试环境：localhost:3566，Node v25.6.0，macOS
测试方式：浏览器操作（OpenClaw browser）+ curl API 调用 + 源码审查

---

### UI 配置测试

| 用例 ID | 用例名称 | 结果 | 证据 |
|---------|---------|------|------|
| UI-CFG-004 | Toggle 重新开启后输入框恢复可编辑 | ✅ PASS | 取消勾选后 7 个字段全部 disabled=true，重新勾选后全部 disabled=false |
| UI-CFG-008 | 扫描间隔最小值校验（填 10000 保存） | ❌ FAIL | HTML min=30000 但 JS saveConfiguration() 未调用 checkValidity()，后端也无校验，10000 成功保存 |
| UI-CFG-009 | 紧急间隔最小值校验（填 1000 保存） | ❌ FAIL | HTML min=5000 但同上原因，1000 成功保存 |
| UI-CFG-010 | 邮箱密码为空时保存 | ⚠️ WARN | 空值可以保存成功，可能是设计如此（允许清空以禁用售后），但无前端提示 |

### UI 导入测试

| 用例 ID | 用例名称 | 结果 | 证据 |
|---------|---------|------|------|
| UI-IMP-005 | Tab 切换保留共用字段 | ✅ PASS | 手动填写中输入 orderId=852 和 accountInfo，切换到 JSON 粘贴后两个字段值保留 |
| UI-IMP-011 | JSON 粘贴模式正常导入 | ✅ PASS | 粘贴有效 JSON 后显示"✓ 已识别 clientId/clientSecret/refreshToken"提示 |
| UI-IMP-012 | 导入失败弹窗不关闭 | ❌ FAIL | 弹窗确实不关闭，但原因是 ApiClient 不检查 HTTP 状态码，导致 400/500 错误被当作成功处理，显示"导入成功 UUID:"（空 UUID） |
| UI-IMP-013 | 防重复点击 | ✅ PASS | 点击后按钮立即 disabled=true，文本变为"Importing..."，请求完成后恢复 |

### UI 列表测试

| 用例 ID | 用例名称 | 结果 | 证据 |
|---------|---------|------|------|
| UI-LIST-003 | 售后节点详情展示 | ✅ PASS（代码审查） | modal.js L390-395：importSource='auto-after-sale' 时显示紫色"售后"badge，当前无售后节点无法页面验证 |
| UI-LIST-004 | 过期节点标识 | ✅ PASS（代码审查） | modal.js L394：afterSaleMeta.afterSaleExpired=true 时显示灰色"过期"badge |
| UI-LIST-005 | 导入成功后列表刷新 | ✅ PASS（代码审查） | provider-manager.js L2890：导入成功后调用 loadProviders() 刷新列表 |

### API 测试

| 用例 ID | 用例名称 | 结果 | 证据 |
|---------|---------|------|------|
| API-IMP-007 | 订单无交付记录 | ✅ PASS | curl 订单 99999 返回 `{"success":false,"error":"商城 API 调用失败: Request failed with status code 404"}`；curl 订单 852 + 错误 accountInfo 返回 `{"success":false,"error":"未在订单中找到匹配的账号（accountInfo 不匹配）"}` |
| API-IMP-008 | region 默认值 | ✅ PASS | 代码中多处 `\|\| 'us-east-1'`：oauth-api.js L229, kiro-oauth.js L256/362/648, provider-pool-manager.js L2069 |

### 配置生效测试

| 用例 ID | 用例名称 | 结果 | 证据 |
|---------|---------|------|------|
| CFG-003 | 修改 INTERVAL 生效 | ✅ PASS | 修改为 60000 后，内存和 config.json 文件均为 60000 |
| CFG-004 | 修改 shopEmail 清除 token | ✅ PASS | provider-pool-manager.js L1802-1806：_getShopClient() 检测 email 变化后 clearToken() + 重建客户端 |
| CFG-005 | 修改 shopBaseUrl 清除 token | ✅ PASS | 同上逻辑，L1803 检测 baseUrl 变化。ERR-002 测试间接验证（改 baseUrl 后触发重新登录） |

### 错误处理测试

| 用例 ID | 用例结果 | 证据 |
|---------|---------|------|------|
| ERR-002 | 商城不可达 | ✅ PASS | 将 shopBaseUrl 改为 invalid-shop-url-12345.xyz 后导入返回 `{"success":false,"error":"商城 API 调用失败: Shop login failed: getaddrinfo ENOTFOUND invalid-shop-url-12345.xyz"}` |

### 定时任务测试

| 用例 ID | 用例名称 | 结果 | 证据 |
|---------|---------|------|------|
| CRON-009 | 紧急换号完整流程 | ✅ PASS（代码审查） | provider-pool-manager.js L1962-2150：检测封号→启动紧急定时器→调用 replaceBanned→解析新账号→创建新节点→继承属性→禁用旧节点→广播事件。当前无封号节点无法实际触发 |

### 日志测试

| 用例 ID | 用例名称 | 结果 | 证据 |
|---------|---------|------|------|
| LOG-004 | 日志脱敏 | ❌ FAIL | 启动日志明文打印 `Required API Key: 123456`（app-2026-02-23.出现 3 次）。密码和邮箱未泄露 |

---

### 测试统计

| 类别 | 总数 | 通过 | 失败 | 警告 |
|------|------|------|------|------|
| UI 测试 | 11 | 7 | 3 | 1 |
| API 测试 | 2 | 2 | 0 | 0 |
| 配置测试 | 3 | 3 | 0 | 0 |
| 错误处理 | 1 | 1 | 0 | 0 |
| 定时任务 | 1 | 1 | 0 | 0 |
| 日志 | 1 | 0 | 1 | 0 |
| **合计** | **19** | **14** | **4** | **1** |

注：UI-LIST-003/004/005 和 CRON-009 因缺少售后节点数据，通过代码审查验证逻辑正确性，未能在页面上实际操作验证。
