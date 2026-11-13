// 导出：宿主 app.saveFile 有 8 MiB 上限，插件自己也按同一上限把关。
// 超限时只允许「选中的时间段」或「摘要」，并明确告诉用户能导出多少 —— 绝不静默截断。
;(function (global) {
	'use strict'
	const I18N = global.PowerI18n || (typeof require === 'function' ? require('./power-i18n.js') : null)
	const tr = I18N.t
	const msg = I18N.msg

	// 与宿主 js/plugin-rpc.js 的 LIMITS.maxExportChars 对齐（按字符数计，UTF-8 下 CSV 全是 ASCII）
	const MAX_EXPORT_BYTES = 8 * 1024 * 1024
	const CSV_HEADER = 'index,time_s,current_uA,power_uW,voltage_mV\n'
	// 估算每个样点的固定开销：下标 + 逗号 + 时间 + 电流 + 功率 + 换行
	// 每行固定开销的保守估计（下标 + 时间 + 电流 + 功率 + 电压 + 换行）
	const BYTES_PER_ROW_ESTIMATE = 56

	// 每条缺口标记行的保守开销（"# gap <kind> <lo>..<hi>"）
	const BYTES_PER_GAP_MARKER = 48

	function estimateCsvBytes(n, gapMarkers) {
		const rows = Math.max(0, n | 0)
		const gaps = Math.max(0, gapMarkers | 0)
		return CSV_HEADER.length + rows * BYTES_PER_ROW_ESTIMATE + gaps * BYTES_PER_GAP_MARKER
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
		const estimate = estimateCsvBytes(n, req.gapMarkers)
		if (n <= 0) {
			return {
				ok: false, kind: kind, limitBytes: limit, requestedSamples: 0, estimatedBytes: estimate,
				maxSamples: maxSamples, reason: 'empty',
				message: tr('exp.empty'), ref: msg('exp.empty'),
			}
		}
		if (estimate > limit) {
			const allowedSec = maxSamples > 0 ? maxSamples : 0
			return {
				ok: false, kind: kind, limitBytes: limit, requestedSamples: n, estimatedBytes: estimate,
				maxSamples: maxSamples, reason: 'too_large',
				message: tr('exp.too_large_estimate', { size: formatBytes(estimate), limit: formatBytes(limit), n: allowedSec }), ref: msg('exp.too_large_estimate', { size: formatBytes(estimate), limit: formatBytes(limit), n: allowedSec }),
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
	 * 生成 CSV：**只写真实样点**，缺口 / 已淘汰 / 回读失败的区间写 \`# gap\` 标记行并计数。
	 *
	 * - 冷块先 await 回读（wave.walkExact），拿不到就标 gap，绝不用块级近似值冒充实测；
	 * - 功率用**采样当时**的源电压（按块记录的 volts），不随界面当前设置改写；
	 * - 最终文本长度复核（含 gap 行）：超限直接拒绝，不静默截断。
	 *
	 * @param {object} wave
	 * @param {number} start 起始下标（含）
	 * @param {number} end 结束下标（不含）
	 * @param {object} ctx { samplePeriodSec, limitBytes }
	 * @returns {Promise<{ ok:boolean, text?:string, bytes?:number, gaps?:number, missing?:number,
	 *   dropped?:number, code?:string, message?:string, plan?:object }>}
	 */
	async function buildCsv(wave, start, end, ctx) {
		ctx = ctx || {}
		const limit = ctx.limitBytes > 0 ? ctx.limitBytes : MAX_EXPORT_BYTES
		// 估算时把缺口标记也计进去（否则估算通过、最终超限只能靠最后一处兜底）
		const gapMarkers = (wave && typeof wave.gaps === 'function' ? wave.gaps().length : 0) +
			(wave && typeof wave.droppedRanges === 'function' ? wave.droppedRanges().length : 0)
		const plan = planExport({ kind: 'range', start: start, end: end, limitBytes: limit, gapMarkers: gapMarkers })
		if (!plan.ok) return { ok: false, code: plan.reason, message: plan.message, plan: plan }
		const per = ctx.samplePeriodSec > 0 ? ctx.samplePeriodSec : 0
		const parts = [CSV_HEADER]
		let size = CSV_HEADER.length
		let gaps = 0
		let missing = 0
		let dropped = 0
		let unknownVolts = 0
		const t0 = plan.requestedSamples
		const push = function (text) {
			parts.push(text)
			size += text.length
		}
		const walk = await wave.walkExact(start, end, function (ev) {
			if (ev.kind !== 'samples') {
				// 缺口 / 淘汰 / 回读失败：写标记行（消费方据此知道这段不连续，不会当成连续能流）
				if (ev.kind === 'gap') gaps++
				else if (ev.kind === 'dropped') dropped += ev.hi - ev.lo
				else missing += ev.hi - ev.lo
				push('# gap ' + ev.kind + ' ' + ev.lo + '..' + ev.hi + '\n')
				return
			}
			// 每一行用该样点**当时**的源电压（块内可以分段）；电压未知就留空列，功率也不编
			const volts = ev.volts == null ? null : ev.volts
			const vals = ev.values
			let buf = ''
			for (let k = 0; k < vals.length; k++) {
				const li = ev.lo + k
				const v = vals[k]
				if (!isFinite(v)) continue
				const powerCol = volts == null ? '' : num(v * volts)
				const voltCol = volts == null ? '' : num(volts * 1000)
				buf += li + ',' + num((li - start) * per) + ',' + num(v) + ',' + powerCol + ',' + voltCol + '\n'
			}
			push(buf)
			if (volts == null) unknownVolts += ev.hi - ev.lo
		})
		if (walk && walk.aborted) {
			// 导出期间会话被清空 / 重新采集 / 导入：前后数据不属于同一次采集，整份作废
			return {
				ok: false, code: 'session_changed',
				message: tr('exp.session_changed'), ref: msg('exp.session_changed'),
				plan: plan,
			}
		}
		// 长度复核：按**最终文本**（含 gap 行）判断，而不是按估算
		if (size > limit) {
			return {
				ok: false, code: 'too_large',
				message: tr('exp.too_large', { size: formatBytes(size), limit: formatBytes(limit) }), ref: msg('exp.too_large', { size: formatBytes(size), limit: formatBytes(limit) }),
				plan: plan,
			}
		}
		return {
			ok: true, text: parts.join(''), bytes: size, plan: plan,
			gaps: gaps, missing: missing, dropped: dropped, samples: t0,
			unknownVolts: unknownVolts,
		}
	}

	/** 摘要导出（JSON）：含缺口数与口径，便于归档 */
	function buildSummary(summary, extra) {
		const payload = Object.assign({
			format: 'devicedock-power-summary',
			version: 1,
			generatedAt: new Date().toISOString(),
			gapNote: tr('exp.gap_note'),
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
			const csv = await buildCsv(wave, s, e, {
				samplePeriodSec: control ? control.getSamplePeriodSec() : 0,
				limitBytes: MAX_EXPORT_BYTES,
			})
			if (!csv.ok) return csv
			const name = sanitizeFileName(opts.name || ('power-samples-' + s + '-' + e + '.csv'))
			try {
				await saveFile({ name: name, mime: 'text/csv;charset=utf-8', text: csv.text })
			} catch (err) {
				return { ok: false, code: (err && err.code) || 'save_failed', message: tr('exp.save_failed', { err: err && err.message ? err.message : err }), ref: msg('exp.save_failed', { err: err && err.message ? err.message : err }) }
			}
			log(msg('exp.exported', { name: name, size: formatBytes(csv.bytes), gaps: csv.gaps ? tr('exp.exported_gaps', { n: csv.gaps }) : '' }), 'success')
			return { ok: true, name: name, bytes: csv.bytes, samples: e - s, gaps: csv.gaps, missing: csv.missing, dropped: csv.dropped }
		}

		async function exportSummary(opts) {
			opts = opts || {}
			if (!control) return { ok: false, code: 'no_control', message: tr('exp.no_summary'), ref: msg('exp.no_summary') }
			const summary = control.captureSummary()
			const built = buildSummary(summary, { gaps: summary.gaps, note: summary.reason })
			const name = sanitizeFileName(opts.name || 'power-summary.json')
			try {
				await saveFile({ name: name, mime: 'application/json;charset=utf-8', text: built.text })
			} catch (err) {
				return { ok: false, code: (err && err.code) || 'save_failed', message: tr('exp.save_failed', { err: err && err.message ? err.message : err }), ref: msg('exp.save_failed', { err: err && err.message ? err.message : err }) }
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
