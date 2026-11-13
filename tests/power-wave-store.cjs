'use strict'
// 波形分块存储的资源回归（从 web-serial-debug 的 power-wave-store 迁入，改用本仓库的
// js/power-wave.js 工厂 + 内存冷存储假实现）：
// 停采后宽视图不再反复回读、归档队列受内存上限约束、包络与原始数据一致、包络缓存只留视口附近的桶、
// 清空与在飞归档/回读隔离、未满块索引按 base 推断、块索引到顶后停采。
// 冷存储是假的，只用合成数据。
const assert = require('node:assert/strict')
const Wave = require('../js/power-wave.js')

const CHUNK = 65536

function makeStore(opts) {
	opts = opts || {}
	// cap: 冷区原始当量上限（字节）。超过时像内存存储那样按最早写入淘汰并回报。
	const cap = opts.cap > 0 ? opts.cap : 0
	const order = []
	const disk = new Map()
	let evictFn = null
	const st = {
		reads: 0,
		gate: null,
		readGate: null,
		clearGate: null,
		disk,
		events: [],
		init: async () => {},
		getBackend: () => 'memory',
		onEvict: (fn) => { evictFn = fn },
		getDiskUsed: () => { let n = 0; disk.forEach(function (v) { n += v.length * 4 }); return n },
		writeChunk: async (id, s) => {
			st.events.push('write:' + id)
			if (st.gate) await st.gate
			const evicted = []
			if (cap > 0) {
				let used = st.getDiskUsed()
				while (order.length && used + s.length * 4 > cap) {
					const old = order.shift()
					const v = disk.get(old)
					if (!v) continue
					disk.delete(old)
					used -= v.length * 4
					evicted.push({ id: old, rawBytes: v.length * 4 })
				}
			}
			disk.set(id, new Float32Array(s))
			order.push(id)
			if (evicted.length && evictFn) evictFn(evicted)
			return { byteSize: s.length * 4, rawBytes: s.length * 4, evicted: evicted }
		},
		readChunk: async (id) => { st.reads++; const buf = disk.get(id); if (st.readGate) await st.readGate; return buf },
		removeChunk: async (id) => { disk.delete(id) },
		clearSession: async () => { st.events.push('clear'); if (st.clearGate) await st.clearGate; disk.clear(); order.length = 0 },
	}
	return st
}

/**
 * @param {object} store 假冷存储
 * @param {object} [opts] { cap, rawBudgetBytes, metaBudgetBytes }
 */
function load(store, opts) {
	opts = opts || {}
	const logs = []
	let stops = 0
	const env = { voltageV: 3.3, samplePeriodSec: 1e-5 }
	const wave = Wave.createWave({
		store: store,
		chunkSize: CHUNK,
		envelopeStep: 1024,
		hydrateCacheMax: 24,
		ramCapSamples: opts.cap || CHUNK * 4,
		voltage: () => env.voltageV,
		samplePeriod: () => env.samplePeriodSec,
		log: (m) => logs.push(m),
		scheduleUI: () => {},
		onStorageStop: () => { stops++ },
		rawBudgetBytes: opts.rawBudgetBytes != null ? opts.rawBudgetBytes : Infinity,
		metaBudgetBytes: opts.metaBudgetBytes,
	})
	const T = {
		ringPush: wave.ringPush,
		ringReset: wave.ringReset,
		ringIAt: wave.ringIAt,
		findChunkAt: wave.findChunkAt,
		calcStats: wave.calcStats,
		getBucketEntry: wave.getBucketEntry,
		metadataChunkLimit: wave.metadataChunkLimit,
		chunks: wave.chunks,
		queue: wave.queue,
		bucketCache: wave.bucketCache,
		pruneBucketCache: wave.pruneBucketCache,
		cache: wave.cache,
		pending: wave.pending,
		state: wave.state,
		noteGap: wave.noteGap,
		gaps: wave.gaps,
		segments: wave.segments,
		setCap: wave.setRamCap,
		frameReset: wave.frameReset,
		env: env,
	}
	return { T, logs, stops: () => stops }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const wave = (i) => Math.sin((i % 65536) / 50) * 100 + 200
const deferred = () => {
	let resolve, reject
	const promise = new Promise((res, rej) => { resolve = res; reject = rej })
	return { promise, resolve, reject }
}
const settle = async () => { for (let k = 0; k < 5; k++) await tick() }

;(async function () {
	{
		const store = makeStore()
		const { T } = load(store)
		T.setCap(CHUNK * 4)
		// 按批到达(批间让出，归档才能写盘)，64 块里 60 块落冷区
		for (let c = 0; c < 64; c++) {
			for (let i = 0; i < CHUNK; i++) T.ringPush(wave(i))
			for (let k = 0; k < 5; k++) await tick()
		}
		for (let k = 0; k < 50; k++) await tick()
		assert.equal(T.chunks.filter((c) => c.state === 'cold').length, 60)
		const count = CHUNK * 60

		const frames = async function (bs, n) {
			const before = store.reads
			const out = []
			for (let f = 0; f < n; f++) {
				T.frameReset()
				for (let bi = 0; bi * bs < count; bi++) T.getBucketEntry(bi, bs, 0, count - 1)
				for (let k = 0; k < 5; k++) await tick()
				out.push(store.reads - before)
			}
			return out
		}
		// 桶不比包络组细：直接用包络，不读冷块
		assert.deepEqual(await frames(4096, 6), [0, 0, 0, 0, 0, 0], '宽视图不该回读冷块')
		let maxErr = 0
		for (let bi = 0; bi * 4096 < count; bi += 37) {
			const e = T.getBucketEntry(bi, 4096, 0, count - 1)
			let mn = Infinity, mx = -Infinity, sum = 0, sumSq = 0
			for (let i = bi * 4096; i < (bi + 1) * 4096; i++) {
				const v = Math.fround(wave(i))
				if (v < mn) mn = v
				if (v > mx) mx = v
				sum += v
				sumSq += v * v
			}
			maxErr = Math.max(maxErr, Math.abs(e.min - mn), Math.abs(e.max - mx))
			assert.equal(e.first, Math.fround(wave(bi * 4096)))
			assert.equal(e.last, Math.fround(wave((bi + 1) * 4096 - 1)))
			assert.ok(Math.abs(e.mean - sum / 4096) < 1e-8, '包络均值必须保留组统计')
			assert.ok(Math.abs(e.sd - Math.sqrt(sumSq / 4096 - (sum / 4096) ** 2)) < 1e-8, '包络标准差必须保留组统计')
		}
		assert.ok(maxErr < 1e-3, '包络 min/max 与原始数据偏差 ' + maxErr)
		// 桶比包络组细、横跨的冷块比回读缓存多：读满本帧额度后稳定，不再越读越多
		const fine = await frames(512, 8)
		assert.ok(fine[0] > 0, '细桶应回读一部分冷块')
		assert.deepEqual(fine.slice(1), fine.slice(1).map(() => fine[0]), '回读次数应在首帧后稳定: ' + fine.join(','))

		// 缓存命中的前半视口也必须占回读额度。仅后半有新桶时不能一批批挤出仍可见的块。
		const beforePan = store.reads
		const panReads = []
		for (let f = 0; f < 6; f++) {
			T.frameReset()
			for (let bi = 5 * CHUNK / 512; bi < 35 * CHUNK / 512; bi++) T.getBucketEntry(bi, 512, 0, count - 1)
			await settle()
			panReads.push(store.reads - beforePan)
		}
		assert.ok(panReads[0] > 0 && panReads[0] <= 5, '平移应只回读新进入额度的块')
		assert.ok(panReads.every((n) => n === panReads[0]), '部分桶命中缓存时回读也应稳定: ' + panReads)

		// 包络缓存只留视口附近
		T.bucketCache.size = 0
		T.bucketCache.map = null
		for (let start = 0; start + 1500 < count / 64; start += 300) {
			for (let bi = start; bi < start + 1500; bi++) T.getBucketEntry(bi, 64, 0, count - 1)
			T.pruneBucketCache(start, start + 1499)
		}
		assert.ok(T.bucketCache.map.size <= 1500 * 3 + 256 + 1500, '包络缓存应随视口裁剪，现有 ' + T.bucketCache.map.size)
	}

	{
		// 写盘卡住：队列到上限就停采，不能无限排队
		const store = makeStore()
		const { T, logs, stops } = load(store)
		T.setCap(CHUNK * 4)
		store.gate = new Promise(() => {})
		let pushed = 0
		for (let i = 0; i < CHUNK * 40; i++) { if (!T.ringPush(1)) break; pushed++ }
		const queued = T.state().archiveQueuedSamples
		assert.ok(queued <= 8 * CHUNK, '含正在写入的队列 ' + queued + ' 点超过上限')
		assert.equal(queued, (T.queue.length + 1) * CHUNK, '正在写入的缓冲也必须占预算')
		assert.ok(pushed < CHUNK * 40, '写盘卡住时应停采')
		assert.ok(logs.some((m) => /跟不上采集/.test(m)), '应记录停采原因')
		T.ringReset()
		T.ringPush(19)
		await tick()
		assert.equal(stops(), 0, '清空前排队的停采回调不能停止新采集')
	}

	for (const failOldWrite of [false, true]) {
		// 清空期间旧写盘成功/失败都不能改变新会话；清盘完成之前，新写盘不得开始。
		const store = makeStore()
		const { T, stops } = load(store)
		T.setCap(CHUNK * 2)
		const oldWrite = deferred()
		const clear = deferred()
		store.gate = oldWrite.promise
		store.clearGate = clear.promise
		for (let i = 0; i < CHUNK * 3; i++) T.ringPush(7)
		await settle()
		const oldId = T.chunks[0].id
		T.ringReset()
		for (let i = 0; i < CHUNK * 3; i++) T.ringPush(19)
		const newId = T.chunks[0].id
		assert.notEqual(newId, oldId, '清空后不能复用还在飞的块 ID')
		store.gate = null
		if (failOldWrite) oldWrite.reject(new Error('synthetic write failure'))
		else oldWrite.resolve()
		await settle()
		assert.deepEqual(store.events, ['write:' + oldId, 'clear'], '清盘未完成时新归档须等待')
		assert.equal(T.state().hotCount, CHUNK * 2)
		assert.equal(T.state().coldCount, CHUNK)
		assert.equal(T.state().storageStop, false)
		assert.equal(stops(), 0, '旧归档失败不能停止新采集')
		clear.resolve()
		await settle()
		assert.deepEqual([...store.disk.keys()], [newId], '旧归档不能残留在新冷区会话')
		assert.equal(store.disk.get(newId)[0], 19)
		assert.equal(T.state().archiveQueuedSamples, 0)
		assert.equal(T.ringIAt(CHUNK * 2), 19)
	}

	{
		const store = makeStore()
		const { T } = load(store)
		T.setCap(CHUNK * 2)
		for (let i = 0; i < CHUNK * 3; i++) T.ringPush(7)
		await settle()
		const oldId = T.chunks[0].id
		const read = deferred()
		store.readGate = read.promise
		T.ringIAt(0)
		assert.ok(T.pending.has(oldId))
		T.ringReset()
		T.ringPush(19)
		read.resolve()
		await settle()
		assert.equal(T.cache.size, 0, '清空前的回读不能重新填进缓存')
		assert.equal(T.pending.size, 0)
		assert.equal(T.ringIAt(0), 19)
	}

	{
		// 未满块归档产生不同块长；索引必须按 base 而非固定 CHUNK_SIZE 推断。
		const store = makeStore()
		const { T } = load(store)
		T.setCap(31)
		for (let k = 0; k < 4; k++) {
			for (let i = 0; i < 31; i++) T.ringPush(k * 100 + i)
			await settle()
		}
		for (const i of [0, 30, 31, 61, 62, 92, 93, 123]) {
			const loc = T.findChunkAt(i)
			assert.equal(loc.index, Math.floor(i / 31))
			assert.equal(loc.off, i % 31)
		}
		assert.equal(T.findChunkAt(124), null)
		assert.equal(T.calcStats(93, 124).avgI, 315)
		const env = T.getBucketEntry(0, 16, 0, 123)
		assert.equal(env.min, 0)
		assert.equal(env.max, 30, '未回读的小桶应保留组包络极值')
		await settle()
		T.frameReset()
		const precise = T.getBucketEntry(0, 16, 0, 123)
		assert.equal(precise.max, 15, '回读后应替换近似包络')
	}

	{
		const { T, logs } = load(makeStore())
		const limit = T.metadataChunkLimit()
		assert.ok(limit > 0, '块索引上限应大于 0：' + limit)
		// 不填充数十亿样点：注入合成冷块描述符以模拟长期高压缩率录制。
		for (let i = 0; i < limit; i++) T.chunks.push({ id: 'synthetic-' + i, state: 'cold', n: CHUNK, base: i * CHUNK })
		assert.equal(T.ringPush(1), false)
		assert.equal(T.chunks.length, limit, '元数据到顶后不能继续追加')
		assert.equal(T.state().storageStop, true)
		assert.match(logs.at(-1), /索引.*已有数据保留/)
		T.ringReset()
		assert.equal(T.ringPush(2), true, '清空后可重新录制')
	}

	{
		// 缺口：时长按连续段累加（不跨缺口），能量与时长同口径
		const { T } = load(makeStore(), { cap: CHUNK })
		const env = T.env
		env.samplePeriodSec = 1
		for (let i = 0; i < 10; i++) T.ringPush(100)
		const before = T.calcStats(0, T.state().totalCount)
		assert.equal(before.dur, 9, '10 个样点 9 个间隔')
		assert.equal(before.gaps, 0)
		assert.deepEqual(T.segments(0, 10), [[0, 10]])

		// 第 10 个点之前断开：合并成两段，缺口那个间隔不计入时长
		T.noteGap(10)
		for (let i = 0; i < 10; i++) T.ringPush(100)
		const after = T.calcStats(0, T.state().totalCount)
		assert.equal(T.state().totalCount, 20)
		assert.equal(after.n, 20)
		assert.equal(after.gaps, 1)
		assert.equal(after.dur, 18, '缺口切开的两个 9 间隔段，不能算成 19')
		assert.deepEqual(T.segments(0, 20), [[0, 10], [10, 20]])
		// 能量与时长同口径：avgP(330) * 18 / 3600
		assert.ok(Math.abs(after.energyUWh - (330 * 18) / 3600) < 1e-9, '能量不跨缺口：' + after.energyUWh)
		// 只取缺口之后那一段
		const seg = T.calcStats(10, 20)
		assert.equal(seg.dur, 9)
		assert.equal(seg.gaps, 0, '区间内没有缺口时 gaps 为 0')
		assert.equal(seg.n, 10)
		// 清空后缺口也清掉
		T.ringReset()
		T.ringPush(1)
		T.ringPush(1)
		const fresh = T.calcStats(0, 2)
		assert.equal(fresh.gaps, 0)
		assert.equal(fresh.dur, 1)
	}

	{
		// 缺口切段后：单个孤立高电流点不该凭空产生电量 / 能量
		const { T } = load(makeStore(), { cap: CHUNK })
		const env = T.env
		env.samplePeriodSec = 1
		T.ringPush(1000)          // 段 1：[0,1)，只有一个点 → 没有有效间隔
		T.noteGap(1)
		T.ringPush(0)             // 段 2：[1,3)，三点 0 µA
		T.ringPush(0)
		T.ringPush(0)
		const st = T.calcStats(0, T.state().totalCount)
		assert.equal(st.n, 4)
		assert.equal(st.dur, 2, '段 1 没有间隔，段 2 有两个：' + st.dur)
		assert.ok(Math.abs(st.chargeUC - 0) < 1e-12, '孤立点不产生电量：' + st.chargeUC)
		assert.ok(Math.abs(st.energyUWh - 0) < 1e-12, '孤立点不产生能量：' + st.energyUWh)
		// 同样的数据如果**没有**缺口：段内 3 个间隔，均值 250 µA → 电量 750
		const { T: T2 } = load(makeStore(), { cap: CHUNK })
		T2.env.samplePeriodSec = 1
		T2.ringPush(1000)
		T2.ringPush(0)
		T2.ringPush(0)
		T2.ringPush(0)
		const st2 = T2.calcStats(0, 4)
		assert.equal(st2.dur, 3)
		assert.ok(Math.abs(st2.chargeUC - 250 * 3) < 1e-9, '连续段内才按均值积分：' + st2.chargeUC)
	}

	{
		// 被淘汰（dropped）的块不贡献时长，也不参与能量；retained 只是数量
		// 冷区上限只够 2 块：写第 3 块时最早那块被淘汰
		const store = makeStore({ cap: CHUNK * 4 * 2 })
		const { T } = load(store, { cap: CHUNK })
		T.env.samplePeriodSec = 1
		for (let c = 0; c < 6; c++) {
			for (let i = 0; i < CHUNK; i++) T.ringPush(100)
			await settle()
		}
		const st0 = T.state()
		assert.ok(st0.droppedSamples > 0, '应有块被淘汰：' + JSON.stringify(st0))
		const st = T.calcStats(0, st0.totalCount)
		assert.equal(st.n, st0.totalCount - st0.droppedSamples, '统计只覆盖还在的样点')
		assert.ok(st.dropped >= st0.droppedSamples, '统计里也要报出淘汰的点数')
		// 时长 = 只剩的连续段的间隔数（严格小于「总点数 - 1」）
		assert.ok(st.dur <= (st0.totalCount - st0.droppedSamples - 1) * 1 + 1e-9,
			'淘汰的样点不能贡献时长：dur=' + st.dur + ' total=' + st0.totalCount + ' dropped=' + st0.droppedSamples)
		assert.ok(st.dur < (st0.totalCount - 1), '时长必须小于整段时间轴')
		// retained 是数量而不是下标：用错会漏掉最新数据
		assert.equal(T.state().totalCount - T.state().droppedSamples, st0.totalCount - st0.droppedSamples)
		const latest = T.calcStats(st0.totalCount - 10, st0.totalCount)
		assert.ok(latest.n > 0, '最新样点仍然在统计范围里（不能把 retained 当结束下标）')
	}

	{
		// 电压是历史口径：块内改了源电压，统计按当时的电压加权，不跟当前设置
		const store = makeStore()
		const { T } = load(store, { cap: CHUNK * 2 })
		const env = T.env
		env.samplePeriodSec = 1
		env.voltageV = 3.3
		for (let i = 0; i < 4; i++) T.ringPush(1000)
		env.voltageV = 1.65
		for (let i = 0; i < 4; i++) T.ringPush(1000)
		const st = T.calcStats(0, 8)
		// 有效电压 = 加权平均 = (4·3.3 + 4·1.65)/8 = 2.475 V
		assert.ok(Math.abs(st.volts - 2.475) < 1e-9, '有效电压应按历史加权：' + st.volts)
		const before = st.energyUWh
		env.voltageV = 5
		const st2 = T.calcStats(0, 8)
		assert.ok(Math.abs(st2.energyUWh - before) < 1e-12, '改当前电压不能改写历史能量')
	}

	console.log('power-wave-store: ok')
})().catch(function (e) { console.error(e); process.exit(1) })
