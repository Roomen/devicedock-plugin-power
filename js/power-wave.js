// 波形会话语义：热区环形块 + 冷区内存分块压缩 + 包络/统计/分桶。
// 关键不变量（都是踩过的坑）：
//  - 块只追加，ch.base 是块首的全局样点下标；索引一律按 base 二分，不能假设固定块长（尾块可能不满）。
//  - 一帧里只有有限个冷块能用逐点细节，缓存命中的桶也占额度，否则平移时会把仍可见的块挤出缓存、反复回读。
//  - 清空数据会推进 waveEpoch：旧的异步归档/回读不得改动新会话，新归档要等清盘完成（storageBarrier）。
//  - 写盘跟不上采集（归档队列超预算）就停采，不能无限排队。
//  - 缺口（串口丢事件 / 存储淘汰）只标记不猜测：duration 与能量按连续段算，绝不跨缺口累加。
;(function (global) {
	'use strict'

	const BYTES_PER_SAMPLE = 4
	// 每个块描述符、字符串与完整包络按 4 KiB 预留；这不是 JS 引擎堆的精确测量。
	const CHUNK_META_BYTES = 4096

	const DEFAULTS = {
		chunkSize: 65536,
		envelopeStep: 1024,
		// 回读缓存块数：24 × 256 KiB ≈ 6 MiB（与原实现一致，一帧额度再留 4 块的余量）
		hydrateCacheMax: 24,
		ramCapSamples: 65536 * 8,
		metaBudgetBytes: 64 * 1024 * 1024,
	}

	/**
	 * @param {object} cfg
	 * @param {object} cfg.store 冷存储（writeChunk/readChunk/removeChunk/clearSession/init）
	 * @param {function} cfg.voltage 当前源电压 V（功率口径）
	 * @param {function} cfg.samplePeriod 每个样点的秒数
	 * @param {function} [cfg.log]
	 * @param {function} [cfg.scheduleUI]
	 * @param {function} [cfg.onStorageStop] 触顶时异步停采
	 * @param {number} [cfg.ramCapSamples] 热区预算（样点）
	 * @param {number} [cfg.chunkSize]
	 * @param {number} [cfg.envelopeStep]
	 * @param {number} [cfg.hydrateCacheMax]
	 * @param {number} [cfg.metaBudgetBytes] 块元数据总预算
	 * @param {number} [cfg.rawBudgetBytes] 冷存储原始当量预算（Infinity = 交给 store 自己淘汰）
	 */
	function createWave(cfg) {
		cfg = cfg || {}
		const CHUNK_SIZE = Math.max(1, cfg.chunkSize || DEFAULTS.chunkSize)
		const ENV_STEP = Math.max(1, cfg.envelopeStep || DEFAULTS.envelopeStep)
		const HYDRATE_CACHE_MAX = Math.max(4, cfg.hydrateCacheMax || DEFAULTS.hydrateCacheMax)
		const HYDRATE_FRAME_MAX = HYDRATE_CACHE_MAX - 4
		const META_BUDGET = cfg.metaBudgetBytes > 0 ? cfg.metaBudgetBytes : DEFAULTS.metaBudgetBytes
		const Store = cfg.store || null
		const voltage = typeof cfg.voltage === 'function' ? cfg.voltage : function () { return 0 }
		const samplePeriod = typeof cfg.samplePeriod === 'function' ? cfg.samplePeriod : function () { return 0 }
		const log = typeof cfg.log === 'function' ? cfg.log : function () {}
		const scheduleUI = typeof cfg.scheduleUI === 'function' ? cfg.scheduleUI : function () {}
		const onStorageStop = typeof cfg.onStorageStop === 'function' ? cfg.onStorageStop : function () {}
		const rawBudgetBytes = cfg.rawBudgetBytes != null ? cfg.rawBudgetBytes : Infinity

		let RING_CAP_MAX = Math.max(CHUNK_SIZE, cfg.ramCapSamples || DEFAULTS.ramCapSamples)

		// 顺序分块：hot 有 buf；cold/dropped 释放 buf，细节按需从 store 回读
		// { id, base, buf, n, sumI, sumSqI, sumP, minI, maxI, firstI, lastI, state, diskBytes, env }
		const waveChunks = []
		let archiveCursor = 0
		let totalCount = 0
		let hotCount = 0
		let coldCount = 0
		let growBlocked = false
		let storageStop = false
		let ramArchiveNoted = false
		let chunkIdSeq = 0
		const archiveQueue = []
		let archiveRunning = false
		let archiveTask = Promise.resolve()
		let storageBarrier = Promise.resolve()
		let waveEpoch = 0
		const hydrateCache = new Map()
		const hydratePending = new Set()
		// 同一个冷块的并发回读共用这个 Promise（分析 / 导出 await 它）
		const hydratePromises = new Map()
		let hydrateInFlight = 0
		let archiveQueuedSamples = 0
		// 缺口：样点下标，表示「该下标与前一个下标不连续」。画布画竖标记，统计按段算。
		const gapList = []
		let droppedSamples = 0

		function archiveQueueMax() {
			return Math.max(8 * CHUNK_SIZE, Math.floor(RING_CAP_MAX / 8))
		}

		function metadataChunkLimit() {
			const reserved = (RING_CAP_MAX + archiveQueueMax() + (HYDRATE_CACHE_MAX * 2 + 8) * CHUNK_SIZE) * BYTES_PER_SAMPLE
			// 下限 1024 块：预算被热区吃满时也不能一上来就停采（宁可多留约 4 MiB 元数据）
			return Math.max(1024, Math.floor((META_BUDGET - reserved) / CHUNK_META_BYTES))
		}

		function emptyStats() {
			return {
				n: 0, avgI: 0, avgP: 0, minI: 0, maxI: 0,
				chargeUC: 0, chargeUAh: 0, energyUWh: 0, dur: 0,
				volts: 0, segments: 0, gaps: 0, dropped: 0,
			}
		}

		/** 只补缺省字段：分段积分出来的电量/能量已经是对的，不能被 avg×dur 覆盖 */
		function enrichStats(st) {
			if (!st) return emptyStats()
			const out = Object.assign(emptyStats(), st)
			if (!isFinite(out.chargeUC)) out.chargeUC = out.n ? out.avgI * out.dur : 0
			if (!isFinite(out.chargeUAh)) out.chargeUAh = out.chargeUC / 3600
			if (!isFinite(out.energyUWh)) out.energyUWh = out.n ? out.avgP * out.dur / 3600 : 0
			return out
		}

		function allocHotBuf() {
			try {
				return new Float32Array(CHUNK_SIZE)
			} catch (e) {
				growBlocked = true
				log('内存不足，无法分配波形块：' + (e && e.message ? e.message : e), 'warn')
				return null
			}
		}

		function newHotChunk() {
			const buf = allocHotBuf()
			if (!buf) return null
			chunkIdSeq++
			return {
				id: 'c' + chunkIdSeq,
				base: 0,
				buf: buf,
				n: 0,
				sumI: 0,
				sumSqI: 0,
				sumP: 0,
				minI: Infinity,
				maxI: -Infinity,
				firstI: 0,
				lastI: 0,
				state: 'hot',
				diskBytes: 0,
				env: null,
				// 块被写入时的源电压（V）：统计/导出都用它换算历史功率，改了设置也不改写
				voltsUsed: null,
				voltsMixed: false,
			}
		}

		function buildChunkEnv(buf, n) {
			const blocks = Math.ceil(n / ENV_STEP)
			const env = {
				min: new Float32Array(blocks), max: new Float32Array(blocks),
				first: new Float32Array(blocks), last: new Float32Array(blocks),
				sum: new Float64Array(blocks), sumSq: new Float64Array(blocks),
				minPos: new Float32Array(blocks),
			}
			for (let k = 0; k < blocks; k++) {
				const a = k * ENV_STEP
				const b = Math.min(n, a + ENV_STEP)
				let mn = Infinity, mx = -Infinity, mp = Infinity, sum = 0, sq = 0
				for (let i = a; i < b; i++) {
					const v = buf[i]
					if (v < mn) mn = v
					if (v > mx) mx = v
					if (v > 0 && v < mp) mp = v
					sum += v
					sq += v * v
				}
				env.min[k] = mn
				env.max[k] = mx
				env.minPos[k] = mp
				env.first[k] = buf[a]
				env.last[k] = buf[b - 1]
				env.sum[k] = sum
				env.sumSq[k] = sq
			}
			return env
		}

		function chunkIndexAt(li) {
			let lo = 0
			let hi = waveChunks.length - 1
			while (lo < hi) {
				const mid = (lo + hi) >> 1
				const ch = waveChunks[mid]
				if (ch.base + ch.n <= li) lo = mid + 1
				else hi = mid
			}
			return lo
		}

		function getChunkBuf(ch) {
			if (!ch) return null
			if (ch.buf) return ch.buf
			if (hydrateCache.has(ch.id)) return hydrateCache.get(ch.id)
			return null
		}

		function touchHydrateCache(id, buf) {
			if (hydrateCache.has(id)) hydrateCache.delete(id)
			hydrateCache.set(id, buf)
			while (hydrateCache.size > HYDRATE_CACHE_MAX) {
				const first = hydrateCache.keys().next().value
				hydrateCache.delete(first)
			}
		}

		function claimFrameHydrate(ch) {
			if (frameHydrateIds.has(ch.id)) return true
			if (frameHydrateIds.size >= HYDRATE_FRAME_MAX) return false
			frameHydrateIds.add(ch.id)
			return true
		}

		/**
		 * 回读一个冷块，返回 Promise<Float32Array|null>。
		 * 与 requestHydrate 的区别：这里给调用方一个可 await 的结果（分析 / 导出必须等真数据），
		 * 并且同 id 的并发回读共用同一个 Promise，不会重复读盘。
		 */
		function hydrateChunk(ch) {
			if (!ch) return Promise.resolve(null)
			if (ch.state === 'dropped') return Promise.resolve(null)
			const buf = getChunkBuf(ch)
			if (buf) return Promise.resolve(buf)
			if (ch.state === 'hot') return Promise.resolve(null)
			if (!ch.diskBytes || !Store) return Promise.resolve(null)
			const existing = hydratePromises.get(ch.id)
			if (existing) return existing
			const epoch = waveEpoch
			hydrateInFlight++
			hydratePending.add(ch.id)
			const task = Store.readChunk(ch.id, ch.n).then(function (got) {
				if (epoch !== waveEpoch) return null
				touchHydrateCache(ch.id, got)
				clearBucketCache()
				scheduleUI()
				return got
			}).catch(function (e) {
				if (epoch !== waveEpoch) return null
				log('冷数据回读失败 ' + ch.id + '：' + (e && e.message ? e.message : e), 'warn')
				return null
			}).finally(function () {
				hydrateInFlight--
				hydratePending.delete(ch.id)
				hydratePromises.delete(ch.id)
			})
			hydratePromises.set(ch.id, task)
			return task
		}

		function requestHydrate(ch) {
			if (!ch || ch.state === 'hot' || ch.state === 'dropped' || !Store) return
			if (!ch.diskBytes) return
			if (getChunkBuf(ch) || hydratePending.has(ch.id)) return
			if (hydrateInFlight >= HYDRATE_CACHE_MAX) return
			hydrateChunk(ch)
		}

		function findChunkAt(li) {
			if (li < 0 || li >= totalCount || !waveChunks.length) return null
			const i = chunkIndexAt(li)
			const ch = waveChunks[i]
			const off = li - ch.base
			if (off < 0 || off >= ch.n) return null
			return { ch: ch, off: off, index: i }
		}

		/** 全局逻辑下标 → 电流 µA（**显示用**：冷块未回读时用 min/max 中点占位并触发回读） */
		function ringIAt(li) {
			const loc = findChunkAt(li)
			if (!loc) return 0
			if (loc.ch.state === 'dropped') return 0
			const buf = getChunkBuf(loc.ch)
			if (buf) return buf[loc.off]
			requestHydrate(loc.ch)
			const ch = loc.ch
			if (isFinite(ch.minI) && isFinite(ch.maxI)) return (ch.minI + ch.maxI) * 0.5
			return 0
		}

		/**
		 * 全局逻辑下标 → **真实**电流 µA，拿不到就返回 null（绝不造数据）。
		 * 冷块还没回读、或者该下标所在的块已被淘汰，都返回 null。
		 */
		function iAtExact(li) {
			const loc = findChunkAt(li)
			if (!loc) return null
			if (loc.ch.state === 'dropped') return null
			const buf = getChunkBuf(loc.ch)
			if (!buf) {
				requestHydrate(loc.ch)
				return null
			}
			const v = buf[loc.off]
			return isFinite(v) ? v : null
		}

		/**
		 * 逐段、逐块地把区间里的**真实**样点交给访问者，必要时等待冷块回读。
		 * 访问者收到的事件：
		 *   { kind: 'samples', lo, hi, values, volts, mixedVolts }  连续块内样点（[lo,hi) 全局下标）
		 *   { kind: 'gap', lo, hi }        缺口（时间轴断开）
		 *   { kind: 'dropped', lo, hi }    已淘汰（数据不可用）
		 *   { kind: 'missing', lo, hi }    冷块回读失败（不可用，不造数）
		 * 分析与导出都走这里：拿不到就明说不可用，绝不拿块级 min/max 中点充数。
		 */
		async function walkExact(start, end, visit) {
			const a0 = Math.max(0, Math.min(totalCount, start | 0))
			const b0 = Math.max(a0, Math.min(totalCount, end | 0))
			const summary = { samples: 0, missing: 0, dropped: 0, gaps: 0 }
			if (b0 <= a0) return summary
			// 先把断点算好并按位置排序：断点必须与样点**交错**交付，
			// 否则调用方（分析 / 导出）无法知道哪一处该开新段。
			const breaks = []
			for (let i = 0; i < gapList.length; i++) {
				const g = gapList[i]
				if (g > a0 && g < b0) breaks.push({ kind: 'gap', lo: g, hi: g })
			}
			const dr = droppedRanges()
			for (let i = 0; i < dr.length; i++) {
				const lo = Math.max(a0, dr[i][0])
				const hi = Math.min(b0, dr[i][1])
				if (hi > lo) breaks.push({ kind: 'dropped', lo: lo, hi: hi })
			}
			breaks.sort(function (x, y) { return x.lo - y.lo })
			let bi = 0
			const flushBreaksBefore = function (pos) {
				while (bi < breaks.length && breaks[bi].lo <= pos) {
					const b = breaks[bi++]
					if (b.hi > b.lo) {
						summary.dropped += b.hi - b.lo
					} else {
						summary.gaps++
					}
					if (visit) visit(b)
				}
			}
			const segs = segments(a0, b0)
			for (let s = 0; s < segs.length; s++) {
				const segA = segs[s][0]
				const segB = segs[s][1]
				let i0 = chunkIndexAt(segA)
				let base = waveChunks[i0] ? waveChunks[i0].base : 0
				for (let i = i0; i < waveChunks.length; i++) {
					const ch = waveChunks[i]
					const ch0 = base
					const ch1 = base + ch.n
					const lo = Math.max(segA, ch0)
					const hi = Math.min(segB, ch1)
					base = ch1
					if (base > segB) base = ch1
					if (hi > lo) {
						flushBreaksBefore(lo)
						const buf = await hydrateChunk(ch)
						if (!buf) {
							summary.missing += hi - lo
							if (visit) visit({ kind: 'missing', lo: lo, hi: hi })
						} else {
							summary.samples += hi - lo
							if (visit) {
								visit({
									kind: 'samples',
									lo: lo,
									hi: hi,
									values: buf.subarray(lo - ch0, hi - ch0),
									volts: chunkVolts(ch),
									mixedVolts: !!ch.voltsMixed,
								})
							}
						}
					}
					if (base >= segB) break
				}
			}
			flushBreaksBefore(b0)
			return summary
		}

		/**
		 * 区间内最小的正电流（供 log floor 自适应）。
		 * 只抽样约 2000 点：floor 会被贴到 10ⁿ，抽样足够，也不为画一帧扫全量。
		 */
		function minPositiveIn(start, end) {
			if (totalCount < 1) return 0
			let a = Math.max(0, start | 0)
			let b = Math.min(totalCount - 1, (end == null ? totalCount : end) | 0)
			if (b < a) return 0
			const span = b - a + 1
			const step = Math.max(1, Math.ceil(span / 2000))
			let mp = Infinity
			for (let i = a; i <= b; i += step) {
				const v = ringIAt(i)
				if (isFinite(v) && v > 0 && v < mp) mp = v
			}
			return isFinite(mp) ? mp : 0
		}

		function diskUsedBytes() {
			if (!Store) return 0
			return Store.getDiskUsed ? Store.getDiskUsed() : 0
		}

		function triggerStorageStop(reason) {
			if (storageStop) return
			storageStop = true
			log(reason, 'error')
			const epoch = waveEpoch
			setTimeout(function () {
				if (epoch === waveEpoch && storageStop) onStorageStop(reason)
			}, 0)
		}

		function enqueueOldestHotArchive() {
			let idx = -1
			for (let i = archiveCursor; i < waveChunks.length; i++) {
				const ch = waveChunks[i]
				if (ch.state === 'hot' && ch.buf && ch.n > 0) {
					// 优先归档已写满的块；仅当热数据已顶满预算时才归档未满尾块
					if (ch.n >= CHUNK_SIZE || hotCount >= RING_CAP_MAX) {
						idx = i
						break
					}
				}
			}
			if (idx < 0) return false
			const ch = waveChunks[idx]
			if (ch.state !== 'hot' || !ch.buf) return false
			if (!(rawBudgetBytes > 0)) return false
			if (!Store) return false
			const rawBytes = ch.n * BYTES_PER_SAMPLE
			if (isFinite(rawBudgetBytes) && diskUsedBytes() + rawBytes > rawBudgetBytes) return false
			// 归档队列里的数据仍在内存里：不能让队列无限长
			if (archiveQueuedSamples + ch.n > archiveQueueMax()) {
				triggerStorageStop('波形归档跟不上采集速度（待写 ' + archiveQueue.length + ' 块），已停止采样以免内存失控')
				return false
			}
			const samples = ch.buf.subarray(0, ch.n)
			try {
				ch.env = buildChunkEnv(samples, ch.n)
			} catch (e) {
				ch.env = null
			}
			archiveCursor = idx + 1
			ch.state = 'pending'
			ch.buf = null
			hotCount -= ch.n
			coldCount += ch.n
			archiveQueuedSamples += ch.n
			archiveQueue.push({ ch: ch, samples: samples })
			if (!ramArchiveNoted) {
				ramArchiveNoted = true
				log('热区预算已满，开始压缩归档到内存冷区（压缩后占用更少）')
			}
			pumpArchiveQueue()
			return true
		}

		function pumpArchiveQueue() {
			if (archiveRunning || !archiveQueue.length) return
			archiveRunning = true
			const job = archiveQueue.shift()
			const ch = job.ch
			const samples = job.samples
			const epoch = waveEpoch
			const barrier = storageBarrier
			archiveTask = (async function () {
				try {
					await barrier
					if (epoch !== waveEpoch) return
					if (!Store) throw new Error('冷存储未接入')
					await Store.init()
					if (epoch !== waveEpoch) return
					const res = await Store.writeChunk(ch.id, samples)
					if (epoch !== waveEpoch) return
					ch.diskBytes = res && res.byteSize ? res.byteSize : samples.length * BYTES_PER_SAMPLE
					ch.state = 'cold'
					if (res && res.evicted && res.evicted.length) noteEvictions(res.evicted)
				} catch (e) {
					if (epoch !== waveEpoch) return
					const msg = e && e.message ? e.message : String(e)
					// 写失败：尽量把数据救回 RAM，避免丢细节
					if (!ch.buf && ch.state === 'pending') {
						try {
							ch.buf = samples
							ch.state = 'hot'
							archiveCursor = Math.min(archiveCursor, chunkIndexAt(ch.base))
							hotCount += ch.n
							coldCount = Math.max(0, coldCount - ch.n)
						} catch (e2) {
							ch.state = 'dropped'
							droppedSamples += ch.n
							noteGap(ch.base)
							log('归档失败且无法回灌热区，这部分数据作缺口处理', 'error')
						}
					}
					log('波形归档失败：' + msg, 'error')
					triggerStorageStop('波形归档失败，已停止采样以防丢数据')
				} finally {
					// 含正在压缩/写入的块；它的缓冲到这里才可释放
					if (epoch === waveEpoch) archiveQueuedSamples = Math.max(0, archiveQueuedSamples - samples.length)
					archiveRunning = false
					if (archiveQueue.length) pumpArchiveQueue()
					if (epoch === waveEpoch) scheduleUI()
				}
			})()
		}

		/** 冷存储淘汰了最早块：那几段数据没了，标缺口而不是当成连续数据 */
		function noteEvictions(list) {
			let n = 0
			for (let i = 0; i < list.length; i++) {
				const id = list[i] && list[i].id
				const idx = waveChunks.findIndex(function (c) { return c.id === id })
				if (idx < 0) continue
				const ch = waveChunks[idx]
				if (ch.state === 'dropped') continue
				ch.state = 'dropped'
				ch.buf = null
				ch.diskBytes = 0
				hydrateCache.delete(ch.id)
				droppedSamples += ch.n
				coldCount = Math.max(0, coldCount - ch.n)
				noteGap(ch.base)
				noteGap(ch.base + ch.n)
				n += ch.n
			}
			if (n > 0) {
				log('存储上限：已淘汰最早的 ' + list.length + ' 个块（约 ' + n + ' 点），波形与统计在这些位置标为缺口', 'warn')
				clearBucketCache()
				scheduleUI()
			}
			return n
		}

		function ensureHotRoom(needSamples) {
			needSamples = needSamples || 1
			while (hotCount + needSamples > RING_CAP_MAX && !growBlocked) {
				if (!enqueueOldestHotArchive()) {
					triggerStorageStop('热区已满且无法继续归档，已停止采样（不覆盖旧数据）')
					return false
				}
			}
			if (growBlocked && hotCount + needSamples > RING_CAP_MAX) {
				triggerStorageStop('内存不足且无法继续归档，已停止采样')
				return false
			}
			return true
		}

		function ringPush(curUA) {
			if (storageStop) return false
			// 非有限值会污染 min/max/包络并导致 canvas 路径断裂（在占预算前丢弃）
			if (!isFinite(curUA)) return true
			if (!ensureHotRoom(1)) return false

			let ch = waveChunks.length ? waveChunks[waveChunks.length - 1] : null
			if (!ch || ch.state !== 'hot' || !ch.buf || ch.n >= CHUNK_SIZE) {
				if (waveChunks.length >= metadataChunkLimit()) {
					triggerStorageStop('波形块索引达到内存预留上限，已停止采样；已有数据保留，可导出后清空继续')
					return false
				}
				ch = newHotChunk()
				if (!ch) {
					if (enqueueOldestHotArchive()) ch = newHotChunk()
					if (!ch) {
						triggerStorageStop('无法分配新波形块，已停止采样')
						return false
					}
				}
				ch.base = totalCount
				waveChunks.push(ch)
			}

			const off = ch.n
			ch.buf[off] = curUA
			ch.n++
			const vset = voltage()
			if (ch.voltsUsed == null) ch.voltsUsed = vset
			else if (Math.abs(ch.voltsUsed - vset) > 1e-9) ch.voltsMixed = true
			ch.sumI += curUA
			ch.sumSqI += curUA * curUA
			ch.sumP += curUA * vset
			if (off === 0) ch.firstI = curUA
			ch.lastI = curUA
			if (curUA < ch.minI) ch.minI = curUA
			if (curUA > ch.maxI) ch.maxI = curUA

			totalCount++
			hotCount++
			return true
		}

		function ringReset() {
			waveEpoch++
			if (archiveQueue.length > 0) {
				let pts = 0
				for (let i = 0; i < archiveQueue.length; i++) {
					const j = archiveQueue[i]
					if (j && j.ch) pts += j.ch.n || 0
				}
				log('清空数据：丢弃 ' + archiveQueue.length + ' 个未归档块（约 ' + pts + ' 点）', 'warn')
				archiveQueue.length = 0
			}
			archiveQueuedSamples = 0
			waveChunks.length = 0
			archiveCursor = 0
			totalCount = 0
			hotCount = 0
			coldCount = 0
			growBlocked = false
			storageStop = false
			ramArchiveNoted = false
			droppedSamples = 0
			gapList.length = 0
			hydrateCache.clear()
			hydratePending.clear()
			frameHydrateIds.clear()
			clearBucketCache()
			if (Store) {
				// 先等旧写盘结束再清冷区；新写盘等清理完成
				storageBarrier = Promise.all([storageBarrier, archiveTask]).then(function () {
					return Store.clearSession()
				}).catch(function () { /* 忽略 */ })
			}
		}

		// ---- 缺口 ----
		function noteGap(atIndex) {
			const idx = Math.max(0, Math.min(totalCount, atIndex | 0))
			if (gapList.length && gapList[gapList.length - 1] === idx) return
			let lo = 0
			let hi = gapList.length
			while (lo < hi) {
				const mid = (lo + hi) >> 1
				if (gapList[mid] < idx) lo = mid + 1
				else hi = mid
			}
			if (gapList[lo] === idx) return
			gapList.splice(lo, 0, idx)
		}

		function gaps() {
			return gapList.slice()
		}

		/** 被淘汰（dropped）块的区间，[lo,hi) 半开，按 base 升序 */
		function droppedRanges() {
			const out = []
			for (let i = 0; i < waveChunks.length; i++) {
				const ch = waveChunks[i]
				if (ch.state !== 'dropped' || !ch.n) continue
				const last = out[out.length - 1]
				if (last && last[1] === ch.base) last[1] = ch.base + ch.n
				else out.push([ch.base, ch.base + ch.n])
			}
			return out
		}

		/**
		 * [start,end) 内按**缺口与被淘汰块**切开的连续段，[lo,hi) 半开区间。
		 * 统计、分析、导出都只在这条边界内配对：断点两侧永远不在同一段里。
		 */
		function segments(start, end) {
			const lo0 = Math.max(0, start)
			const stop = Math.min(totalCount, end)
			if (stop <= lo0) return []
			// 1) 先减掉被淘汰（dropped）的区间：那些样点已经不存在，不能算时长也不能积分
			let allowed = [[lo0, stop]]
			const dr = droppedRanges()
			for (let i = 0; i < dr.length; i++) {
				const a = dr[i][0]
				const b = dr[i][1]
				if (b <= lo0 || a >= stop) continue
				const next = []
				for (let k = 0; k < allowed.length; k++) {
					const segA = allowed[k][0]
					const segB = allowed[k][1]
					if (b <= segA || a >= segB) { next.push([segA, segB]); continue }
					if (a > segA) next.push([segA, a])
					if (b < segB) next.push([b, segB])
				}
				allowed = next
			}
			// 2) 再用缺口点把剩下的区间切开（缺口是零宽断点）
			const out = []
			for (let k = 0; k < allowed.length; k++) {
				let lo = allowed[k][0]
				const hi = allowed[k][1]
				for (let i = 0; i < gapList.length; i++) {
					const g = gapList[i]
					if (g <= lo) continue
					if (g >= hi) break
					out.push([lo, g])
					lo = g
				}
				out.push([lo, hi])
			}
			return out.filter(function (seg) { return seg[1] > seg[0] })
		}

		function gapsIn(start, end) {
			let n = 0
			const lo = Math.max(0, start)
			const hi = Math.min(totalCount, end)
			for (let i = 0; i < gapList.length; i++) {
				const g = gapList[i]
				if (g > lo && g < hi) n++
			}
			return n
		}

		/** 块的有效电压（V）：sumP/sumI 是采样当时的加权平均，改了源电压也不会被改写 */
		function chunkVolts(ch) {
			if (ch.sumI > 0 && isFinite(ch.sumP)) return ch.sumP / ch.sumI
			return ch.voltsUsed != null ? ch.voltsUsed : voltage()
		}

		function addChunkStatRange(ch, lo, hi, acc) {
			if (hi <= lo) return
			if (ch.state === 'dropped') return
			if (lo === 0 && hi === ch.n && ch.n > 0) {
				acc.sumI += ch.sumI
				acc.sumP += ch.sumP
				if (ch.minI < acc.minI) acc.minI = ch.minI
				if (ch.maxI > acc.maxI) acc.maxI = ch.maxI
				acc.n += ch.n
				return
			}
			const buf = getChunkBuf(ch)
			// 部分区间也要用这一块**历史**电压，不能拿界面当前设置去改写历史能量
			const vset = chunkVolts(ch)
			if (buf) {
				for (let i = lo; i < hi; i++) {
					const v = buf[i]
					if (!isFinite(v)) continue
					acc.sumI += v
					acc.sumP += v * vset
					if (v < acc.minI) acc.minI = v
					if (v > acc.maxI) acc.maxI = v
					acc.n++
				}
				return
			}
			// 冷块未回读：按块级统计近似（整块区间精确，部分区间按比例，电压仍取历史值）
			requestHydrate(ch)
			if (ch.n > 0) {
				const ratio = (hi - lo) / ch.n
				acc.sumI += ch.sumI * ratio
				acc.sumP += ch.sumP * ratio
				if (ch.minI < acc.minI) acc.minI = ch.minI
				if (ch.maxI > acc.maxI) acc.maxI = ch.maxI
				acc.n += hi - lo
			}
		}

		/** 把 [start,end) 内某个连续段（不含 dropped 块，由 segments 保证）累加进 acc */
		function accumulateSegment(a, b, acc) {
			if (b <= a) return
			const i0 = chunkIndexAt(a)
			let base = waveChunks[i0] ? waveChunks[i0].base : 0
			for (let i = i0; i < waveChunks.length; i++) {
				const ch = waveChunks[i]
				const ch0 = base
				const ch1 = base + ch.n
				const lo = Math.max(a, ch0)
				const hi = Math.min(b, ch1)
				if (hi > lo) addChunkStatRange(ch, lo - ch0, hi - ch0, acc)
				base = ch1
				if (base >= b) break
			}
		}

		/** 区间内被淘汰（dropped）的样点数 */
		function droppedIn(start, end) {
			let n = 0
			for (let i = 0; i < waveChunks.length; i++) {
				const ch = waveChunks[i]
				if (ch.state !== 'dropped') continue
				const lo = Math.max(start, ch.base)
				const hi = Math.min(end, ch.base + ch.n)
				if (hi > lo) n += hi - lo
			}
			return n
		}

		/**
		 * 区间统计：**按连续段分别积分**再合并。
		 *
		 * 缺口与被淘汰的块把时间轴切开，每段各自累加电流、功率与时间，绝不跨段配对：
		 *  - 时长 = 各段内的相邻样点对数 × 采样周期（dropped 段不贡献时长）；
		 *  - 电量 / 能量 = Σ 段内均值 × 段时长（不是全区间均值 × 总时长）。
		 * 这样孤立的单个高电流点不会凭空产生能量，缺口两侧也不会互相影响。
		 */
		function calcStats(start, end) {
			if (totalCount < 1 || end <= start) return emptyStats()
			start = Math.max(0, start)
			end = Math.min(totalCount, end)
			if (end <= start) return emptyStats()
			const per = samplePeriod()
			const segs = segments(start, end)
			let n = 0
			let sumI = 0
			let sumP = 0
			let minI = Infinity
			let maxI = -Infinity
			let dur = 0
			let charge = 0
			let energy = 0
			let voltNum = 0
			let voltDen = 0
			for (let s = 0; s < segs.length; s++) {
				const a = segs[s][0]
				const b = segs[s][1]
				const acc = { n: 0, sumI: 0, sumP: 0, minI: Infinity, maxI: -Infinity }
				accumulateSegment(a, b, acc)
				if (acc.n) {
					sumI += acc.sumI
					sumP += acc.sumP
					n += acc.n
					if (acc.minI < minI) minI = acc.minI
					if (acc.maxI > maxI) maxI = acc.maxI
					voltNum += acc.sumP
					voltDen += acc.sumI
				}
				const steps = Math.max(0, b - a - 1)
				const segDur = steps * per
				dur += segDur
				if (acc.n) {
					const meanI = acc.sumI / acc.n
					const meanP = acc.sumP / acc.n
					charge += meanI * segDur
					energy += meanP * segDur / 3600
				}
			}
			const avgI = n ? sumI / n : 0
			const avgP = n ? sumP / n : 0
			return enrichStats({
				n: n,
				avgI: avgI,
				avgP: avgP,
				minI: isFinite(minI) ? minI : 0,
				maxI: isFinite(maxI) ? maxI : 0,
				dur: dur,
				chargeUC: charge,
				chargeUAh: charge / 3600,
				energyUWh: energy,
				// 这段历史数据的有效电压（按电流加权）；与界面当前设置无关
				volts: voltDen > 0 ? voltNum / voltDen : 0,
				segments: segs.length,
				gaps: gapsIn(start, end),
				dropped: droppedIn(start, end),
			})
		}

		function bucketMinMaxGlobal(lo, hi) {
			let mn = Infinity
			let mx = -Infinity
			let minPos = Infinity
			let first = 0
			let last = 0
			let got = false
			let sum = 0
			let sumSq = 0
			let cnt = 0
			const i0 = waveChunks.length ? chunkIndexAt(Math.max(0, lo)) : 0
			let base = i0 < waveChunks.length ? waveChunks[i0].base : 0
			for (let i = i0; i < waveChunks.length; i++) {
				const ch = waveChunks[i]
				const ch0 = base
				const ch1 = base + ch.n
				const a = Math.max(lo, ch0)
				const b = Math.min(hi, ch1 - 1)
				if (b >= a && ch.state !== 'dropped') {
					if (a === ch0 && b === ch1 - 1 && ch.n > 0) {
						// 整块：用端点样值作 first/last（min/max 作端点会在列间画出假尖峰）
						const f = isFinite(ch.firstI) ? ch.firstI : ch.minI
						const l = isFinite(ch.lastI) ? ch.lastI : ch.maxI
						if (!got) { first = f; got = true }
						last = l
						sum += ch.sumI
						sumSq += ch.sumSqI
						cnt += ch.n
						if (ch.minI < mn) mn = ch.minI
						if (ch.maxI > mx) mx = ch.maxI
						if (ch.minI > 0 && ch.minI < minPos) minPos = ch.minI
					} else {
						let buf = ch.buf
						if (!buf) {
							const wantDetail = !ch.env || (b - a + 1) < ENV_STEP
							if (wantDetail && claimFrameHydrate(ch)) {
								buf = getChunkBuf(ch)
								if (!buf) requestHydrate(ch)
							}
						}
						if (buf) {
							for (let p = a; p <= b; p++) {
								const v = buf[p - ch0]
								if (!isFinite(v)) continue
								if (!got) { first = v; got = true }
								last = v
								sum += v
								sumSq += v * v
								cnt++
								if (v < mn) mn = v
								if (v > mx) mx = v
								if (v > 0 && v < minPos) minPos = v
							}
						} else if (ch.env) {
							const env = ch.env
							const ka = Math.floor((a - ch0) / ENV_STEP)
							const kb = Math.floor((b - ch0) / ENV_STEP)
							for (let k = ka; k <= kb; k++) {
								const g0 = ch0 + k * ENV_STEP
								const g1 = Math.min(ch1 - 1, g0 + ENV_STEP - 1)
								const pa = Math.max(a, g0)
								const pb = Math.min(b, g1)
								const full = pa === g0 && pb === g1
								const gn = g1 - g0 + 1
								const len = pb - pa + 1
								const midV = (env.min[k] + env.max[k]) * 0.5
								if (!got) { first = full || pa === g0 ? env.first[k] : midV; got = true }
								last = full || pb === g1 ? env.last[k] : midV
								sum += full ? env.sum[k] : env.sum[k] / gn * len
								sumSq += full ? env.sumSq[k] : env.sumSq[k] / gn * len
								cnt += len
								if (env.min[k] < mn) mn = env.min[k]
								if (env.max[k] > mx) mx = env.max[k]
								if (env.minPos[k] < minPos) minPos = env.minPos[k]
							}
						} else {
							const mid = (isFinite(ch.minI) && isFinite(ch.maxI)) ? (ch.minI + ch.maxI) * 0.5 : 0
							if (!got) { first = mid; got = true }
							last = mid
							const len = b - a + 1
							sum += ch.sumI / ch.n * len
							sumSq += ch.sumSqI / ch.n * len
							cnt += len
							if (ch.minI < mn) mn = ch.minI
							if (ch.maxI > mx) mx = ch.maxI
							if (ch.minI > 0 && ch.minI < minPos) minPos = ch.minI
						}
					}
				}
				base = ch1
				if (base > hi) break
			}
			if (!got || !isFinite(mn) || !isFinite(mx)) {
				return { min: 0, max: 0, first: 0, last: 0, mean: 0, sd: 0, minPos: Infinity, loAbs: lo, hiAbs: hi }
			}
			const mean = cnt ? sum / cnt : (mn + mx) * 0.5
			const variance = cnt ? sumSq / cnt - mean * mean : 0
			return {
				min: mn, max: mx, first: first, last: last,
				// 均值夹在 [min, max] 内，抵消冷块近似带来的越界
				mean: Math.max(mn, Math.min(mx, mean)),
				sd: variance > 0 ? Math.sqrt(variance) : 0,
				minPos: minPos, loAbs: lo, hiAbs: hi,
			}
		}

		// ---- 分桶缓存 ----
		const bucketCache = { size: 0, base: 0, map: null }
		function clearBucketCache() {
			bucketCache.size = 0
			bucketCache.map = null
		}
		function pruneBucketCache(firstBucket, lastBucket) {
			const map = bucketCache.map
			if (!map) return
			const span = lastBucket - firstBucket + 1
			if (map.size <= span * 3 + 256) return
			const lo = firstBucket - span
			const hi = lastBucket + span
			map.forEach(function (v, k) {
				if (k < lo || k > hi) map.delete(k)
			})
		}
		function computeBucketSize(count, pw) {
			if (pw < 1 || count <= pw) return 1
			let bs = Math.ceil(count / pw)
			let p = 1
			while (p < bs) p <<= 1
			return p
		}
		function getBucketEntry(bucketIdx, bucketSize, base, lastAbs) {
			if (bucketCache.size !== bucketSize || bucketCache.base !== base || !bucketCache.map) {
				bucketCache.size = bucketSize
				bucketCache.base = base
				bucketCache.map = new Map()
			}
			const lo = bucketIdx * bucketSize
			const hi = Math.min(lastAbs, lo + bucketSize - 1)
			if (hi < base || lo > lastAbs) return null
			const complete = (hi - lo + 1) >= bucketSize
			const aLo = Math.max(lo, base)
			const aHi = hi
			if (complete && bucketCache.map.has(bucketIdx)) {
				// 缓存命中的细桶也占本帧回读额度，否则平移时会把仍可见的冷块挤出缓存
				for (let i = chunkIndexAt(aLo); i < waveChunks.length; i++) {
					const ch = waveChunks[i]
					if (ch.base > aHi) break
					const a = Math.max(aLo, ch.base)
					const b = Math.min(aHi, ch.base + ch.n - 1)
					if (!ch.buf && b >= a && (a !== ch.base || b !== ch.base + ch.n - 1) &&
						(!ch.env || b - a + 1 < ENV_STEP) && claimFrameHydrate(ch)) requestHydrate(ch)
				}
				return bucketCache.map.get(bucketIdx)
			}
			const entry = bucketMinMaxGlobal(aLo, aHi)
			// 未写满的尾桶不入缓存，否则 Live 增长时右缘会用旧 min/max 闪一下假波形
			if (complete) bucketCache.map.set(bucketIdx, entry)
			return entry
		}

		const frameHydrateIds = new Set()
		function frameReset() {
			frameHydrateIds.clear()
		}

		// 冷存储淘汰回调：块被淘汰时标记缺口
		if (Store && typeof Store.onEvict === 'function') {
			Store.onEvict(function (list) { noteEvictions(list) })
		}

		return {
			// 采集
			push: ringPush,
			ringPush: ringPush,
			reset: ringReset,
			ringReset: ringReset,
			total: function () { return totalCount },
			retained: function () { return totalCount - droppedSamples },
			hotCount: function () { return hotCount },
			coldCount: function () { return coldCount },
			droppedSamples: function () { return droppedSamples },
			chunks: waveChunks,
			queue: archiveQueue,
			state: function () {
				return {
					totalCount: totalCount,
					hotCount: hotCount,
					coldCount: coldCount,
					droppedSamples: droppedSamples,
					archiveQueuedSamples: archiveQueuedSamples,
					storageStop: storageStop,
					gaps: gapList.length,
				}
			},
			storageStop: function () { return storageStop },
			clearStorageStop: function () { storageStop = false },
			setRamCap: function (n) { RING_CAP_MAX = Math.max(1, n | 0) },
			ramCap: function () { return RING_CAP_MAX },
			metadataChunkLimit: metadataChunkLimit,
			archiveQueueMax: archiveQueueMax,
			// 读取
			findChunkAt: findChunkAt,
			iAt: ringIAt,
			iAtExact: iAtExact,
			walkExact: walkExact,
			hydrateChunk: hydrateChunk,
			droppedRanges: droppedRanges,
			chunkVolts: chunkVolts,
			ringIAt: ringIAt,
			stats: calcStats,
			calcStats: calcStats,
			minPositiveIn: minPositiveIn,
			bucketEntry: getBucketEntry,
			getBucketEntry: getBucketEntry,
			computeBucketSize: computeBucketSize,
			bucketCache: bucketCache,
			pruneBucketCache: pruneBucketCache,
			clearBucketCache: clearBucketCache,
			frameReset: frameReset,
			cache: hydrateCache,
			pending: hydratePending,
			clearHydrateCache: function () { hydrateCache.clear() },
			// 缺口
			noteGap: noteGap,
			gaps: gaps,
			segments: segments,
			diskUsed: diskUsedBytes,
			envelopeStep: ENV_STEP,
			chunkSize: CHUNK_SIZE,
		}
	}

	const api = { createWave: createWave, BYTES_PER_SAMPLE: BYTES_PER_SAMPLE, CHUNK_META_BYTES: CHUNK_META_BYTES }
	global.PowerWave = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
