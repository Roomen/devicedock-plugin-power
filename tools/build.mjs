#!/usr/bin/env node
// 无依赖的插件打包脚本（结构与宿主仓库的 examples/plugin-hello/tools/build.mjs 一致）：
// 1. 计算包内所有运行时文件的 sha256，写回 manifest.json 的 integrity（含 icon.svg）
// 2. 生成符合 GitHub Release 资产命名规范的 devicedock-plugin.zip 与 devicedock-plugin.zip.sha256
// 3. 相同输入产出逐字节一致的归档（固定 DOS 时间戳），便于复现与比对
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 所有要由 ddplugin:// 提供的文件都必须在这里，并且只在这里（integrity 由此生成）
const FILES = [
	'index.html',
	'css/app.css',
	'icon.svg',
	'js/app.js',
	'js/power-i18n.js',
	'js/power-protocol.js',
	'js/power-view.js',
	'js/power-panels.js',
	'js/power-lane.js',
	'js/power-analysis.js',
	'js/power-store.js',
	'js/power-wave.js',
	'js/power-claim.js',
	'js/power-control.js',
	'js/power-export.js',
	'js/power-import.js',
	'sdk/devicedock-plugin.js',
]

function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex')
}

// 标准 CRC-32（ZIP 本地文件头与中央目录使用）
const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
	let c = i
	for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
	CRC_TABLE[i] = c >>> 0
}
function crc32(buf) {
	let c = 0xffffffff
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

export function buildZipBuffer(entries) {
	const locals = []
	const centrals = []
	let offset = 0
	for (const item of entries) {
		const nameBuf = Buffer.from(item.name, 'utf8')
		const raw = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data)
		const compressed = deflateRawSync(raw, { level: 9 })
		const useDeflate = compressed.length < raw.length
		const body = useDeflate ? compressed : raw
		const method = useDeflate ? 8 : 0
		const crc = crc32(raw)

		const local = Buffer.alloc(30 + nameBuf.length)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(0x0800, 6)
		local.writeUInt16LE(method, 8)
		local.writeUInt16LE(0, 10)
		local.writeUInt16LE(0x21, 12)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(body.length, 18)
		local.writeUInt32LE(raw.length, 22)
		local.writeUInt16LE(nameBuf.length, 26)
		local.writeUInt16LE(0, 28)
		nameBuf.copy(local, 30)
		locals.push(local, body)

		const central = Buffer.alloc(46 + nameBuf.length)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(0x0314, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(0x0800, 8)
		central.writeUInt16LE(method, 10)
		central.writeUInt16LE(0, 12)
		central.writeUInt16LE(0x21, 14)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(body.length, 20)
		central.writeUInt32LE(raw.length, 24)
		central.writeUInt16LE(nameBuf.length, 28)
		central.writeUInt16LE(0, 30)
		central.writeUInt16LE(0, 32)
		central.writeUInt16LE(0, 34)
		central.writeUInt16LE(0, 36)
		central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
		central.writeUInt32LE(offset, 42)
		nameBuf.copy(central, 46)
		centrals.push(central)

		offset += local.length + body.length
	}
	const centralBuf = Buffer.concat(centrals)
	const eocd = Buffer.alloc(22)
	eocd.writeUInt32LE(0x06054b50, 0)
	eocd.writeUInt16LE(0, 4)
	eocd.writeUInt16LE(0, 6)
	eocd.writeUInt16LE(entries.length, 8)
	eocd.writeUInt16LE(entries.length, 10)
	eocd.writeUInt32LE(centralBuf.length, 12)
	eocd.writeUInt32LE(offset, 16)
	eocd.writeUInt16LE(0, 20)
	return Buffer.concat([...locals, centralBuf, eocd])
}

export function buildPowerPlugin(opts = {}) {
	const integrity = {}
	const fileEntries = []
	for (const rel of FILES) {
		const bytes = readFileSync(join(root, rel))
		integrity[rel] = 'sha256-' + sha256Hex(bytes)
		fileEntries.push({ name: rel, data: bytes })
	}
	const manifestPath = join(root, 'manifest.json')
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
	manifest.integrity = integrity
	const manifestBytes = Buffer.from(JSON.stringify(manifest, null, '\t') + '\n', 'utf8')
	if (opts.writeManifest !== false) {
		writeFileSync(manifestPath, manifestBytes)
	}
	const zipBytes = buildZipBuffer([
		{ name: 'manifest.json', data: manifestBytes },
		...fileEntries,
	])
	const zipSha256 = sha256Hex(zipBytes)
	if (opts.outDir) {
		mkdirSync(opts.outDir, { recursive: true })
		writeFileSync(join(opts.outDir, 'devicedock-plugin.zip'), zipBytes)
		writeFileSync(join(opts.outDir, 'devicedock-plugin.zip.sha256'), zipSha256 + '  devicedock-plugin.zip\n')
	}
	return { manifest, zipBytes, zipSha256, files: FILES.slice() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outIdx = process.argv.indexOf('--out-dir')
	const outDir = outIdx !== -1 && process.argv[outIdx + 1]
		? resolve(process.argv[outIdx + 1])
		: (process.argv.includes('--no-dist') ? null : join(root, 'dist'))
	const res = buildPowerPlugin({ outDir })
	console.log('plugin-power: ' + res.manifest.id + '@' + res.manifest.version +
		' files=' + res.files.length + ' zip=' + res.zipBytes.length + 'B sha256=' + res.zipSha256.slice(0, 12))
}
