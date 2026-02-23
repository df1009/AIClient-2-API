# Bug 报告

## 补充测试发现的 Bug

---

### BUG-001：后端缺少配置字段最小值校验（严重）

- 用例：UI-CFG-008 / UI-CFG-009
- 严重程度：中
- 复现步骤：
  1. 通过 API 直接 POST `/api/config`，设置 `AUTO_AFTER_SALE_INTERVAL: 10000`（HTML min=30000）
  2. 或在前端页面填入低于最小值的数字后点击保存
- 预期：拒绝保存，返回校验错误
- 实际：成功保存，内存和文件均更新为非法值
- 根因：
  - 前端 `saveConfiguration()` 函数（config-manager.js L231）直接用 `parseInt()` 读取值，未调用 `checkValidity()` 或 `reportValidity()`
  - 后端 `/api/config` 接口无任何字段范围校验
- 影响：扫描间隔设为过小值可能导致频繁请求商城 API，紧急间隔过小可能导致 API 限流
- 建议：
  - 前端：保存前调用 `form.reportValidity()` 或手动校验 number input 的 min/max
  - 后端：添加配置字段范围校验（INTERVAL >= 30000, URGENT_INTERVAL >= 5000）

---

### BUG-002：ApiClient 不检查 HTTP 状态码（严重）

- 用例：UI-IMP-012
- 严重程度：高
- 复现步骤：
  1. 打开售后导入弹窗
  2. 填入不存在的订单 ID（如 99999）和任意凭据
  3. 点击导入
- 预期：显示错误信息（如"商城 API 调用失败"）
- 实际：显示"自动售后账号导入成功 UUID:"（UUID 为空）
- 根因：`ApiClient.request()` 方法（auth.js L120-140）在收到 JSON 响应时直接 `return await response.json()`，仅处理了 401 状态码，未检查 `response.ok` 或其他错误状态码。当后端返回 `{ success: false, error: "..." }` 时（HTTP 400/500），前端不会 throw error，导致调用方的 try 块走成功分支。
- 影响：所有使用 `apiClient.post()` 的功能在后端返回非 401 错误时都会被误判为成功
- 建议：在 `request()` 方法中添加：
  ```javascript
  if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
  }
  ```

---

### BUG-003：启动日志明文打印 API Key（低）

- 用例：LOG-004
- 严重程度：低
- 复现步骤：查看 `logs/app-*.log` 文件
- 实际：日志中出现 `Required API Key: 123456`（明文）
- 位置：启动配置打印逻辑
- 影响：日志文件泄露 API Key，如果日志被共享或上传可能导致安全风险
- 建议：打印时脱敏，如 `Required API Key: 1234**`（只显示前 4 位）

---

### BUG-004：邮箱密码为空时无前端提示（建议）

- 用例：UI-CFG-010
- 严重程度：建议
- 复现步骤：清空商城邮箱和密码字段后保存
- 实际：保存成功，无任何提示
- 影响：用户可能误清空导致售后功能静默失败（后端 `_getShopClient()` 返回 null）
- 建议：当 AUTO_AFTER_SALE_ENABLED=true 且邮箱或密码为空时，前端显示警告提示
