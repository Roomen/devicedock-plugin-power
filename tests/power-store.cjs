'use strict'
// 内存分块压缩冷存储（js/power-store.js）的上限与淘汰回归：
// 超限按最早写入的块淘汰并回报、原始当量与压缩后用量分开统计、淘汰后回读报错、清空后重新计数。
// 插件 sandbox 里没有 OPFS / IndexedDB / localStorage，所以这里只有内存实现，没有别的后端可回退。
const assert = require('node:assert/strict')
const Store = require('../js/power-store.js')

const f32 = (n, v) => {
	const a = new Float32Array(n)
	for (let i = 0; i < n; i++) a[i] = v == null ? i : v
	return a
}

;(async function () {
	// ---- 基本写入 / 回读 / 压缩 ----
	{
		const st = Store.createMemoryWaveStore({ capRawBytes: 1024 * 1024 })
		assert.equal(await st.init(), 'memory')
		assert.equal(st.getBackend(), 'memory')
		const data = f32(4096, 7)
		const res = await st.writeChunk('c1', data)
		assert.equal(res.rawBytes, 4096 * 4)
		assert.ok(res.byteSize > 0 && res.byteSize < res.rawBytes, '常量块应被压小：' + res.byteSize)
		assert.equal(st.getRawUsed(), 4096 * 4)
		assert.equal(st.getCompressedUsed(), res.byteSize)
		const back = await st.readChunk('c1', 4096)
		assert.equal(back.length, 4096)
		assert.equal(back[0], 7)
		assert.equal(back[4095], 7)
		// 不可压缩的数据也要能读回来（此时存原始字节）
		const noisy = new Float32Array(1024)
		for (let i = 0; i < noisy.length; i++) noisy[i] = Math.sin(i * 12.9898) * 43758.5453
		await st.writeChunk('c2', noisy)
		const nb = await st.readChunk('c2', noisy.length)
		for (let i = 0; i < noisy.length; i++) assert.equal(nb[i], noisy[i])
	}

	// ---- 超上限：按最早写入的块淘汰并回报 ----
	{
		const evicted = []
		const st = Store.createMemoryWaveStore({
			capRawBytes: 4 * 4096 * 4, // 只能放 4 块
			onEvict: (list) => { evicted.push(list.map((x) => x.id)) },
		})
		for (let i = 0; i < 7; i++) await st.writeChunk('c' + i, f32(4096, i))
		assert.ok(st.getRawUsed() <= st.getCapBytes(), '原始当量不能超过上限：' + st.getRawUsed())
		assert.deepEqual(evicted, [['c0'], ['c1'], ['c2']], '超限按最早块淘汰：' + JSON.stringify(evicted))
		assert.equal(st.blockCount(), 4)
		// 被淘汰的块再也读不到（调用方据此标缺口）
		await assert.rejects(() => st.readChunk('c0', 4096), /不存在/)
		assert.ok((await st.readChunk('c6', 4096))[0] === 6)
		// 淘汰时压缩后用量一起回落
		assert.ok(st.getCompressedUsed() > 0)
		assert.ok(st.getCompressedUsed() < st.getRawUsed())
	}

	// ---- 重写同一个 id：先放弃旧副本，不因此挤掉别的块 ----
	{
		const evicted = []
		const st = Store.createMemoryWaveStore({
			capRawBytes: 3 * 4096 * 4,
			onEvict: (list) => { evicted.push(list.map((x) => x.id)) },
		})
		await st.writeChunk('a', f32(4096, 1))
		await st.writeChunk('b', f32(4096, 2))
		await st.writeChunk('c', f32(4096, 3))
		// 空间已满时重写 a：a 的旧副本先被放弃，别人不该被挤出
		const r = await st.writeChunk('a', f32(4096, 9))
		assert.equal(r.evicted.length, 0, '重写同一 id 不该淘汰任何块')
		assert.equal(evicted.length, 0)
		assert.equal((await st.readChunk('a', 4096))[0], 9, '重写的块内容是新数据')
		assert.equal((await st.readChunk('b', 4096))[0], 2, '其它块还在')
		assert.equal(st.getRawUsed(), 3 * 4096 * 4)
	}

	// ---- 上限可调：改小后下次写入把老块淘汰到新上限以内 ----
	{
		const st = Store.createMemoryWaveStore({ capRawBytes: 8 * 4096 * 4 })
		for (let i = 0; i < 8; i++) await st.writeChunk('c' + i, f32(4096, i))
		assert.equal(st.blockCount(), 8)
		st.setCapBytes(2 * 4096 * 4)
		await st.writeChunk('c8', f32(4096, 8))
		assert.ok(st.getRawUsed() <= 2 * 4096 * 4, '写入后要落到新上限以内：' + st.getRawUsed())
		assert.equal(st.blockCount(), 2)
	}

	// ---- 清空会话：用量归零、块清空、会话号推进 ----
	{
		const st = Store.createMemoryWaveStore({ capRawBytes: 1024 * 1024 })
		await st.writeChunk('c1', f32(1024))
		const s0 = st.getSession()
		await st.clearSession()
		assert.equal(st.blockCount(), 0)
		assert.equal(st.getRawUsed(), 0)
		assert.equal(st.getCompressedUsed(), 0)
		assert.equal(st.getSession(), s0 + 1)
		await assert.rejects(() => st.readChunk('c1', 1024), /不存在/)
		// 清空后还能继续写
		await st.writeChunk('c2', f32(1024, 5))
		assert.equal((await st.readChunk('c2', 1024))[0], 5)
	}

	// ---- 长度不符要明确报错（不返回半截数据）----
	{
		const st = Store.createMemoryWaveStore({ capRawBytes: 1024 * 1024 })
		await st.writeChunk('c1', f32(1024, 3))
		await assert.rejects(() => st.readChunk('c1', 2048), /长度不符/)
	}

	console.log('power-store: ok')
})().catch((e) => { console.error(e); process.exit(1) })
