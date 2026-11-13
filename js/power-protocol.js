;// 功耗仪串口协议核心（纯逻辑，无 DOM）：4 字节样点流解码、档位换算、主机重采样与总览折叠。
// 设备只发字节流、没有帧边界，所以 SampleParser 自己保留半帧并按需重同步相位。
;(function (global) {
	'use strict'

	const NOMINAL_BASE_HZ = 100000
	const ADC_MULT = 1.8 / 163840
	const SAMPLE_BYTES = 4
	const VDD_LOW_MV = 500
	const VDD_HIGH_MV = 5000

	const CMD = {
		NO_OP: 0x00,
		TRIGGER_SET: 0x01,
		AVG_NUM_SET: 0x02,
		AVERAGE_START: 0x06,
		AVERAGE_STOP: 0x07,
		RANGE_SET: 0x08,
		DEVICE_RUNNING_SET: 0x0C,
		REGULATOR_SET: 0x0D,
		SET_POWER_MODE: 0x11,
		SPIKE_FILTERING_ON: 0x15,
		SPIKE_FILTERING_OFF: 0x16,
		GET_META_DATA: 0x19,
		RESET: 0x20,
	}

	const MODE = {
		AMPERE: 'AMPERE',
		SOURCE: 'SOURCE',
	}

	// 14-bit ADC @0, 3-bit range @14, 8-bit logic @24（与 Python MEAS_* 一致）
	const MASK_ADC = 0x3fff
	const MASK_RANGE = 0x7
	const POS_RANGE = 14
	const MASK_LOGIC = 0xff
	const POS_LOGIC = 24
	const MAX_RANGE = 5
	// 相位判定：bit17~31（保留位 + logic）里在流开头保持不变的那些位，加上 range<=5。
	// 不写死「保留位恒 0」——厂商 Python API 只定义了 ADC/RANGE/LOGIC，没说 bit17~23
	// 一定是 0（PPK2 同位置放的是滚动计数器），写死会让重同步在真机上永远不触发。
	const LEARN_MASK = 0xfffe0000 >>> 0
	const LEARN_WORDS = 512
	const LEARN_MIN_BITS = 6
	// 实测本设备 bit18~23 是每样点 +1 的 6 bit 滚动计数器，bit17 恒 0、logic 恒 0xFF。
	// 位置写死但运行时校验：学习期对不上就不用，不会把别的固件判死。
	const POS_COUNTER = 18
	const MASK_COUNTER = 0x3f
	const COUNTER_MOD = MASK_COUNTER + 1
	// 重同步确认样点数：连续 K 个合法字才认新相位，避免误锁
	const RESYNC_CONFIRM = 8
	// 连续丢弃上限：超过就认为判据不可信，退回原样放行，避免把整段波形丢空
	const DROP_LIMIT = 64

	function popcount32(v) {
		let n = 0
		while (v) { v &= v - 1; n++ }
		return n
	}

	// 与 the vendor app 的 modifiers.r 一致（开源 PPK2 只有 5 档且末档是 0.043，不要拿来对）
	const DEFAULT_R = {
		'0': 1031.64, '1': 101.65, '2': 10.15,
		'3': 0.94, '4': 0.099, '5': 0.009,
	}

	function packBytes(bytes) {
		return new Uint8Array(bytes)
	}

	function cmdMeta() {
		return packBytes([CMD.GET_META_DATA])
	}

	function cmdAverageStart() {
		return packBytes([CMD.AVERAGE_START])
	}

	function cmdAverageStop() {
		return packBytes([CMD.AVERAGE_STOP])
	}

	function cmdRegulatorSet(mV) {
		mV = Math.max(VDD_LOW_MV, Math.min(VDD_HIGH_MV, mV | 0))
		const hi = (mV >> 8) & 0xff
		const lo = mV & 0xff
		return packBytes([CMD.REGULATOR_SET, hi, lo])
	}

	function cmdDutPower(on) {
		return packBytes([CMD.DEVICE_RUNNING_SET, on ? CMD.TRIGGER_SET : CMD.NO_OP])
	}

	// 示例默认不调 SET_POWER_MODE；保留命令常量，需要时再发
	function cmdSourceMode() {
		return packBytes([CMD.SET_POWER_MODE, CMD.AVG_NUM_SET])
	}

	function cmdAmpereMode() {
		return packBytes([CMD.SET_POWER_MODE, CMD.TRIGGER_SET])
	}

	function defaultModifiers() {
		const ones = function () {
			return { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 }
		}
		const zeros = function () {
			return { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
		}
		return {
			Calibrated: null,
			R: Object.assign({}, DEFAULT_R),
			GS: ones(),
			GI: ones(),
			O: zeros(),
			S: zeros(),
			I: zeros(),
			UG: ones(),
			HW: null,
			IA: null,
			deviceSn: '',
			savedVddMv: 0,
			rawText: '',
		}
	}

	function parseMetadata(text) {
		const mod = defaultModifiers()
		if (!text || typeof text !== 'string') return mod
		mod.rawText = text
		const lines = text.split(/\r?\n/)
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].replace(/=/g, ':')
			const idx = line.indexOf(':')
			if (idx < 0) continue
			const k = line.slice(0, idx).trim()
			const v = line.slice(idx + 1).trim()
			if (!k) continue
			if (k === 'Calibrated' || k === 'HW' || k === 'IA') {
				mod[k] = v
				continue
			}
			// 若固件 metadata 带序列号字段
			if (/^(SN|SERIAL|SERIAL_NUMBER|SERIALNUMBER|DEVICE_ID|BOARD_ID)$/i.test(k) && v) {
				mod.deviceSn = v
				continue
			}
			const m = /^(R|GS|GI|O|S|I|UG)([0-5])$/.exec(k)
			if (m) {
				const key = m[1]
				const ind = m[2]
				const num = parseFloat(v)
				if (!isFinite(num)) continue
				if (key === 'R') {
					if (num !== 0) mod.R[ind] = num
				} else {
					mod[key][ind] = num
				}
				continue
			}
			if (/^VDD/i.test(k)) {
				const digits = v.replace(/\D/g, '')
				if (digits) {
					const mv = parseInt(digits, 10)
					if (isFinite(mv) && mv > 0) mod.savedVddMv = mv
				}
			}
		}
		return mod
	}

	// ---- 档位切换 spike 滤波 + 电流换算（对照 Python get_adc_result / _handle_raw_data）----
	function Converter(modifiers) {
		this.modifiers = modifiers || defaultModifiers()
		this.adcMult = ADC_MULT
		this.rollingAvg = null
		this.rollingAvg4 = null
		this.prevRange = null
		this.consecutiveRangeSamples = 0
		this.spikeFilterAlpha = 0.18
		this.spikeFilterAlpha5 = 0.06
		this.spikeFilterSamples = 3
		this.afterSpike = 0
	}

	Converter.prototype.setModifiers = function (mod) {
		this.modifiers = mod || defaultModifiers()
		this.resetFilter()
	}

	Converter.prototype.resetFilter = function () {
		this.rollingAvg = null
		this.rollingAvg4 = null
		this.prevRange = null
		this.consecutiveRangeSamples = 0
		this.afterSpike = 0
	}

	/**
	 * 对照厂商上位机 the vendor app（Electron，source map 里的 src/device/serialDevice.ts）：
	 * 电流只取 (adc - O) * adcMult / R，到此为止。
	 * metadata 里的 GS/GI/S/I/UG 是 Nordic 开源版 pc-nrfconnect-ppk 才用的二次增益修正，
	 * the vendor app 明确写成 `let adc = resultWithoutGain;`——不要照搬开源版，那会让读数偏高约 5%。
	 */
	Converter.prototype.getAdcResult = function (rangeIdx, adcValue) {
		const r = String(rangeIdx)
		const O = this.modifiers.O[r] || 0
		const R = this.modifiers.R[r]
		if (!R || R === 0) return 0
		let adc = (adcValue - O) * (this.adcMult / R)

		const prevRolling = this.rollingAvg
		const prevRolling4 = this.rollingAvg4

		if (this.rollingAvg == null) this.rollingAvg = adc
		else this.rollingAvg = this.spikeFilterAlpha * adc + (1 - this.spikeFilterAlpha) * this.rollingAvg

		if (this.rollingAvg4 == null) this.rollingAvg4 = adc
		else this.rollingAvg4 = this.spikeFilterAlpha5 * adc + (1 - this.spikeFilterAlpha5) * this.rollingAvg4

		if (this.prevRange == null) this.prevRange = r

		if (this.prevRange !== r || this.afterSpike > 0) {
			if (this.prevRange !== r) {
				this.consecutiveRangeSamples = 0
				this.afterSpike = this.spikeFilterSamples
			} else {
				this.consecutiveRangeSamples++
			}
			if (r === '5') {
				if (this.consecutiveRangeSamples < 2) {
					this.rollingAvg = prevRolling
					this.rollingAvg4 = prevRolling4
				}
				adc = this.rollingAvg4
			} else {
				adc = this.rollingAvg
			}
			this.afterSpike--
		}
		this.prevRange = r
		return adc
	}

	/** raw uint32 → { iUA, range, logic }；iUA 单位 µA */
	Converter.prototype.handleRaw = function (rawU32) {
		const range = Math.min((rawU32 >> POS_RANGE) & MASK_RANGE, 5)
		const adc = (rawU32 & MASK_ADC) * 4
		const logic = (rawU32 >> POS_LOGIC) & MASK_LOGIC
		const amps = this.getAdcResult(range, adc)
		return {
			iUA: amps * 1e6,
			range: range,
			logic: logic,
		}
	}

	// ---- 流式 4 字节拆包（带相位重同步）----
	function SampleParser(converter) {
		this.converter = converter || new Converter()
		this.remainder = new Uint8Array(0)
		// 统计：丢字节数 / 重同步次数 / 放行的非法字数，供 UI 诊断
		this.resyncCount = 0
		this.droppedBytes = 0
		this.badSamples = 0
		// 上一次 push 尾部留下的断点（下一个 segment 要带着它进队列）
		this.pendingBreak = null
		this._learnReset()
	}

	SampleParser.prototype._learnReset = function () {
		this.learnLeft = LEARN_WORDS
		this.learnOr = 0
		this.learnAnd = 0xffffffff >>> 0
		this.lockMask = 0
		this.lockVal = 0
		this.counterHits = 0
		this.counterPairs = 0
		this.counterOk = false
		this.lastCounter = -1
		this.lostSamples = 0
	}

	SampleParser.prototype.reset = function () {
		this.remainder = new Uint8Array(0)
		this.converter.resetFilter()
		this.pendingBreak = null
		this._learnReset()
	}

	/** 流开头按对齐假设统计恒定位，学完得出相位判定掩码 */
	SampleParser.prototype._learn = function (raw) {
		this.learnOr |= raw
		this.learnAnd &= raw
		// 计数器判定按「多数步进为 +1」，不能要求全中：真丢样点时本来就会跳，
		// 而丢得越狠越需要这个计数器来报丢点数。
		const c = (raw >>> POS_COUNTER) & MASK_COUNTER
		if (this.lastCounter >= 0) {
			this.counterPairs++
			if (c === ((this.lastCounter + 1) & MASK_COUNTER)) this.counterHits++
		}
		this.lastCounter = c
		if (--this.learnLeft > 0) return
		this.counterOk = this.counterPairs > 0 &&
			this.counterHits / this.counterPairs >= 0.5
		const mask = (~(this.learnOr ^ this.learnAnd) & LEARN_MASK) >>> 0
		if (popcount32(mask) < LEARN_MIN_BITS) {
			// 恒定位太少，判据不可靠：不做重同步，保持原有行为
			this.lockMask = 0
			return
		}
		this.lockMask = mask
		this.lockVal = (this.learnAnd & mask) >>> 0
	}

	SampleParser.prototype.resetStats = function () {
		this.resyncCount = 0
		this.droppedBytes = 0
		this.badSamples = 0
	}

	function rawAt(data, off) {
		return (
			data[off] |
			(data[off + 1] << 8) |
			(data[off + 2] << 16) |
			(data[off + 3] << 24)
		) >>> 0
	}

	/**
	 * 单字判据：学到的恒定位对得上，且 range<=5。
	 * 这里刻意不查计数器——真丢样点时相位其实是好的，查了只会白试三种偏移。
	 */
	SampleParser.prototype._looksValid = function (raw) {
		if (((raw & this.lockMask) >>> 0) !== this.lockVal) return false
		return ((raw >>> POS_RANGE) & MASK_RANGE) <= MAX_RANGE
	}

	/** 从 off 起需要 need 个连续合法字；认新相位时才连计数器一起查，锁得更死 */
	SampleParser.prototype._phaseLocks = function (data, off, n, need) {
		let prev = -1
		for (let k = 0; k < need; k++) {
			const o = off + k * SAMPLE_BYTES
			if (o + SAMPLE_BYTES > n) return false
			const raw = rawAt(data, o)
			if (!this._looksValid(raw)) return false
			if (this.counterOk) {
				const c = (raw >>> POS_COUNTER) & MASK_COUNTER
				if (prev >= 0 && c !== ((prev + 1) & MASK_COUNTER)) return false
				prev = c
			}
		}
		return true
	}

	/**
	 * 计数器跳变 = 真丢样点（区别于相位错位）。跨度 >64 会少算，只作量级参考。
	 * @returns {number} 本点之前丢掉的样点数（0 表示连续）
	 */
	SampleParser.prototype._countLoss = function (raw) {
		const c = (raw >>> POS_COUNTER) & MASK_COUNTER
		let lost = 0
		if (this.lastCounter >= 0) {
			const step = (c - this.lastCounter + COUNTER_MOD) % COUNTER_MOD
			if (step !== 1) {
				lost = (step - 1 + COUNTER_MOD) % COUNTER_MOD
				this.lostSamples += lost
			}
		}
		this.lastCounter = c
		return lost
	}

	/**
	 * 流式解码：把一个字节块解析成若干**连续样点段**，段与段之间是断点。
	 *
	 * 断点来源：设备侧计数器跳变（真丢样点）、相位重同步时丢掉的字节、以及判据不可信时
	 * 丢弃的坏字。调用方必须按段入队、在段之间插入缺口；绝不能把相邻两段接起来算，
	 * 也不能把一次 push 的结果当成一整段（一次 read 里本来就可能既有坏字节也有好数据）。
	 *
	 * 缺的字节数记在 droppedBytes，丢的样点估数记在 lostSamples（都是累计统计）。
	 *
	 * @param {Uint8Array} buf
	 * @returns {{ segments: { samples: object[], breakBefore: object|null }[] }}
	 *   breakBefore: null 表示这一段与上一段连续（流开头也算连续）；
	 *   否则 { reason: 'sample_loss'|'resync'|'bad_sample', missedSamples, bytes, badSamples }。
	 */
	SampleParser.prototype.push = function (buf) {
		const segments = []
		let cur = []
		// 上一次调用尾部留下的断点：下一个 segment 必须带着它
		let curBreak = this.pendingBreak || null
		this.pendingBreak = null

		function addMissed(target, k) {
			if (!(k > 0)) return target
			if (!target) return { reason: 'sample_loss', missedSamples: k, bytes: 0, badSamples: 0 }
			target.missedSamples += k
			return target
		}
		function addBytes(target, k) {
			if (!(k > 0)) return target
			if (!target) return { reason: 'resync', missedSamples: 0, bytes: k, badSamples: 0 }
			target.bytes += k
			return target
		}
		function addBad(target, k) {
			if (!(k > 0)) return target
			if (!target) return { reason: 'bad_sample', missedSamples: 0, bytes: 0, badSamples: k }
			target.badSamples += k
			return target
		}

		if (!buf || !buf.length) {
			if (curBreak) this.pendingBreak = curBreak
			return { segments: segments }
		}
		let data
		if (this.remainder.length) {
			data = new Uint8Array(this.remainder.length + buf.length)
			data.set(this.remainder)
			data.set(buf, this.remainder.length)
		} else {
			data = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
		}
		const self = this
		// 断点出现时先把当前段封口；如果这一段还没有样点，断点留到下一段（合并计数）
		function cut(next) {
			if (cur.length) {
				segments.push({ samples: cur, breakBefore: curBreak })
				cur = []
				curBreak = next || null
			} else {
				curBreak = curBreak ? mergeBreak(curBreak, next) : (next || null)
			}
		}
		let off = 0
		const n = data.length
		// 重同步至少要能校验 RESYNC_CONFIRM 个字加上 3 字节相位偏移
		const probeNeed = RESYNC_CONFIRM * SAMPLE_BYTES + SAMPLE_BYTES - 1
		// 熔断：本批连续找不回相位就别再逐点试三种偏移，也不再丢点
		let probeFails = 0
		while (off + SAMPLE_BYTES <= n) {
			let raw = rawAt(data, off)
			if (self.learnLeft > 0) {
				self._learn(raw)
				cur.push(self.converter.handleRaw(raw))
				off += SAMPLE_BYTES
				continue
			}
			if (self.lockMask && !self._looksValid(raw)) {
				// 设备/驱动丢字节会让 4 字节相位永久错位，且 range 被 clamp 成 5 后
				// 看着像几十安的锯齿。这里试 1/2/3 字节偏移找回相位。
				let fixed = false
				let shiftUsed = 0
				if (n - off >= probeNeed && probeFails < DROP_LIMIT) {
					for (let shift = 1; shift < SAMPLE_BYTES; shift++) {
						if (self._phaseLocks(data, off + shift, n, RESYNC_CONFIRM)) {
							off += shift
							self.droppedBytes += shift
							self.resyncCount++
							shiftUsed = shift
							// 错位期间的样点已经污染了档位切换滤波的滑动均值，不清会继续外溢
							self.converter.resetFilter()
							// 错位期读到的计数器来自坏相位，据此算丢点是噪声，跳过一个间隔
							self.lastCounter = -1
							raw = rawAt(data, off)
							fixed = true
							break
						}
					}
				}
				if (fixed) {
					probeFails = 0
					// 丢掉的字节 = 数据结构上的断点：前后样点不属于同一连续区间
					cut(addBytes(null, shiftUsed))
				} else {
					probeFails++
					self.badSamples++
					// 锁不上就整点丢掉，不要把坏字当电流画出去——用户看到的几十安
					// 尖峰就是这么来的。丢一个点远好过在波形上凭空造一个 49 A。
					// 但连续丢太多说明判据本身可能就是错的，那就退回原样放行。
					if (probeFails < DROP_LIMIT) {
						cut(addBad(null, 1))
						off += SAMPLE_BYTES
						continue
					}
				}
			}
			if (self.counterOk) {
				// 计数器跳变 = 真丢样点（区别于相位错位）：这里必须断开
				const lost = self._countLoss(raw)
				if (lost > 0) cut(addMissed(null, lost))
			}
			cur.push(self.converter.handleRaw(raw))
			off += SAMPLE_BYTES
		}
		self.remainder = off < n ? data.subarray(off) : new Uint8Array(0)
		if (cur.length) {
			segments.push({ samples: cur, breakBefore: curBreak })
			curBreak = null
		}
		if (curBreak) self.pendingBreak = curBreak
		return { segments: segments }
	}

	function mergeBreak(a, b) {
		if (!a) return b || null
		if (!b) return a
		return {
			reason: a.reason,
			missedSamples: (a.missedSamples || 0) + (b.missedSamples || 0),
			bytes: (a.bytes || 0) + (b.bytes || 0),
			badSamples: (a.badSamples || 0) + (b.badSamples || 0),
		}
	}

	// ---- 主机重采样（对照 Python RateAdjuster；基速可换实测）----
	function RateAdjuster(targetHz, baseHz) {
		this.baseRateHz = Math.max(1, baseHz | 0 || NOMINAL_BASE_HZ)
		this._accSum = 0
		this._accCount = 0
		this._accumulator = 0
		this._tSum = 0
		this.setTargetRateHz(targetHz || 1000)
	}

	RateAdjuster.prototype.setBaseRateHz = function (hz) {
		const h = Math.max(1, Math.round(hz))
		if (h === this.baseRateHz) return
		this.baseRateHz = h
		// 目标不变，分母变了需同步 step
		this.setTargetRateHz(this.targetRateHz)
	}

	RateAdjuster.prototype.setTargetRateHz = function (hz) {
		const tr = Math.max(1, Math.min(NOMINAL_BASE_HZ, Math.round(hz)))
		this.targetRateHz = tr
		this._stepNum = tr
		this._stepDen = this.baseRateHz
		// 若目标 >= 基速则 1:1
		if (this._stepNum >= this._stepDen) {
			this._stepNum = this._stepDen
		}
	}

	RateAdjuster.prototype.reset = function () {
		this._accSum = 0
		this._accCount = 0
		this._accumulator = 0
		this._tSum = 0
	}

	/**
	 * @param {number} valueUA
	 * @param {number} tMs performance.now 风格
	 * @returns {{ tMs: number, iUA: number }[]}
	 */
	RateAdjuster.prototype.push = function (valueUA, tMs) {
		this._accSum += valueUA
		this._tSum += tMs
		this._accCount++
		this._accumulator += this._stepNum
		const outs = []
		while (this._accumulator >= this._stepDen && this._accCount > 0) {
			const avg = this._accSum / this._accCount
			const tOut = this._tSum / this._accCount
			outs.push({ tMs: tOut, iUA: avg })
			this._accumulator -= this._stepDen
			this._accSum = 0
			this._tSum = 0
			this._accCount = 0
		}
		return outs
	}

	RateAdjuster.prototype.appliedRateHz = function () {
		if (this._stepNum >= this._stepDen) return this.baseRateHz
		return this.baseRateHz * (this._stepNum / this._stepDen)
	}

	// ---- Folding minimap（对照 Nordic FoldingBuffer，定长 min/max 总览）----
	function FoldingBuffer(maxElements) {
		this.maxNumberOfElements = maxElements || 10000
		this.numberOfTimesToFold = 1
		this.lastElementFoldCount = 0
		this.length = 0
		this.minX = new Float64Array(this.maxNumberOfElements)
		this.minY = new Float64Array(this.maxNumberOfElements)
		this.maxX = new Float64Array(this.maxNumberOfElements)
		this.maxY = new Float64Array(this.maxNumberOfElements)
	}

	FoldingBuffer.prototype.reset = function () {
		this.numberOfTimesToFold = 1
		this.lastElementFoldCount = 0
		this.length = 0
	}

	FoldingBuffer.prototype._addDefault = function (ts) {
		const i = this.length
		this.minX[i] = ts
		this.minY[i] = Number.MAX_VALUE
		this.maxX[i] = ts
		this.maxY[i] = -Number.MAX_VALUE
		this.length++
	}

	FoldingBuffer.prototype._fold = function () {
		this.numberOfTimesToFold *= 2
		const n = this.length >> 1
		for (let i = 0; i < n; i++) {
			const a = i * 2
			const b = a + 1
			this.minX[i] = (this.minX[a] + this.minX[b]) / 2
			this.minY[i] = Math.min(this.minY[a], this.minY[b])
			this.maxX[i] = (this.maxX[a] + this.maxX[b]) / 2
			this.maxY[i] = Math.max(this.maxY[a], this.maxY[b])
		}
		this.length = n
	}

	/** @param valueUA µA  @param timestampSec 会话相对秒 */
	FoldingBuffer.prototype.addData = function (valueUA, timestampSec) {
		if (this.lastElementFoldCount === 0) {
			this._addDefault(timestampSec)
		}
		let v = valueUA
		// minimap 下限：1 nA（与主波形 Log floor 默认对齐；不再抬到 0.2 µA）
		if (v < 1e-3) v = 1e-3

		this.lastElementFoldCount++
		const alpha = 1 / this.lastElementFoldCount
		const i = this.length - 1
		this.minX[i] = timestampSec * alpha + this.minX[i] * (1 - alpha)
		this.maxX[i] = timestampSec * alpha + this.maxX[i] * (1 - alpha)
		if (isFinite(v)) {
			if (v < this.minY[i]) this.minY[i] = v
			if (v > this.maxY[i]) this.maxY[i] = v
		}

		if (this.lastElementFoldCount === this.numberOfTimesToFold) {
			this.lastElementFoldCount = 0
		}
		if (this.length === this.maxNumberOfElements) {
			this._fold()
		}
	}

	/** 返回交错 min/max 点 [{x,y},…] 供总览绘制 */
	FoldingBuffer.prototype.getData = function () {
		const out = []
		for (let i = 0; i < this.length; i++) {
			if (this.maxY[i] < this.minY[i]) continue
			out.push({ x: this.minX[i], y: this.minY[i] })
			out.push({ x: this.maxX[i], y: this.maxY[i] })
		}
		return out
	}

	const api = {
		CMD: CMD,
		MODE: MODE,
		NOMINAL_BASE_HZ: NOMINAL_BASE_HZ,
		SAMPLE_BYTES: SAMPLE_BYTES,
		VDD_LOW_MV: VDD_LOW_MV,
		VDD_HIGH_MV: VDD_HIGH_MV,
		USB_FILTERS: [{ usbVendorId: 0x15A2, usbProductId: 0x300A }],
		packBytes: packBytes,
		cmdMeta: cmdMeta,
		cmdAverageStart: cmdAverageStart,
		cmdAverageStop: cmdAverageStop,
		cmdRegulatorSet: cmdRegulatorSet,
		cmdDutPower: cmdDutPower,
		cmdSourceMode: cmdSourceMode,
		cmdAmpereMode: cmdAmpereMode,
		defaultModifiers: defaultModifiers,
		parseMetadata: parseMetadata,
		Converter: Converter,
		SampleParser: SampleParser,
		RateAdjuster: RateAdjuster,
		FoldingBuffer: FoldingBuffer,
	}
	global.PowerProtocol = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
