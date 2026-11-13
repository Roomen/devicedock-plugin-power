'use strict'
// 分析面板纯计算回归（js/power-panels.js）：区间挑选、抽稀、游标读数（不跨缺口）、
// 边沿/周期测量、FFT 峰值、电池续航、周期叠画。
const assert = require('node:assert/strict')
const W = require('../js/power-wave.js')
const P = require('../js/power-panels.js')

function makeWave(opts) {
	opts = opts || {}
	const store = {
		init: async () => {},
		getDiskUsed: () => 0,
		writeChunk: async () => ({ byteSize: 0 }),
		readChunk: async () => null,
		removeChunk: async () => {},
		clearSession: async () => {},
	}
	const w = W.createWave({
		store: store,
		chunkSize: opts.chunkSize || 1024,
		ramCapSamples: opts.ramCap || 4096,
		voltage: () => opts.voltageV == null ? 3.3 : opts.voltageV,
		samplePeriod: () => opts.periodSec == null ? 0.001 : opts.periodSec,
	})
	return w
}

const tick = () => new Promise((r) => setTimeout(r, 0))

;(async function () {
	// ---- 区间挑选 ----
	{
		const total = 1000
		const sel = { a: 100, b: 200 }
		const vr = { start: 800, end: 999, count: 200 }
		assert.deepEqual(P.pickRange({ mode: 'auto', total, selection: sel, viewRange: vr }), { a: 100, b: 200, source: 'selection' })
		assert.deepEqual(P.pickRange({ mode: 'auto', total, selection: null, viewRange: vr }), { a: 800, b: 999, source: 'window' })
		assert.equal(P.pickRange({ mode: 'selection', total, selection: null, viewRange: vr }), null, 'selection 模式没有选择就是空的')
		assert.deepEqual(P.pickRange({ mode: 'window', total, selection: sel, viewRange: vr }), { a: 800, b: 999, source: 'window' })
		assert.equal(P.pickRange({ mode: 'window', total: 1, viewRange: vr }), null, '没有数据就没有区间')
		assert.equal(P.pickRange({ mode: 'selection', total, selection: { a: 50, b: 50 } }), null, '单点不算区间')
		// 反向选择自动排序、越界夹紧
		assert.deepEqual(P.pickRange({ mode: 'selection', total, selection: { a: 300, b: 150 } }), { a: 150, b: 300, source: 'selection' })
		assert.deepEqual(P.pickRange({ mode: 'selection', total, selection: { a: -5, b: 5000 } }), { a: 0, b: 999, source: 'selection' })
	}

	// ---- 抽稀（真实样点、按段） ----
	{
		const w = makeWave()
		for (let i = 0; i < 3000; i++) w.push(i)
		const ext = await P.extractSegmentsExact(w, 0, 2999, { maxPts: 100 })
		assert.equal(ext.segments.length, 1, '没有缺口时只有一段')
		assert.equal(ext.segments[0].step, 30, '3000 点抽到 100 → 步长 30')
		assert.equal(ext.segments[0].samples.length, 100)
		assert.equal(ext.segments[0].samples[0], 0)
		assert.equal(ext.segments[0].samples[1], 30)
		assert.equal(ext.nRaw, 3000)
		assert.equal(ext.missing, 0)
		const full = await P.extractSegmentsExact(w, 0, 2999, { maxPts: 10000 })
		assert.equal(full.segments[0].step, 1)
		assert.equal(full.segments[0].samples.length, 3000)
		// 缺口把区间切成两段：绝不拼成一段
		w.noteGap(1500)
		const split = await P.extractSegmentsExact(w, 0, 2999, { maxPts: 10000 })
		assert.equal(split.segments.length, 2, '缺口两侧是两段：' + split.segments.length)
		assert.equal(split.segments[0].hi, 1500)
		assert.equal(split.segments[1].lo, 1500)
		assert.equal(split.gaps, 1)
		assert.equal(split.segments[0].samples.length + split.segments[1].samples.length, 3000)
	}

	// ---- 冷块必须等回读；回读失败 / 已淘汰的区间记为不可用 ----
	{
		// 用真实的 wave + 假冷存储：先写满让它归档，再验证分析会等回读
		const disk = new Map()
		const store = {
			init: async () => {},
			getDiskUsed: () => 0,
			writeChunk: async (id, s) => { disk.set(id, new Float32Array(s)); return { byteSize: s.length * 4 } },
			readChunk: async (id) => {
				await new Promise(function (r) { setTimeout(r, 5) })
				const v = disk.get(id)
				if (!v) throw new Error('missing chunk')
				return v
			},
			removeChunk: async (id) => { disk.delete(id) },
			clearSession: async () => { disk.clear() },
		}
		const w = W.createWave({
			store: store, chunkSize: 64, ramCapSamples: 64,
			voltage: () => 3.3, samplePeriod: () => 0.001,
		})
		for (let i = 0; i < 256; i++) w.push(100 + (i % 7))
		await new Promise(function (r) { setTimeout(r, 60) })
		// 冷块已经不在缓存里：iAtExact 必须返回 null（不能造一个 (min+max)/2）
		w.clearHydrateCache()
		w.clearBucketCache()
		assert.ok(w.chunks.some((c) => c.state === 'cold'), '应有冷块：' + w.chunks.map((c) => c.state).join(','))
		const coldIdx = w.chunks.filter((c) => c.state === 'cold')[0].base + 1
		assert.equal(w.iAtExact(coldIdx), null, '未回读的冷块不能给"实测值"')
		// 分析会先等回读，拿到真实值
		const ext = await P.extractSegmentsExact(w, 0, w.total() - 1, { maxPts: 100000 })
		assert.equal(ext.missing, 0, '冷块回读成功：' + ext.missing)
		const vals = []
		for (const s of ext.segments) for (const v of s.samples) vals.push(v)
		assert.equal(vals.length, 256)
		for (let i = 0; i < 256; i++) assert.equal(vals[i], 100 + (i % 7), '第 ' + i + ' 个值必须是真实样点')
		// 冷块读不出来：记为 missing，不拿近似值顶替
		disk.clear()
		w.clearHydrateCache()
		w.clearBucketCache()
		const ext2 = await P.extractSegmentsExact(w, 0, w.total() - 1, { maxPts: 100000 })
		assert.ok(ext2.missing > 0, '读不出来的冷块要如实报 missing')
		assert.ok(ext2.unusable.some((u) => u.kind === 'missing'))
	}

	// ---- 游标读数（精确路径）：时长 / 均值 / 能量不跨缺口 ----
	{
		const w = makeWave({ periodSec: 1 })
		for (let i = 0; i < 40; i++) w.push(1000)
		w.noteGap(20)
		for (let i = 0; i < 40; i++) w.push(1000)
		const m = await P.measureCursorsExact(w, 0, 79, { samplePeriodSec: 1 })
		assert.equal(m.ready, true)
		assert.equal(m.complete, true)
		assert.equal(m.samples, 80)
		assert.equal(m.gaps, 1)
		assert.equal(m.segments, 2)
		assert.equal(m.wallSec, 79, '墙上时长 79 个间隔')
		assert.equal(m.durSec, 78, '缺口切掉 1 个间隔，绝不跨缺口累加')
		assert.ok(Math.abs(m.gapRatio - 1 / 79) < 1e-9, '缺口占比：' + m.gapRatio)
		assert.equal(m.avgI, 1000)
		assert.ok(Math.abs(m.chargeUC - 78000) < 1e-6, '电量按逐间隔积分：' + m.chargeUC)
		// 物理单位：1000 µA × 3.3 V × 78 s = 257400 µW·s → 71.5 µWh
		assert.ok(Math.abs(m.energyUWh - (1000 * 3.3 * 78) / 3600) < 1e-9, '能量 µW·s / 3600：' + m.energyUWh)
		// 只取缺口之后的段：没有缺口
		const seg2 = await P.measureCursorsExact(w, 20, 79, { samplePeriodSec: 1 })
		assert.equal(seg2.gaps, 0)
		assert.equal(seg2.durSec, 59)
		// 单点
		const one = await P.measureCursorsExact(w, 30, 30, { samplePeriodSec: 1 })
		assert.equal(one.durSec, 0)
		assert.equal(one.samples, 1)
		assert.equal(one.gaps, 0)
		// 越界
		assert.equal((await P.measureCursorsExact(w, -10, 5, { samplePeriodSec: 1 })).ready, false)
		assert.equal((await P.measureCursorsExact(w, null, 5, { samplePeriodSec: 1 })).ready, false)
	}

	// ---- 第 6 项剩余：游标必须等回读，冷块未回读时不能拿近似值 ----
	{
		const disk = new Map()
		const store = {
			init: async () => {}, getDiskUsed: () => 0,
			writeChunk: async (id, s) => { disk.set(id, new Float32Array(s)); return { byteSize: s.length * 4 } },
			readChunk: async (id) => {
				await new Promise(function (r) { setTimeout(r, 1) })
				const v = disk.get(id)
				if (!v) throw new Error('gone')
				return v
			},
			removeChunk: async (id) => { disk.delete(id) },
			clearSession: async () => { disk.clear() },
		}
		const w = W.createWave({ store: store, chunkSize: 8, ramCapSamples: 8, voltage: () => 3.3, samplePeriod: () => 1 })
		for (let i = 0; i < 120; i++) {
			w.push(1000)
			if ((i + 1) % 8 === 0) await new Promise(function (r) { setTimeout(r, 0) })
		}
		await new Promise(function (r) { setTimeout(r, 80) })
		w.clearHydrateCache()
		const m = await P.measureCursorsExact(w, 0, 119, { samplePeriodSec: 1 })
		// 全部 1000 µA、119 个间隔：电量 119000 µC（旧实现用 (min+max)/2 = 500 → 59500）
		assert.ok(Math.abs(m.chargeUC - 119000) < 1e-6, '游标电量必须来自真实样点：' + m.chargeUC)
		assert.ok(Math.abs(m.avgI - 1000) < 1e-9, '游标均值：' + m.avgI)
		assert.equal(m.complete, true)
		// 冷块读不到：显示不可用，不给近似值
		disk.clear()
		w.clearHydrateCache()
		const bad = await P.measureCursorsExact(w, 0, 119, { samplePeriodSec: 1 })
		assert.equal(bad.complete, false, '回读失败 → 不完整')
		assert.equal(bad.ready, false)
		assert.ok(bad.missing > 0)
	}

	// ---- N7：积分与块大小无关，且等于精确扫描（含非恒定电流） ----
	{
		const E = require('../js/power-export.js')
		const series = [10, 0, 0, 100]
		const results = []
		for (const chunkSize of [2, 4, 16]) {
			const w = W.createWave({ store: null, chunkSize: chunkSize, ramCapSamples: chunkSize * 4, voltage: () => 3.3, samplePeriod: () => 1 })
			for (let i = 0; i < series.length; i++) w.push(series[i])
			const st = w.calcStats(0, series.length)
			results.push({ chunkSize: chunkSize, charge: st.chargeUC, energy: st.energyUWh, dur: st.dur })
		}
		// 左端点：10(1s) + 0(1s) + 0(1s) = 10 µC
		assert.ok(Math.abs(results[0].charge - 10) < 1e-9, '块大小 2：' + results[0].charge)
		assert.ok(Math.abs(results[1].charge - 10) < 1e-9, '块大小 4：' + results[1].charge)
		assert.ok(Math.abs(results[2].charge - 10) < 1e-9, '块大小 16：' + results[2].charge)
		assert.ok(Math.abs(results[0].energy - (10 * 3.3) / 3600) < 1e-12, '能量 µWh：' + results[0].energy)
		// 精确扫描（分析包）必须给同样的数
		const w2 = W.createWave({ store: null, chunkSize: 2, ramCapSamples: 8, voltage: () => 3.3, samplePeriod: () => 1 })
		for (let i = 0; i < series.length; i++) w2.push(series[i])
		const pack = await P.buildPack({ wave: w2, range: { a: 0, b: 3, source: 'window' }, samplePeriodSec: 1 })
		assert.ok(Math.abs(pack.measure.chargeUC - 10) < 1e-9, '精确分析与摘要一致：' + pack.measure.chargeUC)
		assert.ok(Math.abs(pack.measure.energyUWh - (10 * 3.3) / 3600) < 1e-12, '精确分析能量：' + pack.measure.energyUWh)
		void E
	}

	// ---- N6：物理单位断言（1000 µA、3.3 V、1 s → 0.9166… µWh） ----
	{
		const w = makeWave({ periodSec: 1, voltageV: 3.3 })
		w.push(1000)
		w.push(1000)
		const pack = await P.buildPack({ wave: w, range: { a: 0, b: 1, source: 'window' }, samplePeriodSec: 1 })
		assert.ok(Math.abs(pack.measure.energyUWh - 3300 / 3600) < 1e-12,
			'1000 µA × 3.3 V × 1 s = 3300 µW·s = 0.916666… µWh，不能放大 3600 倍：' + pack.measure.energyUWh)
		assert.ok(Math.abs(pack.measure.energyUWh - 0.9166666666666666) < 1e-12)
		assert.ok(Math.abs(pack.measure.chargeUC - 1000) < 1e-9, '电量 1000 µC')
	}

	// ---- N8：FFT / 双电平 / 事件分析跨块累积整段，不能只取第一块 ----
	{
		const disk = new Map()
		const store = {
			init: async () => {}, getDiskUsed: () => 0,
			writeChunk: async (id, s) => { disk.set(id, new Float32Array(s)); return { byteSize: s.length * 4 } },
			readChunk: async (id) => {
				await new Promise(function (r) { setTimeout(r, 1) })
				const v = disk.get(id)
				if (!v) throw new Error('gone')
				return v
			},
			removeChunk: async (id) => { disk.delete(id) },
			clearSession: async () => { disk.clear() },
		}
		// 64 点方波（周期 32 点），块大小 16 → 4 块，第一块几乎全高电平
		const w = W.createWave({ store: store, chunkSize: 16, ramCapSamples: 16, voltage: () => 3.3, samplePeriod: () => 0.001 })
		const N = 64
		const vals = []
		for (let i = 0; i < N; i++) vals.push((i % 32) < 16 ? 3000 : 100)
		for (let i = 0; i < N; i++) {
			w.push(vals[i])
			if ((i + 1) % 16 === 0) await new Promise(function (r) { setTimeout(r, 0) })
		}
		await new Promise(function (r) { setTimeout(r, 60) })
		w.clearHydrateCache()
		const pack = await P.buildPack({
			wave: w, range: { a: 0, b: N - 1, source: 'window' },
			samplePeriodSec: 0.001, fft: true, cycles: true, segments: true,
		})
		// 双电平必须看到两侧（第一块是 100% 高电平，不能只取它）
		assert.ok(pack.levels.lowAvg != null && pack.levels.highAvg != null, '双电平要有两侧：' + JSON.stringify(pack.levels))
		assert.ok(pack.levels.duty != null && Math.abs(pack.levels.duty - 0.5) < 0.05, '占空比约 50%：' + pack.levels.duty)
		// FFT 必须在 1/0.032 = 31.25 Hz 附近有峰
		assert.ok(pack.fft && pack.fft.ok !== false, 'FFT 可用')
		assert.ok(pack.fft.peaks && pack.fft.peaks.length > 0, 'FFT 应有峰')
		assert.ok(Math.abs(pack.fft.peaks[0].freqHz - 31.25) < 5, '主峰在 31.25 Hz 附近：' + pack.fft.peaks[0].freqHz)
		// 事件分析覆盖整段（两个高电平段）
		assert.ok(pack.segmentList && pack.segmentList.length >= 2, '分段要覆盖整段：' + (pack.segmentList && pack.segmentList.length))
	}

	// ---- 沿位置与吸附 ----
	{
		const w = makeWave({ periodSec: 0.001 })
		for (let i = 0; i < 1000; i++) w.push((i % 100) < 50 ? 1000 : 100)
		const ed = P.findEdges(w, 0, 999, { samplePeriodSec: 0.001 })
		assert.ok(ed.rises.length >= 9, '找到上升沿：' + ed.rises.length)
		// 序列是「先高 50 点、再低 50 点」：上升沿在 100 的倍数上，下降沿在 50 的倍数上
		assert.equal(ed.rises[0] % 100, 0, '上升沿位置：' + ed.rises[0])
		assert.equal(ed.falls[0] % 100, 50, '下降沿位置：' + ed.falls[0])
		assert.ok(ed.thr > 100 && ed.thr < 1000)
		// 吸附：靠近上升沿 52 → 吸到 50
		const near1 = P.nearestEdge(w, 0, 999, 102, 6)
		assert.equal(near1.index, 100)
		assert.equal(near1.dist, 2)
		// 超出距离不吸
		assert.equal(P.nearestEdge(w, 0, 999, 25, 6), null, '离沿太远不吸附')
		// 距离内取最近的沿
		const near2 = P.nearestEdge(w, 0, 999, 470, 25)
		assert.ok(near2 && (near2.index === 450 || near2.index === 500), '取最近的沿：' + (near2 && near2.index))
	}

	// ---- 分析包：真实样点 + 分段边沿/FFT/叠画 + 电池 ----
	{
		const w = makeWave({ chunkSize: 65536, ramCap: 65536, periodSec: 0.001 })
		// 1 kHz 采样、10 Hz 方波
		for (let i = 0; i < 4000; i++) w.push((i % 100) < 50 ? 2000 : 200)
		const range = { a: 0, b: 3999, source: 'window' }
		const pack = await P.buildPack({ wave: w, range: range, samplePeriodSec: 0.001, voltageMv: 3300, capacityMah: 2000, fft: true, cycles: true, segments: true })
		assert.ok(pack, '包应能建出来')
		assert.equal(pack.source, 'window')
		assert.equal(pack.nRaw, 4000)
		assert.equal(pack.missing, 0, '热数据不需要回读')
		assert.ok(pack.basic.n > 0)
		assert.ok(pack.levels.lowAvg != null && pack.levels.highAvg != null, '双电平有两侧均值')
		assert.ok(pack.levels.highAvg > pack.levels.lowAvg)
		assert.ok(pack.qCycle > 0, '每周期电量：' + pack.qCycle)
		// 连续区间：FFT 可用，主峰在 10 Hz 附近
		assert.ok(pack.fft && pack.fft.ok !== false, 'FFT 应可用')
		const peaks = pack.fft.peaks || []
		assert.ok(peaks.length > 0, 'FFT 有峰')
		assert.ok(Math.abs(peaks[0].freqHz - 10) < 2, '主峰在 10 Hz 附近：' + peaks[0].freqHz)
		assert.equal(pack.fft.partial, false)
		// 电池
		assert.ok(pack.battery && pack.battery.ok, '电池估算可用')
		assert.ok(pack.battery.days > 0)
		// 叠画
		assert.ok(pack.cycles && pack.cycles.nCycles > 0, '叠画有周期')
		assert.ok(pack.cycles.cycles.length <= 32)
		assert.equal(pack.cycles.mean.length, pack.cycles.cycles[0].length, '均值曲线与周期等长')
		// 分段（Sleep/Active）
		assert.ok(pack.segmentList && pack.segmentList.length >= 2, '按阈值分段')
		// 能量取自波形统计（历史电压），不再被当前设置改写
		const pack2 = await P.buildPack({ wave: w, range: range, samplePeriodSec: 0.001, voltageMv: 5000 })
		assert.ok(Math.abs(pack2.measure.energyUWh - pack.measure.energyUWh) < 1e-9,
			'改当前电压不能改写历史能量：' + pack.measure.energyUWh + ' vs ' + pack2.measure.energyUWh)
		assert.ok(Math.abs(pack.measure.volts - 3.3) < 1e-6, '有效电压取波形记录：' + pack.measure.volts)
		// 不带可选面板时不白算
		const lean = await P.buildPack({ wave: w, range: range, samplePeriodSec: 0.001 })
		assert.equal(lean.fft, null)
		assert.equal(lean.cycles, null)
		assert.equal(lean.battery, null)
		assert.equal(await P.buildPack({ wave: null, range: range }), null)
	}

	// ---- 区间含缺口：FFT 拒绝、周期只在段内配对、时长/能量同口径 ----
	{
		const w = makeWave({ chunkSize: 65536, ramCap: 65536, periodSec: 0.001 })
		for (let i = 0; i < 2000; i++) w.push((i % 100) < 50 ? 2000 : 200)
		w.noteGap(1000)
		const pack = await P.buildPack({
			wave: w, range: { a: 0, b: 1999, source: 'selection' },
			samplePeriodSec: 0.001, voltageMv: 3300, fft: true, cycles: true, segments: true,
		})
		assert.equal(pack.segments, 2, '缺口把区间切成两段：' + pack.segments)
		assert.equal(pack.gaps, 1)
		// FFT 在不连续区间上拒绝计算
		assert.equal(pack.fft.ok, false)
		assert.equal(pack.fft.reason, 'discontinuous')
		// 边沿只在段内配对：周期仍是 100 点 = 0.1 s，不能把缺口算成一个「超长周期」
		assert.ok(pack.edges.nPeriod > 0, '段内仍有周期样本')
		assert.ok(Math.abs(pack.edges.periodSec - 0.1) < 1e-9, '周期不能被缺口拉长：' + pack.edges.periodSec)
		assert.ok(Math.abs(pack.edges.freqHz - 10) < 1e-6)
		// 叠画只取最长段
		assert.ok(pack.cycles && pack.cycles.nCycles > 0)
		assert.ok(pack.cycles.segmentHi <= 1000 || pack.cycles.segmentLo >= 1000, '叠画只用单段：' + pack.cycles.segmentLo + '..' + pack.cycles.segmentHi)
		// 允许显式只取最长段时，FFT 会算并标 partial
		const pack2 = await P.buildPack({
			wave: w, range: { a: 0, b: 1999, source: 'selection' },
			samplePeriodSec: 0.001, fft: true, fftLongestSegment: true,
		})
		assert.ok(pack2.fft && pack2.fft.ok !== false, '显式允许时只算最长段')
		assert.equal(pack2.fft.partial, true)
		// 时长与能量按段累加
		assert.equal(pack.measure.durSec, 1998 * 0.001, '两段各 999 个间隔：' + pack.measure.durSec)
	}

	// ---- 大区间：周期用 dp × per，不再重复乘抽稀步长 ----
	{
		const w = makeWave({ chunkSize: 262144, ramCap: 524288, periodSec: 0.001 })
		// 20 万个点、周期 100 点 → 跨度超过 EDGE_SEARCH_MAX(80000)，会抽稀
		const n = 200000
		for (let i = 0; i < n; i++) w.push((i % 100) < 50 ? 2000 : 200)
		const ed = P.measureEdges(w, 0, n - 1, { samplePeriodSec: 0.001 })
		assert.ok(ed.step > 1, '大区间应该抽稀：' + ed.step)
		assert.ok(Math.abs(ed.periodSec - 0.1) < 1e-6,
			'周期必须是 0.1 s（dp × per），不能乘抽稀步长：' + ed.periodSec)
		assert.ok(Math.abs(ed.freqHz - 10) < 1e-3, '频率 10 Hz：' + ed.freqHz)
	}

	// ---- 格式化口径一致 ----
	{
		assert.equal(P.fmtCurrent(0), '0 µA')
		assert.equal(P.fmtCurrent(1500), '1.500 mA')
		assert.equal(P.fmtCurrent(2e6), '2.000 A')
		assert.equal(P.fmtPower(3300), '3.30 mW')
		assert.equal(P.fmtCharge(1e6), '1.000 C')
		assert.equal(P.fmtEnergy(1e3), '1.000 mWh')
		assert.equal(P.fmtDuration(0), '0 s')
		assert.equal(P.fmtDuration(0.25), '250 ms')
		assert.equal(P.fmtDuration(90), '1 min 30 s')
		assert.equal(P.fmtFreq(1000), '1.000 kHz')
		assert.equal(P.fmtPercent(0.255), '25.5%')
		assert.equal(P.fmtCurrent(NaN), '--')
	}

	// ---- 游标读数：端点电流只用真值，拿不到就是 null ----
	{
		// 全部留在热区（没有冷块）：端点必须给出真值
		const w = makeWave({ chunkSize: 64, ramCap: 512, periodSec: 0.001 })
		for (let i = 0; i < 200; i++) w.push(500 + (i % 3))
		// 精确路径会先等回读，所以这里端点也有真值；读数必须来自真实样点
		const m = await P.measureCursorsExact(w, 0, 199, { samplePeriodSec: 0.001 })
		assert.equal(m.complete, true, '回读成功 → 完整')
		assert.ok(m.iA != null && m.iB != null, '回读后端点有真值')
		assert.equal(m.volts > 0, true, '有效电压来自块内记录：' + m.volts)
		// 热块里的端点有真实值（ramCap=64：只有最后一个块还在热区）
		const last = w.total() - 1
		const hot = await P.measureCursorsExact(w, last - 3, last, { samplePeriodSec: 0.001 })
		assert.ok(hot.iA != null && hot.iB != null, '热块端点有真实值：' + hot.iA + ' / ' + hot.iB)
		assert.equal(typeof hot.iA, 'number')
		assert.equal(hot.deltaI != null, true)
	}

	// ---- 第 6/7 项：超过回读缓存容量也不截断；边沿/电量都来自真实样点 ----
	{
		const disk = new Map()
		const store = {
			init: async () => {}, getDiskUsed: () => 0,
			writeChunk: async (id, s) => { disk.set(id, new Float32Array(s)); return { byteSize: s.length * 4 } },
			readChunk: async (id) => {
				await new Promise(function (r) { setTimeout(r, 1) })
				const v = disk.get(id)
				if (!v) throw new Error('gone')
				return v
			},
			removeChunk: async (id) => { disk.delete(id) },
			clearSession: async () => { disk.clear() },
		}
		// 40 块（16 点/块）远超默认回读缓存（24 块）；方波周期 20 点 → 期望 39 个上升沿
		const w = W.createWave({ store: store, chunkSize: 64, ramCapSamples: 64, voltage: () => 3.3, samplePeriod: () => 0.001 })
		// 40 块 × 64 点 = 2560 点，远超默认回读缓存（24 块）
		const N = 2560
		const vals = []
		for (let i = 0; i < N; i++) vals.push((i % 20) < 10 ? 3000 : 100)
		for (let i = 0; i < N; i++) {
			w.push(vals[i])
			// 逐块让出：归档队列有上限，同步灌满会触发「写盘跟不上」停采
			if ((i + 1) % 64 === 0) await new Promise(function (r) { setTimeout(r, 0) })
		}
		await new Promise(function (r) { setTimeout(r, 200) })
		w.clearHydrateCache()
		assert.ok(w.chunks.filter((c) => c.state === 'cold').length >= 30, '应大部分是冷块：' + w.chunks.filter((c) => c.state === 'cold').length)
		// 直接按数据算期望值，避免和实现用同一套逻辑
		let expectRise = 0
		for (let i = 1; i < N; i++) if (vals[i] >= 1550 && vals[i - 1] < 1550) expectRise++
		const pack = await P.buildPack({ wave: w, range: { a: 0, b: N - 1, source: 'window' }, samplePeriodSec: 0.001, fft: true, cycles: true, segments: true })
		assert.equal(pack.complete, true, '全部回读成功时分析必须完整')
		assert.equal(pack.missing, 0)
		assert.equal(pack.edges.nRise, expectRise, '上升沿数必须等于真实值（不能因缓存容量被截断）：' + pack.edges.nRise + ' vs ' + expectRise)
		assert.ok(Math.abs(pack.edges.periodSec - 0.02) < 1e-9, '周期 20 点 × 1 ms：' + pack.edges.periodSec)
		assert.ok(Math.abs(pack.measure.chargeUC - (function () {
			let q = 0
			for (let i = 0; i < N - 1; i++) q += vals[i] * 0.001
			return q
		})()) < 1e-9, '电量按真实样点积分：' + pack.measure.chargeUC)
		assert.ok(Math.abs(pack.measure.durSec - (N - 1) * 0.001) < 1e-12, '时长按真实样点：' + pack.measure.durSec)

		// 回读失败：整份分析必须报不完整，读数不能冒充完整区间
		disk.clear()
		w.clearHydrateCache()
		const bad = await P.buildPack({ wave: w, range: { a: 0, b: N - 1, source: 'window' }, samplePeriodSec: 0.001, fft: true })
		assert.equal(bad.complete, false, '回读失败 → 不完整')
		assert.ok(bad.missing > 0, '要报出多少个样点读不到：' + bad.missing)
		assert.equal(bad.incomplete, true)
		assert.equal(bad.measure.ready, false, '不完整时读数不能标记为 ready')
		assert.equal(bad.unavailableReason, 'samples_unavailable')
	}

	// ---- N13：分析必须给出平方和与 RMS ----
	{
		const w = makeWave({ periodSec: 1, voltageV: 3.3 })
		w.push(1000)
		w.push(1000)
		const pack = await P.buildPack({ wave: w, range: { a: 0, b: 1, source: 'window' }, samplePeriodSec: 1 })
		assert.equal(pack.basic.n, 2)
		assert.equal(pack.basic.rms, 1000, 'RMS 应为 1000 µA：' + pack.basic.rms)
		assert.equal(pack.basic.sumSq, 2000000, '平方和应为 2×1000²：' + pack.basic.sumSq)
		assert.equal(pack.basic.avg, 1000)
		// 非恒定电流也要对
		const w2 = makeWave({ periodSec: 1, voltageV: 3.3 })
		w2.push(0)
		w2.push(2000)
		const p2 = await P.buildPack({ wave: w2, range: { a: 0, b: 1, source: 'window' }, samplePeriodSec: 1 })
		assert.equal(p2.basic.sumSq, 4000000)
		assert.equal(p2.basic.rms, Math.sqrt(2000000))
	}

	// ---- N14：精确积分不依赖回读缓存还能容纳整段（40 块、chunkSize 16、ramCapSamples 16） ----
	{
		const disk = new Map()
		const store = {
			init: async () => {}, getDiskUsed: () => 0,
			writeChunk: async (id, s) => { disk.set(id, new Float32Array(s)); return { byteSize: s.length * 4 } },
			readChunk: async (id) => {
				await new Promise(function (r) { setTimeout(r, 0) })
				const v = disk.get(id)
				if (!v) throw new Error('gone')
				return new Float32Array(v) // 返回副本：证明回读值不依赖调用方缓存
			},
			removeChunk: async (id) => { disk.delete(id) },
			clearSession: async () => { disk.clear() },
		}
		const w = W.createWave({ store: store, chunkSize: 16, ramCapSamples: 16, voltage: () => 3.3, samplePeriod: () => 1 })
		// 40 块 × 16 点：每块前八点 1000 µA、后八点 0
		const N = 640
		for (let b = 0; b < 40; b++) {
			for (let k = 0; k < 16; k++) w.push(k < 8 ? 1000 : 0)
			await new Promise(function (r) { setTimeout(r, 0) })
		}
		await new Promise(function (r) { setTimeout(r, 120) })
		w.clearHydrateCache()
		assert.ok(w.chunks.filter((c) => c.state === 'cold').length >= 30, '应大部分是冷块：' + w.chunks.filter((c) => c.state === 'cold').length)
		// 范围 1..639（首尾都是部分块）：有效左端点 1..638
		let expectCharge = 0
		for (let li = 1; li <= 638; li++) {
			expectCharge += (li % 16) < 8 ? 1000 : 0
		}
		const pack = await P.buildPack({ wave: w, range: { a: 1, b: 639, source: 'selection' }, samplePeriodSec: 1 })
		assert.equal(pack.complete, true, '全部块都能回读 → 分析必须完整')
		assert.equal(pack.missing, 0)
		assert.ok(Math.abs(pack.measure.chargeUC - expectCharge) < 1e-6,
			'精确积分必须覆盖整段（' + expectCharge + ' µC）：' + pack.measure.chargeUC)
		assert.ok(Math.abs(pack.measure.chargeUC - 319000) < 1e-6, '应为 319000 µC：' + pack.measure.chargeUC)
		// 游标同样可用
		const m = await P.measureCursorsExact(w, 1, 639, { samplePeriodSec: 1 })
		assert.equal(m.ready, true, '游标 ready 必须为 true')
		assert.equal(m.complete, true)
		assert.ok(Math.abs(m.chargeUC - 319000) < 1e-6, '游标电量：' + m.chargeUC)
		assert.equal(m.missing, 0)
		// 块读不到时：必须标不完整，不能谎称完整
		disk.clear()
		w.clearHydrateCache()
		const bad = await P.buildPack({ wave: w, range: { a: 1, b: 639, source: 'selection' }, samplePeriodSec: 1 })
		assert.equal(bad.complete, false, '缺块 → 不完整')
		assert.equal(bad.measure.ready, false)
		assert.equal((await P.measureCursorsExact(w, 1, 639, { samplePeriodSec: 1 })).ready, false)
	}

	console.log('power-panels: ok')
})().catch((e) => { console.error(e); process.exit(1) })
