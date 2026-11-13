'use strict'
// 导出上限回归：宿主 app.saveFile 只有 8 MiB，超限必须拒绝并明确提示，
// 不允许静默截断（这是原 web-serial-debug 的导出路径没有的约束）。
const assert = require('node:assert/strict')
const E = require('../js/power-export.js')
const Wave = require('../js/power-wave.js')

const LIMIT = E.MAX_EXPORT_BYTES

;(async function () {
	// ---- 计划：刚好在上限内 → 允许；超一个字节 → 拒绝 ----
	{
		const maxRows = E.maxRowsFor(LIMIT)
		assert.ok(maxRows > 100000, '8 MiB 至少能放十几万行：' + maxRows)
		const okPlan = E.planExport({ kind: 'range', start: 0, end: maxRows })
		assert.equal(okPlan.ok, true)
		assert.ok(okPlan.estimatedBytes <= LIMIT)

		const bigPlan = E.planExport({ kind: 'range', start: 0, end: maxRows * 4 })
		assert.equal(bigPlan.ok, false)
		assert.equal(bigPlan.reason, 'too_large')
		assert.equal(bigPlan.maxSamples, maxRows)
		assert.match(bigPlan.message, /超过单次导出上限/)
		assert.deepEqual(bigPlan.suggestions, ['shorten_range', 'export_summary'])
	}

	// ---- 空区间 ----
	{
		const p = E.planExport({ kind: 'range', start: 10, end: 10 })
		assert.equal(p.ok, false)
		assert.equal(p.reason, 'empty')
	}

	// ---- 摘要永远允许 ----
	{
		const p = E.planExport({ kind: 'summary', totalSamples: 1e9 })
		assert.equal(p.ok, true)
		assert.equal(p.kind, 'summary')
	}

	// ---- 真实生成：超限时拒绝而不是截断（按真实数据判断） ----
	{
		const store = { init: async () => {}, getDiskUsed: () => 0, writeChunk: async () => ({ byteSize: 0 }), readChunk: async () => null, removeChunk: async () => {}, clearSession: async () => {} }
		const big = Wave.createWave({ store: store, chunkSize: 262144, ramCapSamples: 262144 * 2, voltage: () => 3.3, samplePeriod: () => 1e-5 })
		const n = 400000
		for (let i = 0; i < n; i++) big.push(1000)
		const r = await E.buildCsv(big, 0, n, { samplePeriodSec: 1e-5 })
		assert.equal(r.ok, false)
		assert.equal(r.code, 'too_large')
		assert.equal(r.text, undefined, '拒绝时必须没有半截内容')
		assert.match(r.message, /不会自动截断/)
	}

	// ---- 真实生成：小范围正常出 CSV，含表头、电压列与缺口标记 ----
	{
		const store = { init: async () => {}, getDiskUsed: () => 0, writeChunk: async () => ({ byteSize: 0 }), readChunk: async () => null, removeChunk: async () => {}, clearSession: async () => {} }
		const w = Wave.createWave({ store: store, chunkSize: 64, ramCapSamples: 64, voltage: () => 3.3, samplePeriod: () => 0.001 })
		for (let i = 0; i < 40; i++) w.push(1000 + i)
		w.noteGap(20)
		const r = await E.buildCsv(w, 0, w.total(), { samplePeriodSec: 0.001 })
		assert.equal(r.ok, true)
		const lines = r.text.split('\n').filter((l) => l.length)
		assert.equal(lines[0], 'index,time_s,current_uA,power_uW,voltage_mV')
		const gapLines = lines.filter((l) => l.indexOf('# gap') === 0)
		assert.equal(gapLines.length, 1, '缺口处要有标记行：' + JSON.stringify(gapLines))
		assert.equal(r.gaps, 1, '缺口要计数')
		assert.ok(lines.length >= 40 + 2, '每个样点一行（含缺口标记）')
		assert.ok(r.bytes <= LIMIT)
		assert.equal(lines[1], '0,0,1000,3300,3300', '首行是第 0 个样点，含采样时的电压')
		// 功率 = 电流 × 当时的电压
		const row = lines.find((l) => l.indexOf('1,0.001,') === 0)
		assert.ok(row, '第二行存在：' + lines[1])
		assert.equal(row, '1,0.001,1001,3303.3,3300')
	}

	// ---- 冷块先等回读；回读失败写 gap 行，不拿近似值 ----
	{
		const disk = new Map()
		const store = {
			init: async () => {}, getDiskUsed: () => 0,
			writeChunk: async (id, s) => { disk.set(id, new Float32Array(s)); return { byteSize: s.length * 4 } },
			readChunk: async (id) => {
				await new Promise(function (r) { setTimeout(r, 3) })
				const v = disk.get(id)
				if (!v) throw new Error('gone')
				return v
			},
			removeChunk: async (id) => { disk.delete(id) },
			clearSession: async () => { disk.clear() },
		}
		const w = Wave.createWave({ store: store, chunkSize: 64, ramCapSamples: 64, voltage: () => 3.3, samplePeriod: () => 0.001 })
		for (let i = 0; i < 128; i++) w.push(100 + i)
		await new Promise(function (r) { setTimeout(r, 40) })
		w.clearHydrateCache()
		const ok = await E.buildCsv(w, 0, w.total(), { samplePeriodSec: 0.001 })
		assert.equal(ok.ok, true)
		assert.equal(ok.missing, 0, '回读成功时没有 missing')
		const rows = ok.text.split('\n').filter((l) => /^\d+,/.test(l))
		assert.equal(rows.length, 128, '每个真实样点一行：' + rows.length)
		assert.ok(rows.some((l) => l.indexOf('0,0,100,') === 0), '老块回读后的真实值也在：' + rows[0])
		// 冷块消失：写 gap 行并计数
		disk.clear()
		w.clearHydrateCache()
		const bad = await E.buildCsv(w, 0, w.total(), { samplePeriodSec: 0.001 })
		assert.equal(bad.ok, true, '仍然是一份诚实的 CSV（标了 gap 行）')
		assert.ok(bad.missing > 0, '回读失败要报 missing：' + bad.missing)
		assert.ok(bad.text.indexOf('# gap missing') >= 0, 'CSV 里要有 missing 标记行')
	}

	// ---- 长度复核按最终文本（含 gap 行）：超限提前拒绝 ----
	{
		const store = { init: async () => {}, getDiskUsed: () => 0, writeChunk: async () => ({ byteSize: 0 }), readChunk: async () => null, removeChunk: async () => {}, clearSession: async () => {} }
		const w = Wave.createWave({ store: store, chunkSize: 65536, ramCapSamples: 65536, voltage: () => 3.3, samplePeriod: () => 0.001 })
		for (let i = 0; i < 300; i++) w.push(1000)
		// 人为把每行撑长：用一个很小的 limit 触发「最终文本超限」
		const limit = 2000
		const r = await E.buildCsv(w, 0, 300, { samplePeriodSec: 0.001, limitBytes: limit })
		assert.equal(r.ok, false, '最终文本超过 limit 必须拒绝')
		assert.equal(r.code, 'too_large')
		assert.equal(r.text, undefined)
		// 计划阶段估算通过、真实文本超限时也要拒绝（缺口行也算长度）
		const planOk = E.planExport({ kind: 'range', start: 0, end: 300, limitBytes: limit })
		if (planOk.ok) assert.equal(r.ok, false, '计划通过但真实超限时仍拒绝')
	}

	// ---- 块内混合电压：每行用该样点当时的电压 ----
	{
		const store = { init: async () => {}, getDiskUsed: () => 0, writeChunk: async () => ({ byteSize: 0 }), readChunk: async () => null, removeChunk: async () => {}, clearSession: async () => {} }
		let v = 3.3
		const w = Wave.createWave({ store: store, chunkSize: 1024, ramCapSamples: 1024, voltage: () => v, samplePeriod: () => 1 })
		for (let i = 0; i < 4; i++) w.push(1000)
		v = 1.65
		for (let i = 0; i < 4; i++) w.push(1000)
		const r = await E.buildCsv(w, 0, 8, { samplePeriodSec: 1 })
		assert.equal(r.ok, true)
		const rows = r.text.split('\n').filter((l) => /^\d+,/.test(l))
		assert.equal(rows.length, 8)
		// 前四行 3300 mV、功率 3300 µW；后四行 1650 mV、功率 1650 µW
		for (let i = 0; i < 4; i++) {
			assert.equal(rows[i], i + ',' + i + ',1000,3300,3300', '第 ' + i + ' 行：' + rows[i])
		}
		for (let i = 4; i < 8; i++) {
			assert.equal(rows[i], i + ',' + i + ',1000,1650,1650', '第 ' + i + ' 行：' + rows[i])
		}
		assert.equal(r.unknownVolts, 0)
	}

	// ---- 电压未知：能量列为空，不编数值 ----
	{
		const store = { init: async () => {}, getDiskUsed: () => 0, writeChunk: async () => ({ byteSize: 0 }), readChunk: async () => null, removeChunk: async () => {}, clearSession: async () => {} }
		const w = Wave.createWave({ store: store, chunkSize: 1024, ramCapSamples: 1024, voltage: () => 3.3, samplePeriod: () => 1 })
		w.push(1000, null)
		w.push(1000, null)
		const r = await E.buildCsv(w, 0, 2, { samplePeriodSec: 1 })
		assert.equal(r.ok, true)
		const rows = r.text.split('\n').filter((l) => /^\d+,/.test(l))
		assert.equal(rows[0], '0,0,1000,,', '电压未知时功率与电压列留空：' + rows[0])
		assert.equal(r.unknownVolts, 2, '要统计出多少样点电压未知')
	}

	// ---- 导出服务：超限时既不调 saveFile 也不写文件 ----
	{
		let saved = 0
		const fakeWave = { total: () => 4e6, iAt: () => 1, gaps: () => [] }
		const svc = E.createExportService({
			wave: fakeWave,
			control: { state: () => ({ voltageMv: 3300 }), getSamplePeriodSec: () => 1e-5, captureSummary: () => ({ ready: true, totalSamples: 4e6 }) },
			saveFile: async () => { saved++ },
		})
		const r = await svc.exportRange(0, 4e6)
		assert.equal(r.ok, false)
		assert.equal(r.code, 'too_large')
		assert.equal(saved, 0, '超限时不能调用 saveFile')
		// 摘要路径照常可导出
		const s = await svc.exportSummary()
		assert.equal(s.ok, true)
		assert.equal(saved, 1)
	}

	// ---- 文件名清洗 ----
	{
		assert.equal(E.sanitizeFileName('a/b:c.csv'), 'a_b_c.csv')
		assert.ok(E.sanitizeFileName('x'.repeat(300)).length <= 120)
	}

	console.log('power-export: ok')
})().catch((e) => { console.error(e); process.exit(1) })
