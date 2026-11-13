// 波形冷存储（内存版）：分块 deflate 压缩后留在内存里，按「原始当量」设总量上限。
// 插件 sandbox 里没有 OPFS / IndexedDB / localStorage，所以冷数据只能放内存；压缩是为了在
// 同一个上限下多留几倍时长。超限时按最早写入的块淘汰并回报给调用方（波形要标成缺口）。
;(function (global) {
	'use strict'

	const DEFAULT_CAP_RAW_BYTES = 512 * 1024 * 1024
	const BYTES_PER_SAMPLE = 4

	function hasCompression() {
		return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' &&
			typeof Blob === 'function' && typeof Response === 'function'
	}

	async function deflate(u8) {
		if (!hasCompression()) return null
		const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))
		const buf = await new Response(stream).arrayBuffer()
		return new Uint8Array(buf)
	}

	async function inflate(u8, expectBytes) {
		const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))
		const buf = await new Response(stream).arrayBuffer()
		if (expectBytes && buf.byteLength !== expectBytes) {
			throw new Error('冷数据长度不符：期望 ' + expectBytes + ' 字节，解出 ' + buf.byteLength)
		}
		return new Float32Array(buf)
	}

	function toFloat32(samples) {
		if (samples instanceof Float32Array) return samples
		return Float32Array.from(samples)
	}

	/**
	 * @param {object} opts
	 * @param {number} [opts.capRawBytes] 原始当量上限（未压缩字节），默认 512 MiB
	 * @param {function} [opts.onEvict] 淘汰回调：receives [{ id, rawBytes }]
	 * @param {function} [opts.onUse] 写入/淘汰后回调（界面刷新用量）
	 */
	function createMemoryWaveStore(opts) {
		opts = opts || {}
		let capRawBytes = opts.capRawBytes > 0 ? Math.floor(opts.capRawBytes) : DEFAULT_CAP_RAW_BYTES
		let onEvict = typeof opts.onEvict === 'function' ? opts.onEvict : function () {}
		const onUse = typeof opts.onUse === 'function' ? opts.onUse : function () {}
		const blocks = new Map()
		let seq = 0
		let rawUsed = 0
		let compressedUsed = 0
		let session = 0
		let initPromise = null

		function init() {
			if (!initPromise) initPromise = Promise.resolve('memory')
			return initPromise
		}

		function getBackend() {
			return 'memory'
		}

		function evictUntilFits(needRaw, protectId) {
			const evicted = []
			if (!(capRawBytes > 0)) return evicted
			if (rawUsed + needRaw <= capRawBytes) return evicted
			// Map 的插入顺序就是写入顺序：从头淘汰最早块
			// eslint-disable-next-line no-restricted-syntax
			for (const [id, blk] of blocks) {
				if (rawUsed + needRaw <= capRawBytes) break
				if (id === protectId) continue
				blocks.delete(id)
				rawUsed -= blk.rawBytes
				compressedUsed -= blk.byteSize
				evicted.push({ id: id, rawBytes: blk.rawBytes })
			}
			if (evicted.length) {
				rawUsed = Math.max(0, rawUsed)
				compressedUsed = Math.max(0, compressedUsed)
				onEvict(evicted)
			}
			return evicted
		}

		async function writeChunk(id, samples) {
			const f32 = toFloat32(samples)
			const raw = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
			const rawBytes = raw.byteLength
			// 压缩是异步的；期间源缓冲由调用方持有，写入前后都不要改动它
			const packed = await deflate(raw)
			const body = packed && packed.byteLength < rawBytes ? packed : raw.slice()
			const byteSize = body.byteLength
			// 先放弃同一 id 的旧副本再腾空间：重写一块不该反过来把自己（或别的更早块）挤掉
			const prev = blocks.get(id)
			if (prev) {
				blocks.delete(id)
				rawUsed -= prev.rawBytes
				compressedUsed -= prev.byteSize
			}
			const evicted = evictUntilFits(rawBytes, id)
			blocks.set(id, { body: body, byteSize: byteSize, rawBytes: rawBytes, seq: ++seq, session: session })
			rawUsed += rawBytes
			compressedUsed += byteSize
			onUse()
			return { byteSize: byteSize, rawBytes: rawBytes, compressed: byteSize < rawBytes, evicted: evicted }
		}

		function getBlock(id) {
			return blocks.get(id) || null
		}

		async function readChunk(id, n) {
			const blk = blocks.get(id)
			if (!blk) throw new Error('冷数据块不存在: ' + id)
			const expect = (n | 0) * BYTES_PER_SAMPLE
			if (blk.byteSize === expect) {
				const copy = blk.body.slice()
				return new Float32Array(copy.buffer, copy.byteOffset, expect / BYTES_PER_SAMPLE)
			}
			return inflate(blk.body, expect)
		}

		function removeChunk(id) {
			const blk = blocks.get(id)
			if (!blk) return 0
			blocks.delete(id)
			rawUsed = Math.max(0, rawUsed - blk.rawBytes)
			compressedUsed = Math.max(0, compressedUsed - blk.byteSize)
			onUse()
			return blk.byteSize
		}

		function clearSession() {
			blocks.clear()
			rawUsed = 0
			compressedUsed = 0
			session++
			onUse()
			return Promise.resolve()
		}

		return {
			init: init,
			getBackend: getBackend,
			getBlock: getBlock,
			getDiskUsed: function () { return compressedUsed }, // 兼容旧名：已压缩占用
			getRawUsed: function () { return rawUsed },
			getCompressedUsed: function () { return compressedUsed },
			getCapBytes: function () { return capRawBytes },
			onEvict: function (fn) { if (typeof fn === 'function') onEvict = fn },
			setCapBytes: function (n) { capRawBytes = n > 0 ? Math.floor(n) : 0 },
			getSession: function () { return session },
			blockCount: function () { return blocks.size },
			compressionSupported: hasCompression,
			writeChunk: writeChunk,
			readChunk: readChunk,
			removeChunk: removeChunk,
			clearSession: clearSession,
			// 兼容旧名
			gcOrphans: function () { return Promise.resolve(0) },
		}
	}

	const api = { createMemoryWaveStore: createMemoryWaveStore, DEFAULT_CAP_RAW_BYTES: DEFAULT_CAP_RAW_BYTES, compressionSupported: hasCompression }
	global.PowerMemoryStore = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
