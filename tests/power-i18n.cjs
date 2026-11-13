'use strict'
// 文案字典回归：两份字典键集合与占位符一致；index.html 与各模块引用的键都存在；
// 语言归一 / navigator 回退 / 切换通知 / DOM 刷新。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const I18N = require('../js/power-i18n.js')

const root = path.join(__dirname, '..')
const zh = I18N.DICTS['zh-CN']
const en = I18N.DICTS.en

// ---- 两份字典键集合完全一致 ----
{
	const zk = Object.keys(zh).sort()
	const ek = Object.keys(en).sort()
	const onlyZh = zk.filter((k) => !(k in en))
	const onlyEn = ek.filter((k) => !(k in zh))
	assert.deepEqual(onlyZh, [], '只有中文的键：' + onlyZh.join(', '))
	assert.deepEqual(onlyEn, [], '只有英文的键：' + onlyEn.join(', '))
	assert.ok(zk.length > 300, '字典覆盖全部界面文案：' + zk.length)
}

// ---- 占位符一致、无空串、英文里没有残留中文 ----
{
	const ph = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(',')
	for (const k of Object.keys(en)) {
		assert.equal(typeof zh[k], 'string')
		assert.ok(zh[k].length > 0 && en[k].length > 0, '空文案：' + k)
		assert.equal(ph(zh[k]), ph(en[k]), '占位符不一致：' + k + ' zh=' + zh[k] + ' en=' + en[k])
		assert.ok(!/[一-鿿]/.test(en[k]), '英文字典里有中文：' + k)
	}
}

// ---- index.html 引用的键都在字典里 ----
{
	const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
	const keys = []
	const re = /data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g
	let m
	while ((m = re.exec(html))) keys.push(m[1])
	assert.ok(keys.length > 100, 'index.html 的静态文案都挂了 data-i18n：' + keys.length)
	const missing = keys.filter((k) => !I18N.has(k))
	assert.deepEqual(missing, [], 'index.html 引用了不存在的键：' + missing.join(', '))
	// 运行时会改写的元素不能挂静态 data-i18n（否则切语言会把状态刷回初始文案）
	for (const id of ['chip-port', 'chip-sampling', 'chip-trigger', 'chip-gaps', 'chip-theme', 'btn-connect', 'btn-power', 'btn-sample', 'btn-max', 'scope-meta', 'st-power', 'log-meta', 'diag-error', 'export-meta']) {
		const tag = new RegExp('<[^>]*id="' + id + '"[^>]*>').exec(html)
		assert.ok(tag, '找不到 #' + id)
		assert.ok(!/data-i18n=/.test(tag[0]), '#' + id + ' 由运行时渲染，不能挂静态 data-i18n')
	}
}

// ---- 各模块里字面量 tr('...') / msg('...') / M('...') 引用的键都存在 ----
{
	const files = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js') && f !== 'power-i18n.js')
	const missing = []
	let refs = 0
	for (const f of files) {
		const src = fs.readFileSync(path.join(root, 'js', f), 'utf8')
		const re = /(?:\btr|\bmsg|\bM|I18N\.msg)\('([^']+)'/g
		let m
		while ((m = re.exec(src))) {
			refs++
			// 'ui.edge_' + mode 这类前缀拼接：至少前缀下要有键
			if (m[1].endsWith('_') || m[1].endsWith('.')) {
				if (!Object.keys(en).some((k) => k.indexOf(m[1]) === 0)) missing.push(f + ': ' + m[1] + '*')
				continue
			}
			if (!I18N.has(m[1])) missing.push(f + ': ' + m[1])
		}
	}
	assert.ok(refs > 250, '模块里的文案都走 tr() / msg()：' + refs)
	assert.deepEqual(missing, [], '引用了不存在的键：\n' + missing.join('\n'))
	// 拼接键的全集
	for (const e of ['off', 'rise', 'fall', 'either']) assert.ok(I18N.has('ui.edge_' + e), 'ui.edge_' + e)
	for (const y of ['linear', 'log', 'symlog']) assert.ok(I18N.has('ui.ymode_' + y), 'ui.ymode_' + y)
	for (const s of ['probed', 'commanded', 'unknown']) assert.ok(I18N.has('ui.source_' + s), 'ui.source_' + s)
	for (const s of ['auto', 'selection', 'window']) assert.ok(I18N.has('ui.an_source_' + s), 'ui.an_source_' + s)
	for (const t of ['light', 'dark']) assert.ok(I18N.has('ui.theme_' + t), 'ui.theme_' + t)
}

// ---- 语言归一与 navigator 回退（宿主契约：zh 开头 → zh-CN，其它 → en） ----
{
	assert.equal(I18N.normalize('zh-CN'), 'zh-CN')
	assert.equal(I18N.normalize('zh-TW'), 'zh-CN')
	assert.equal(I18N.normalize('ZH'), 'zh-CN')
	assert.equal(I18N.normalize('en-US'), 'en')
	assert.equal(I18N.normalize('de-DE'), 'en')
	assert.equal(I18N.normalize(''), null)
	assert.equal(I18N.normalize(null), null)
	assert.equal(I18N.fallbackLocale({ language: 'zh-Hans-CN' }), 'zh-CN')
	assert.equal(I18N.fallbackLocale({ language: 'fr' }), 'en')
	assert.equal(I18N.fallbackLocale({ languages: ['zh-CN'] }), 'zh-CN')
	assert.equal(I18N.fallbackLocale({}), 'en')
}

// ---- 取词、插值、切换通知、DOM 刷新 ----
{
	I18N.setLocale('zh-CN')
	assert.equal(I18N.t('ui.btn_start'), '开始采集')
	assert.equal(I18N.t('ui.chip_gaps', { n: 3 }), '缺口：3')
	assert.equal(I18N.t('no.such.key'), 'no.such.key', '缺键返回键名（不抛错）')
	const seen = []
	const off = I18N.onChange((l) => seen.push(l))
	assert.equal(I18N.setLocale('en-GB'), true)
	assert.equal(I18N.getLocale(), 'en')
	assert.equal(I18N.t('ui.btn_start'), 'Start capture')
	assert.equal(I18N.setLocale('en'), false, '同语言不重复通知')
	I18N.setLocale('zh')
	assert.deepEqual(seen, ['en', 'zh-CN'])
	off()
	I18N.setLocale('en')
	assert.deepEqual(seen, ['en', 'zh-CN'], '取消订阅后不再通知')

	// apply：textContent 与属性都按当前语言刷新
	const mk = (attrs) => ({
		attrs: Object.assign({}, attrs), textContent: '',
		getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k] },
		setAttribute(k, v) { this.attrs[k] = String(v) },
	})
	const a = mk({ 'data-i18n': 'h.refresh' })
	const b = mk({ 'data-i18n-title': 'a.maximize_f', 'data-i18n-aria': 'a.serial_port', 'data-i18n-placeholder': 'a.auto_a' })
	const html = mk({})
	const doc = { documentElement: html, title: '', querySelectorAll: () => [a, b] }
	I18N.setLocale('zh-CN')
	I18N.apply(doc)
	assert.equal(a.textContent, '刷新')
	assert.equal(b.attrs.title, '最大化 (F)')
	assert.equal(b.attrs['aria-label'], '串口')
	assert.equal(b.attrs.placeholder, '自动 µA')
	assert.equal(html.attrs.lang, 'zh-CN')
	assert.equal(doc.title, '功耗分析仪')
	I18N.setLocale('en')
	I18N.apply(doc)
	assert.equal(a.textContent, 'Refresh')
	assert.equal(b.attrs.title, 'Maximize (F)')
	assert.equal(html.attrs.lang, 'en')
	I18N.setLocale('zh-CN')
}

console.log('power-i18n: ok')
