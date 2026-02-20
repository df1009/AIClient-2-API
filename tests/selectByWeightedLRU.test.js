// Mock ESM modules that cause import issues
jest.mock('open', () => jest.fn());
jest.mock('axios', () => ({ default: { create: jest.fn() } }));

import { selectByWeightedLRU } from '../src/providers/provider-pool-manager.js';

describe('selectByWeightedLRU', () => {
    const now = Date.now();

    // 1. 空输入
    test('returns null for empty array', () => {
        expect(selectByWeightedLRU([], now)).toBeNull();
    });

    test('returns null for null input', () => {
        expect(selectByWeightedLRU(null, now)).toBeNull();
    });

    test('returns null for undefined input', () => {
        expect(selectByWeightedLRU(undefined, now)).toBeNull();
    });

    // 2. 单节点
    test('returns the only candidate for single node', () => {
        const candidates = [{ uuid: 'a', weight: 100, lastUsed: null }];
        const result = selectByWeightedLRU(candidates, now);
        expect(result.selected.uuid).toBe('a');
        expect(result.debug).toHaveLength(1);
        expect(result.debug[0].isGroupLRU).toBe(true);
    });

    // 3. 加权分布 - 高权重节点被选中概率更高
    test('weighted distribution favors higher weight', () => {
        const candidates = [
            { uuid: 'high', weight: 900, lastUsed: null },
            { uuid: 'low', weight: 100, lastUsed: null }
        ];
        const counts = { high: 0, low: 0 };
        for (let i = 0; i < 1000; i++) {
            const result = selectByWeightedLRU(candidates, now);
            counts[result.selected.uuid]++;
        }
        // high should be selected ~90% of the time
        expect(counts.high).toBeGreaterThan(800);
        expect(counts.low).toBeGreaterThan(0);
    });

    // 4. 极端权重
    test('extreme weight difference', () => {
        const candidates = [
            { uuid: 'heavy', weight: 10000, lastUsed: null },
            { uuid: 'light', weight: 1, lastUsed: null }
        ];
        const counts = { heavy: 0, light: 0 };
        for (let i = 0; i < 1000; i++) {
            const result = selectByWeightedLRU(candidates, now);
            counts[result.selected.uuid]++;
        }
        expect(counts.heavy).toBeGreaterThan(950);
    });

    // 5. 等权重 LRU 轮流
    test('equal weight nodes rotate by LRU', () => {
        const candidates = [
            { uuid: 'a', weight: 100, lastUsed: '2024-01-01T00:00:00Z' },
            { uuid: 'b', weight: 100, lastUsed: '2024-01-01T00:01:00Z' },
            { uuid: 'c', weight: 100, lastUsed: '2024-01-01T00:02:00Z' }
        ];
        // All same weight -> one group -> LRU is 'a' (earliest lastUsed)
        const result = selectByWeightedLRU(candidates, now);
        expect(result.selected.uuid).toBe('a');
    });

    // 6. 同权重 LRU 排序
    test('same weight group picks least recently used', () => {
        const candidates = [
            { uuid: 'recent', weight: 100, lastUsed: '2024-06-01T00:00:00Z' },
            { uuid: 'old', weight: 100, lastUsed: '2024-01-01T00:00:00Z' }
        ];
        const result = selectByWeightedLRU(candidates, now);
        expect(result.selected.uuid).toBe('old');
    });

    // 7. null lastUsed 被视为最早（优先选中）
    test('null lastUsed treated as epoch 0 (selected first)', () => {
        const candidates = [
            { uuid: 'used', weight: 100, lastUsed: '2024-06-01T00:00:00Z' },
            { uuid: 'never', weight: 100, lastUsed: null }
        ];
        const result = selectByWeightedLRU(candidates, now);
        expect(result.selected.uuid).toBe('never');
    });

    // 8. weight 缺失默认 100
    test('missing weight defaults to 100', () => {
        const candidates = [
            { uuid: 'a', lastUsed: null },
            { uuid: 'b', lastUsed: null }
        ];
        const result = selectByWeightedLRU(candidates, now);
        expect(result).not.toBeNull();
        expect(result.debug[0].weight).toBe(100);
        expect(result.debug[1].weight).toBe(100);
    });

    // 9. 混合权重 + LRU
    test('mixed weights with LRU within groups', () => {
        const candidates = [
            { uuid: 'a1', weight: 200, lastUsed: '2024-06-01T00:00:00Z' },
            { uuid: 'a2', weight: 200, lastUsed: '2024-01-01T00:00:00Z' },
            { uuid: 'b1', weight: 100, lastUsed: '2024-06-01T00:00:00Z' },
            { uuid: 'b2', weight: 100, lastUsed: '2024-03-01T00:00:00Z' }
        ];
        // Group 200: LRU is a2; Group 100: LRU is b2
        // Weighted random between a2 (weight 200) and b2 (weight 100)
        const counts = { a2: 0, b2: 0 };
        for (let i = 0; i < 1000; i++) {
            const result = selectByWeightedLRU(candidates, now);
            if (result.selected.uuid === 'a2') counts.a2++;
            if (result.selected.uuid === 'b2') counts.b2++;
        }
        // a2 should be selected ~66% of the time (200/300)
        expect(counts.a2).toBeGreaterThan(550);
        expect(counts.b2).toBeGreaterThan(200);
        expect(counts.a2 + counts.b2).toBe(1000);
    });

    // 10. debug 信息完整性
    test('debug info contains all candidates with correct fields', () => {
        const candidates = [
            { uuid: 'x', weight: 150, lastUsed: '2024-01-01T00:00:00Z' },
            { uuid: 'y', weight: 150, lastUsed: '2024-06-01T00:00:00Z' },
            { uuid: 'z', weight: 50, lastUsed: null }
        ];
        const result = selectByWeightedLRU(candidates, now);
        expect(result.debug).toHaveLength(3);
        result.debug.forEach(d => {
            expect(d).toHaveProperty('uuid');
            expect(d).toHaveProperty('weight');
            expect(d).toHaveProperty('lastUsed');
            expect(d).toHaveProperty('isGroupLRU');
        });
        // x is LRU of weight-150 group, z is LRU of weight-50 group
        const xDebug = result.debug.find(d => d.uuid === 'x');
        const yDebug = result.debug.find(d => d.uuid === 'y');
        const zDebug = result.debug.find(d => d.uuid === 'z');
        expect(xDebug.isGroupLRU).toBe(true);
        expect(yDebug.isGroupLRU).toBe(false);
        expect(zDebug.isGroupLRU).toBe(true);
    });

    // 11. debug 中 isGroupLRU 标记正确
    test('isGroupLRU correctly marks group representatives', () => {
        const candidates = [
            { uuid: 'a', weight: 100, lastUsed: null },
            { uuid: 'b', weight: 100, lastUsed: '2024-01-01T00:00:00Z' },
            { uuid: 'c', weight: 200, lastUsed: null },
            { uuid: 'd', weight: 200, lastUsed: '2024-01-01T00:00:00Z' }
        ];
        const result = selectByWeightedLRU(candidates, now);
        const debugMap = Object.fromEntries(result.debug.map(d => [d.uuid, d]));
        // a is LRU of weight-100 (null < any date), c is LRU of weight-200
        expect(debugMap.a.isGroupLRU).toBe(true);
        expect(debugMap.b.isGroupLRU).toBe(false);
        expect(debugMap.c.isGroupLRU).toBe(true);
        expect(debugMap.d.isGroupLRU).toBe(false);
    });

    // 12. 大量节点性能测试
    test('handles 1000 candidates efficiently', () => {
        const candidates = Array.from({ length: 1000 }, (_, i) => ({
            uuid: `node_${i}`,
            weight: (i % 5 + 1) * 100,
            lastUsed: new Date(Date.now() - i * 60000).toISOString()
        }));
        const start = Date.now();
        for (let i = 0; i < 100; i++) {
            selectByWeightedLRU(candidates, now);
        }
        const elapsed = Date.now() - start;
        // 100 iterations with 1000 candidates should complete in under 1 second
        expect(elapsed).toBeLessThan(1000);
    });

    // 13. 单权重组多节点
    test('single weight group with many nodes picks LRU', () => {
        const candidates = [
            { uuid: 'e', weight: 100, lastUsed: '2024-05-01T00:00:00Z' },
            { uuid: 'f', weight: 100, lastUsed: '2024-04-01T00:00:00Z' },
            { uuid: 'g', weight: 100, lastUsed: '2024-03-01T00:00:00Z' },
            { uuid: 'h', weight: 100, lastUsed: '2024-02-01T00:00:00Z' },
            { uuid: 'i', weight: 100, lastUsed: '2024-01-01T00:00:00Z' }
        ];
        // All same weight, LRU is 'i' (earliest)
        const result = selectByWeightedLRU(candidates, now);
        expect(result.selected.uuid).toBe('i');
    });
});
