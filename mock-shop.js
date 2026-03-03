/**
 * 模拟商城服务 - 用于本地测试售后换号功能
 * 端口: 9999
 */
import http from 'http';

const PORT = 9999;

// 模拟数据
let stockAvailable = true; // 控制库存是否充足
let replaceCount = 0;

const MOCK_ORDER = {
    id: 1085,
    order_no: 'SO1772000000TEST',
    quantity: 5,
    delivered_count: 3,
    status: 'paid',
    product_name: '10K积分账号',
    quota_type: '10k',
    warranty_hours: 36,
    deliveries: [
        {
            id: 1189,
            account_count: 3,
            account_ids: [5311, 5312, 5313],
            account_data: [
                {
                    id: 5311,
                    email: 'egestqq@test.com',
                    subscription_info: '10000----https://d-test001.awsapps.com/start/----egestqq----@Qq344788----FAKETOKEN001',
                    account_info: 'egestqq-@Qq344788'
                },
                {
                    id: 5312,
                    email: 'testuser2@test.com',
                    subscription_info: '10000----https://d-test002.awsapps.com/start/----testuser2----@Qq344788----FAKETOKEN002',
                    account_info: 'testuser2-@Qq344788'
                }
            ],
            delivered_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() // 2小时前交付
        }
    ]
};

function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { resolve({}); }
        });
    });
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method;
    const body = method === 'POST' ? await parseBody(req) : {};

    console.log(`[Mock Shop] ${method} ${path}`, method === 'POST' ? JSON.stringify(body) : '');

    // 登录
    if (method === 'POST' && path === '/shop/api/auth/login') {
        return sendJson(res, 200, {
            success: true,
            token: 'mock-jwt-token-for-testing',
            user: { id: 1, email: body.email }
        });
    }

    // 订单详情
    const orderDetailMatch = path.match(/^\/shop\/api\/orders\/(\d+)$/);
    if (method === 'GET' && orderDetailMatch) {
        const orderId = parseInt(orderDetailMatch[1]);
        return sendJson(res, 200, { ...MOCK_ORDER, id: orderId });
    }

    // 检测封号
    const checkBanMatch = path.match(/^\/shop\/api\/orders\/(\d+)\/check-ban$/);
    if (method === 'POST' && checkBanMatch) {
        return sendJson(res, 200, {
            success: true,
            total: 1,
            banned_count: 1,
            results: [
                {
                    email: 'egestqq@test.com',
                    banned: true,
                    status: 'disabled',
                    account_id: body.account_id || 5311,
                    subscription_url: 'https://d-test001.awsapps.com/start/'
                }
            ]
        });
    }

    // 自助换号
    const replaceMatch = path.match(/^\/shop\/api\/orders\/(\d+)\/replace-banned$/);
    if (method === 'POST' && replaceMatch) {
        replaceCount++;

        if (!stockAvailable) {
            return sendJson(res, 400, { detail: '号池库存不足，无法换号' });
        }

        // 模拟新账号
        const newId = 6000 + replaceCount;
        return sendJson(res, 200, {
            success: true,
            new_account: {
                id: newId,
                email: `newuser${newId}@test.com`,
                subscription_info: `10000----https://d-test${newId}.awsapps.com/start/----newuser${newId}----@Qq344788----FAKETOKEN${newId}`,
                account_info: `newuser${newId}-@Qq344788`,
                account_json: JSON.stringify({
                    clientId: `mock-client-id-${newId}`,
                    clientSecret: `mock-client-secret-${newId}`,
                    refreshToken: `mock-refresh-token-${newId}`
                }),
                subscription_url: `https://d-test${newId}.awsapps.com/start/`
            }
        });
    }

    // 控制接口：切换库存状态
    if (method === 'POST' && path === '/mock/toggle-stock') {
        stockAvailable = !stockAvailable;
        console.log(`[Mock Shop] Stock toggled: ${stockAvailable ? 'AVAILABLE' : 'OUT OF STOCK'}`);
        return sendJson(res, 200, { stockAvailable });
    }

    // 控制接口：查看状态
    if (method === 'GET' && path === '/mock/status') {
        return sendJson(res, 200, { stockAvailable, replaceCount });
    }

    // 404
    sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
    console.log(`[Mock Shop] 模拟商城服务已启动: http://localhost:${PORT}`);
    console.log(`[Mock Shop] 控制接口:`);
    console.log(`  POST /mock/toggle-stock  - 切换库存状态`);
    console.log(`  GET  /mock/status        - 查看当前状态`);
    console.log(`[Mock Shop] 当前库存: ${stockAvailable ? '充足' : '不足'}`);
});
