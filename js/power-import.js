// CSV 导入：把（本插件导出的或同形状的）CSV 读成一条可分析的会话。
// 只在本地解析用户选的文件，不发网络请求；解析结果交给 control.importSeries 灌进波形。
//
// 支持的形状：
//  1. 本插件导出的格式：表头 index,time_s,current_uA,power_uW[,voltage_mV]，含 "# gap ..." 标记行；
//  2. 无表头的 2~5 列数字：index,time_s,current_uA[,power_uW[,voltage_mV]]；
//  3. 只有 time_s 与 current_uA 两列（第一列被当成时间，若首列单调递增且步长恒定）。
// 不猜单位：电流按 µA、时间按 s、电压按 mV（导出时就是这些单位）。
;(function (global) {
	'use strict'
	const I18N = global.PowerI18n || (typeof require === 'function' ? require('./power-i18n.js') : null)
	const tr = I18N.t

	const MAX_ROWS = 2000000

	function num(v) {
		// 空单元格（未知电压 / 未知功率）必须是 null，不能被 Number('') 变成 0
		const s = String(v == null ? '' : v).trim()
		if (!s) return null
		const n = Number(s)
		return isFinite(n) ? n : null
	}

	/**
	 * @param {string} text
	 * @param {object} [opts] { maxRows }
	 * @returns {{ ok:boolean, reason?:string, rows:{index:number,timeSec:number,currentUA:number,powerUW:number|null,voltageMV:number|null}[],
	 *   gaps:number[], samplePeriodSec:number, volts:number|null, voltsMixed:boolean,
	 *   skipped:number, markers:number }}
	 */
	function parseCsv(text, opts) {
		opts = opts || {}
		const maxRows = opts.maxRows > 0 ? opts.maxRows : MAX_ROWS
		const out = {
			ok: false,
			rows: [],
			// 每一段连续的样点（gap 标记、倒序时间、时间突变都会断开）
			segments: [],
			gaps: [],
			samplePeriodSec: 0,
			volts: null,
			hasVoltage: false,
			voltsMixed: false,
			skipped: 0,
			timeJumps: 0,
			markers: 0,
			reason: '',
		}
		if (typeof text !== 'string' || !text.length) {
			out.reason = 'empty'
			return out
		}
		const lines = text.split(/\r?\n/)
		let header = null
		let pendingGap = false
		let dtSum = 0
		let dtN = 0
		// 只在**同一个连续段内**统计时间步长：跨 gap 的时间差不是采样周期
		let segFirstTime = null
		let segLastTime = null
		let segDtSum = 0
		let segDtN = 0
		let segStart = 0
		let voltNum = 0
		let voltDen = 0
		const closeSegment = function () {
			const end = out.rows.length
			if (end > segStart) out.segments.push({ start: segStart, end: end, dtSum: segDtSum, dtN: segDtN })
			segStart = end
			segFirstTime = null
			segLastTime = null
			segDtSum = 0
			segDtN = 0
		}
		const markGap = function () {
			// 缺口：下一个数据行起是新段，并记下缺口位置（行下标）
			if (out.rows.length && out.gaps[out.gaps.length - 1] !== out.rows.length) out.gaps.push(out.rows.length)
			pendingGap = true
			closeSegment()
		}
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i]
			if (!raw || !raw.trim()) continue
			const line = raw.trim()
			if (line.charAt(0) === '#') {
				out.markers++
				if (/gap/i.test(line)) markGap()
				continue
			}
			if (!header && /[a-z_]/i.test(line)) {
				const cols = line.split(',').map(function (s) { return s.trim().toLowerCase() })
				const find = function (names) {
					for (let k = 0; k < names.length; k++) {
						const idx = cols.indexOf(names[k])
						if (idx >= 0) return idx
					}
					return -1
				}
				header = {
					index: find(['index', 'i', 'n']),
					time: find(['time_s', 'time', 't_s', 'time_sec', 'time_ms']),
					current: find(['current_ua', 'current', 'i_ua', 'ua']),
					power: find(['power_uw', 'power', 'p_uw']),
					voltage: find(['voltage_mv', 'voltage', 'v_mv', 'mv']),
					timeIsMs: find(['time_ms']) >= 0,
				}
				if (header.current < 0) {
					out.reason = 'no_current_column'
					return out
				}
				continue
			}
			const cells = line.split(',')
			let index = null
			let timeSec = null
			let current = null
			let power = null
			let voltage = null
			if (header) {
				if (header.time >= 0) {
					const t = num(cells[header.time])
					timeSec = t == null ? null : (header.timeIsMs ? t / 1000 : t)
				}
				if (header.index >= 0) index = num(cells[header.index])
				current = num(cells[header.current])
				if (header.power >= 0) power = num(cells[header.power])
				if (header.voltage >= 0) voltage = num(cells[header.voltage])
			} else {
				const n = cells.length
				if (n >= 3) {
					index = num(cells[0])
					timeSec = num(cells[1])
					current = num(cells[2])
					if (n >= 4) power = num(cells[3])
					if (n >= 5) voltage = num(cells[4])
				} else if (n === 2) {
					timeSec = num(cells[0])
					current = num(cells[1])
				} else {
					current = num(cells[0])
				}
			}
			if (current == null) {
				out.skipped++
				continue
			}
			if (out.rows.length >= maxRows) {
				out.reason = 'too_many_rows'
				return out
			}
			// 时间列：倒序 / 不变 → 明确断开（不是同一段连续采样）
			if (timeSec != null && segLastTime != null) {
				const dt = timeSec - segLastTime
				if (!(dt > 0)) {
					out.timeJumps++
					markGap()
				} else if (segDtN > 0 && Math.abs(dt - segDtSum / segDtN) > Math.max(1e-12, (segDtSum / segDtN) * 0.5)) {
					// 步长突变（>50%）：也当成一段结束，避免把间隙摊进采样周期
					out.timeJumps++
					markGap()
				}
			}
			if (pendingGap) {
				pendingGap = false
				segStart = out.rows.length
			}
			if (index == null) index = out.rows.length
			out.rows.push({ index: index, timeSec: timeSec, currentUA: current, powerUW: power, voltageMV: voltage })
			if (voltage != null) {
				out.hasVoltage = true
				if (out.volts == null) out.volts = voltage
				else if (Math.abs(out.volts - voltage) > 1) out.voltsMixed = true
			}
			// 混合电压时按电流加权（power = i × v，可用功率反推每行电压）
			if (power != null && current) {
				voltNum += power * 1000
				voltDen += current
			}
			if (timeSec != null) {
				if (segFirstTime == null) segFirstTime = timeSec
				if (segLastTime != null) {
					const dt = timeSec - segLastTime
					if (dt > 0) {
						segDtSum += dt
						segDtN++
						dtSum += dt
						dtN++
					}
				}
				segLastTime = timeSec
			}
		}
		closeSegment()
		if (!out.rows.length) {
			out.reason = out.reason || 'no_rows'
			return out
		}
		// 采样周期：只取**段内**时间差的平均；没有时间列就由界面标注「按 1 kHz 估计」
		out.samplePeriodSec = dtN > 0 ? dtSum / dtN : 0
		out.estimatedPeriod = !(dtN > 0)
		if (out.voltsMixed && voltDen > 0) out.volts = voltNum / voltDen
		out.powerUsable = out.hasVoltage && out.volts != null && out.volts > 0
		out.ok = true
		return out
	}

	/** 解析结果的摘要（界面提示用） */
	function summarize(parsed) {
		if (!parsed || !parsed.ok) {
			const code = (parsed && parsed.reason) || 'unknown'
			const key = 'ui.reason_' + code
			return { text: tr('imp.failed', { why: I18N.has(key) ? tr(key) : code }), warn: true }
		}
		const dur = parsed.rows.length * (parsed.samplePeriodSec || 0)
		const parts = [
			tr('imp.rows', { n: parsed.rows.length }),
			parsed.samplePeriodSec > 0 ? (1 / parsed.samplePeriodSec).toFixed(0) + ' Hz' : tr('imp.no_time_column'),
			parsed.volts != null ? parsed.volts.toFixed(0) + ' mV' : tr('imp.no_voltage'),
		]
		if (parsed.gaps.length) parts.push(tr('imp.gap_markers', { n: parsed.gaps.length }))
		if (parsed.skipped) parts.push(tr('imp.rows_skipped', { n: parsed.skipped }))
		if (parsed.voltsMixed) parts.push(tr('imp.mixed_voltage'))
		if (!parsed.powerUsable) parts.push(tr('imp.energy_unavailable'))
		void dur
		return { text: parts.join(' · '), warn: !parsed.powerUsable }
	}

	const api = { parseCsv: parseCsv, summarize: summarize, MAX_ROWS: MAX_ROWS }
	global.PowerImport = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
