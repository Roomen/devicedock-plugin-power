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

	const MAX_ROWS = 2000000

	function num(v) {
		const n = Number(String(v).trim())
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
			gaps: [],
			samplePeriodSec: 0,
			volts: null,
			voltsMixed: false,
			skipped: 0,
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
		let firstTime = null
		let lastTime = null
		let dtSum = 0
		let dtN = 0
		let voltNum = 0
		let voltDen = 0
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i]
			if (!raw || !raw.trim()) continue
			const line = raw.trim()
			if (line.charAt(0) === '#') {
				// 缺口标记行：下一行数据开始是一个新段
				out.markers++
				if (/gap/i.test(line)) pendingGap = true
				continue
			}
			if (!header && /[a-z_]/i.test(line)) {
				// 表头：按名字定位列，认不出来就退回按位置
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
				// 无表头：按位置猜。3 列以上视为 index,time,current[,power[,voltage]]；
				// 2 列视为 time,current
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
			if (pendingGap) {
				out.gaps.push(out.rows.length)
				pendingGap = false
			}
			if (index == null) index = out.rows.length
			out.rows.push({ index: index, timeSec: timeSec, currentUA: current, powerUW: power, voltageMV: voltage })
			if (voltage != null) {
				if (out.volts == null) out.volts = voltage
				else if (Math.abs(out.volts - voltage) > 1) out.voltsMixed = true
			}
			// 混合电压时按电流加权（导出时 power = i × v，可用功率反推每行电压）
			if (power != null && current) {
				voltNum += power * 1000 // µW / µA = V → ×1000 = mV
				voltDen += current
			}
			if (timeSec != null) {
				if (firstTime == null) firstTime = timeSec
				if (lastTime != null) {
					const dt = timeSec - lastTime
					if (dt > 0) { dtSum += dt; dtN++ }
				}
				lastTime = timeSec
			}
		}
		if (!out.rows.length) {
			out.reason = out.reason || 'no_rows'
			return out
		}
		// 采样周期：取时间列的平均步长；没有时间列就按 1 kHz 估计（界面会标注）
		out.samplePeriodSec = dtN > 0 ? dtSum / dtN : 0
		out.estimatedPeriod = !(dtN > 0)
		if (out.voltsMixed && voltDen > 0) out.volts = voltNum / voltDen
		// 功率列可以用来校验电压（power ≈ i × v）：两者都缺时明确说能量不可用
		out.powerUsable = out.volts != null && out.volts > 0
		out.ok = true
		return out
	}

	/** 解析结果的摘要（界面提示用） */
	function summarize(parsed) {
		if (!parsed || !parsed.ok) return { text: '导入失败：' + ((parsed && parsed.reason) || 'unknown'), warn: true }
		const dur = parsed.rows.length * (parsed.samplePeriodSec || 0)
		const parts = [
			parsed.rows.length + ' rows',
			parsed.samplePeriodSec > 0 ? (1 / parsed.samplePeriodSec).toFixed(0) + ' Hz' : 'no time column',
			parsed.volts != null ? parsed.volts.toFixed(0) + ' mV' : 'no voltage',
		]
		if (parsed.gaps.length) parts.push(parsed.gaps.length + ' gap marker(s)')
		if (parsed.skipped) parts.push(parsed.skipped + ' row(s) skipped')
		if (parsed.voltsMixed) parts.push('mixed voltage (weighted)')
		if (!parsed.powerUsable) parts.push('energy unavailable')
		void dur
		return { text: parts.join(' · '), warn: !parsed.powerUsable }
	}

	const api = { parseCsv: parseCsv, summarize: summarize, MAX_ROWS: MAX_ROWS }
	global.PowerImport = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
