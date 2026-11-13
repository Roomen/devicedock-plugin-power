// 导出：宿主 app.saveFile 有 8 MiB 上限，插件自己也按同一上限把关。
// 超限时只允许「选中的时间段」或「摘要」，并明确告诉用户能导出多少 —— 绝不静默截断。
;(function (global) {
	'use strict'

	// 与宿主 js/plugin-rpc.js 的 LIMITS.maxExportChars 对齐（按字符数计，UTF-8 下 CSV 全是 ASCII）
	const MAX_EXPORT_BYTES = 8 * 1024 * 1024
	const CSV_HEADER = 'index,time_s,current_uA,power_uW\n'
	// 估算每个样点的固定开销：下标 + 逗号 + 时间 + 电流 + 功率 + 换行
	const BYTES_PER_ROW_ESTIMATE = 44

	function estimateCsvBytes(n) {
		const rows = Math.max(0, n | 0)
		return CSV_HEADER.length + rows * BYTES_PER_ROW_ESTIMATE
	}

	function maxRowsFor(limitBytes) {
		const limit = limitBytes > 0 ? limitBytes : MAX_EXPORT_BYTES
		return Math.max(0, Math.floor((limit - CSV_HEADER.length) / BYTES_PER_ROW_ESTIMATE))
	}

	/**
	 * 决定这次导出能不能做。
	 * @param {object} req { kind:'range'|'summary', start, end, totalSamples, limitBytes }
	 * @returns {{ ok:boolean, kind:string, limitBytes:number, requestedSamples:number,
	 *            estimatedBytes:number, maxSamples:number, reason?:string, message?:string,
	 *            suggestions?:string[] }}
	 */
	function planExport(req) {
		req = req || {}
		const limit = req.limitBytes > 0 ? Math.floor(req.limitBytes) : MAX_EXPORT_BYTES
		const maxSamples = maxRowsFor(limit)
		const kind = req.kind === 'summary' ? 'summary' : 'range'
		if (kind === 'summary') {
			return {
				ok: true,
				kind: kind,
				limitBytes: limit,
				requestedSamples: 0,
				estimatedBytes: 1024,
				maxSamples: maxSamples,
			}
		}
		const start = Math.max(0, req.start | 0)
		const end = Math.max(start, req.end | 0)
		const n = end - start
		const estimate = estimateCsvBytes(n)
		if (n <= 0) {
			return {
				ok: false, kind: kind, limitBytes: limit, requestedSamples: 0, estimatedBytes: estimate,
				maxSamples: maxSamples, reason: 'empty',
				message: '所选时间段里没有样点',
			}
		}
		if (estimate > limit) {
			const allowedSec = maxSamples > 0 ? maxSamples : 0
			return {
				ok: false, kind: kind, limitBytes: limit, requestedSamples: n, estimatedBytes: estimate,
				maxSamples: maxSamples, reason: 'too_large',
				message: '所选时间段约 ' + formatBytes(estimate) + '，超过单次导出上限 ' + formatBytes(limit) +
					'（约 ' + allowedSec + ' 个样点）。请缩短时间段，或只导出摘要；不会自动截断。',
				suggestions: ['shorten_range', 'export_summary'],
			}
		}
		return {
			ok: true, kind: kind, limitBytes: limit, requestedSamples: n, estimatedBytes: estimate,
			maxSamples: maxSamples,
		}
	}

	function formatBytes(n) {
		const a = Math.abs(n)
		if (a >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MiB'
		if (a >= 1024) return (n / 1024).toFixed(1) + ' KiB'
		return n + ' B'
	}

	function num(v) {
		return isFinite(v) ? (Math.round(v * 1000) / 1000).toString() : ''
	}

	/**
	 * 生成 CSV。只在计划通过后调用；真实长度超限时回 too_large（不截断）。
	 * @param {object} wave power-wave（iAt / total / gaps）
	 * @param {number} start 起始下标（含）
	 * @param {number} end 结束下标（不含）
	 * @param {object} ctx { voltageMv, samplePeriodSec, limitBytes }
	 */
	function buildCsv(wave, start, end, ctx) {
		ctx = ctx || {}
		const limit = ctx.limitBytes > 0 ? ctx.limitBytes : MAX_EXPORT_BYTES
		const plan = planExport({ kind: 'range', start: start, end: end, limitBytes: limit })
		if (!plan.ok) return { ok: false, code: plan.reason, message: plan.message, plan: plan }
		const per = ctx.samplePeriodSec > 0 ? ctx.samplePeriodSec : 0
		const volts = ctx.voltageMv != null ? ctx.voltageMv / 1000 : 0
		const gaps = typeof wave.gaps === 'function' ? wave.gaps() : []
		let ga = 0
		const parts = [CSV_HEADER]
		let size = CSV_HEADER.length
		for (let li = start; li < end; li++) {
			// 缺口处插标记行：消费方据此知道这段时间不连续，不会把它当成连续的能流
			while (ga < gaps.length && gaps[ga] < li) ga++
			if (ga < gaps.length && gaps[ga] === li) parts.push('# gap\n')
			const v = wave.iAt(li)
			const row = li + ',' + num((li - start) * per) + ',' + num(v) + ',' + num(v * volts) + '\n'
			parts.push(row)
			size += row.length
			if (size > limit) {
				return {
					ok: false, code: 'too_large',
					message: '导出内容超过 ' + formatBytes(limit) + '，已取消本次导出（不截断）。请缩短时间段或只导出摘要。',
					plan: plan,
				}
			}
		}
		return { ok: true, text: parts.join(''), bytes: size, plan: plan }
	}

	/** 摘要导出（JSON）：含缺口数与口径，便于归档 */
	function buildSummary(summary, extra) {
		const payload = Object.assign({
			format: 'devicedock-power-summary',
			version: 1,
			generatedAt: new Date().toISOString(),
			gapNote: '缺口处的时间与能量不计入统计',
		}, summary || {}, extra || {})
		return { ok: true, text: JSON.stringify(payload, null, 2) }
	}

	function sanitizeFileName(name) {
		return String(name || 'power-export.csv').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
	}

	/**
	 * @param {object} cfg { wave, control, saveFile(opts), log }
	 */
	function createExportService(cfg) {
		cfg = cfg || {}
		const wave = cfg.wave
		const control = cfg.control
		const saveFile = cfg.saveFile
		const log = typeof cfg.log === 'function' ? cfg.log : function () {}

		async function exportRange(start, end, opts) {
			opts = opts || {}
			const total = wave ? wave.total() : 0
			const s = Math.max(0, Math.min(total, start | 0))
			const e = Math.max(s, Math.min(total, end == null ? total : end | 0))
			const plan = planExport({ kind: 'range', start: s, end: e, limitBytes: MAX_EXPORT_BYTES })
			if (!plan.ok) return { ok: false, code: plan.reason, message: plan.message, plan: plan }
			const st = control ? control.state() : {}
			const csv = buildCsv(wave, s, e, {
				voltageMv: st.voltageMv,
				samplePeriodSec: control ? control.getSamplePeriodSec() : 0,
				limitBytes: MAX_EXPORT_BYTES,
			})
			if (!csv.ok) return csv
			const name = sanitizeFileName(opts.name || ('power-samples-' + s + '-' + e + '.csv'))
			try {
				await saveFile({ name: name, mime: 'text/csv;charset=utf-8', text: csv.text })
			} catch (err) {
				return { ok: false, code: (err && err.code) || 'save_failed', message: '保存文件失败：' + (err && err.message ? err.message : err) }
			}
			log('已导出 ' + name + '（' + formatBytes(csv.bytes) + '）', 'success')
			return { ok: true, name: name, bytes: csv.bytes, samples: e - s }
		}

		async function exportSummary(opts) {
			opts = opts || {}
			if (!control) return { ok: false, code: 'no_control', message: '还没有可导出的采样摘要' }
			const summary = control.captureSummary()
			const built = buildSummary(summary, { gaps: summary.gaps, note: summary.reason })
			const name = sanitizeFileName(opts.name || 'power-summary.json')
			try {
				await saveFile({ name: name, mime: 'application/json;charset=utf-8', text: built.text })
			} catch (err) {
				return { ok: false, code: (err && err.code) || 'save_failed', message: '保存文件失败：' + (err && err.message ? err.message : err) }
			}
			return { ok: true, name: name, bytes: built.text.length, summary: summary }
		}

		return {
			maxExportBytes: MAX_EXPORT_BYTES,
			plan: planExport,
			estimateCsvBytes: estimateCsvBytes,
			maxRowsFor: maxRowsFor,
			buildCsv: buildCsv,
			exportRange: exportRange,
			exportSummary: exportSummary,
		}
	}

	const api = {
		MAX_EXPORT_BYTES: MAX_EXPORT_BYTES,
		CSV_HEADER: CSV_HEADER,
		estimateCsvBytes: estimateCsvBytes,
		maxRowsFor: maxRowsFor,
		planExport: planExport,
		buildCsv: buildCsv,
		buildSummary: buildSummary,
		formatBytes: formatBytes,
		sanitizeFileName: sanitizeFileName,
		createExportService: createExportService,
	}
	global.PowerExport = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
