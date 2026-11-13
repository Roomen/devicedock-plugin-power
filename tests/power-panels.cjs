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

	// ---- 游标读数：时长 / 均值 / 能量不跨缺口 ----
	{
		const w = makeWave({ periodSec: 1 })
		for (let i = 0; i < 40; i++) w.push(1000)
		w.noteGap(20)
		for (let i = 0; i < 40; i++) w.push(1000)
		const m = P.measureCursors(w, 0, 79, { samplePeriodSec: 1 })
		assert.equal(m.ready, true)
		assert.equal(m.samples, 80)
		assert.equal(m.gaps, 1)
		assert.equal(m.segments, 2)
		assert.equal(m.wallSec, 79, '墙上时长 79 个间隔')
		assert.equal(m.durSec, 78, '缺口切掉 1 个间隔，绝不跨缺口累加')
		assert.ok(Math.abs(m.gapRatio - 1 / 79) < 1e-9, '缺口占比：' + m.gapRatio)
		assert.equal(m.avgI, 1000)
		assert.ok(Math.abs(m.chargeUC - 78000) < 1e-6, '电量 = 均值 × 连续时长：' + m.chargeUC)
		assert.ok(Math.abs(m.energyUWh - 3.3 * 78000 / 3600) < 1e-6, '能量同口径：' + m.energyUWh)
		// 只取缺口之后的段：没有缺口
		const seg2 = P.measureCursors(w, 20, 79, { samplePeriodSec: 1 })
		assert.equal(seg2.gaps, 0)
		assert.equal(seg2.durSec, 59)
		// 单点
		const one = P.measureCursors(w, 30, 30, { samplePeriodSec: 1 })
		assert.equal(one.durSec, 0)
		assert.equal(one.samples, 1)
		assert.equal(one.gaps, 0)
		// 越界
		assert.equal(P.measureCursors(w, -10, 5, { samplePeriodSec: 1 }).ready, false)
		assert.equal(P.measureCursors(w, null, 5, { samplePeriodSec: 1 }).ready, false)
	}

	// ---- 边沿 / 周期 / 占空比 ----
	{
		const w = makeWave({ periodSec: 0.001 })
		// 方波：周期 100 点，占空比 25%（高 25 点）
		for (let i = 0; i < 2000; i++) w.push((i % 100) < 25 ? 1000 : 50)
		const edge = P.measureEdges(w, 0, 1999, { samplePeriodSec: 0.001 })
		// 2000 点 / 周期 100 = 20 段；首点从低电平起跳，扫描从 a+1 开始，所以是 19 个上升沿
		assert.equal(edge.nRise, 19, '上升沿数量：' + edge.nRise)
		assert.equal(edge.nFall, 20)
		assert.ok(Math.abs(edge.periodSec - 0.1) < 1e-9, '周期 0.1 s：' + edge.periodSec)
		assert.ok(Math.abs(edge.freqHz - 10) < 1e-6, '频率 10 Hz：' + edge.freqHz)
		assert.ok(Math.abs(edge.duty - 0.25) < 1e-6, '占空比 25%：' + edge.duty)
		assert.ok(edge.thr > 50 && edge.thr < 1000, '默认阈值取 min/max 中点：' + edge.thr)
		// 恒定电流：没有沿
		const flat = makeWave()
		for (let i = 0; i < 500; i++) flat.push(7)
		const fe = P.measureEdges(flat, 0, 499, { samplePeriodSec: 0.001 })
		assert.equal(fe.nRise, 0)
		assert.equal(fe.periodSec, null)
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
		const w = makeWave({ chunkSize: 64, ramCap: 64, periodSec: 0.001 })
		for (let i = 0; i < 200; i++) w.push(500 + (i % 3))
		await new Promise(function (r) { setTimeout(r, 40) })
		w.clearHydrateCache()
		const m = P.measureCursors(w, 1, 198, { samplePeriodSec: 0.001 })
		assert.ok(m.ready)
		assert.equal(m.iA, null, '冷块未回读时端点电流必须是 null（不能拿 min/max 中点充数）')
		assert.equal(m.deltaI, null)
		assert.equal(m.volts > 0, true, '有效电压来自块内记录：' + m.volts)
		// 热块里的端点有真实值（ramCap=64：只有最后一个块还在热区）
		const last = w.total() - 1
		const hot = P.measureCursors(w, last - 3, last, { samplePeriodSec: 0.001 })
		assert.ok(hot.iA != null && hot.iB != null, '热块端点有真实值：' + hot.iA + ' / ' + hot.iB)
		assert.equal(typeof hot.iA, 'number')
		assert.equal(hot.deltaI != null, true)
	}

	console.log('power-panels: ok')
})().catch((e) => { console.error(e); process.exit(1) })
