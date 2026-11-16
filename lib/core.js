/**
 * aipais.de 图片中转站引擎（纯函数 + fetch，无 DSH 依赖）。
 *
 * 设计目标：一次调用 = 生成 + 落盘 + 返回可直接粘贴的 Markdown。
 *  - 文生图走 POST /v1/images/generations，参考图编辑走 POST /v1/images/edits
 *  - 优先 b64_json（绕开 CDN 的 UA 拦截与 chatgpt.com 直链被墙）
 *  - 失败按 5xx/429 指数退避重试；Retry-After 优先
 *  - 返回的格式以真实文件魔数为准，不信请求参数
 *  - 0.3.0：多提示词、并发闸、单张失败重试、同名防覆盖、元数据账本
 *
 * 供 index.js 与 selftest.mjs 共用，可单独 node 运行。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import { homedir } from 'node:os'

export const PLUGIN_VERSION = '0.3.0'
export const DEFAULT_BASE_URL = 'https://aipais.de/v1'
export const DEFAULT_MODEL = 'gpt-image-2.6-exact'
export const MEDIA_MODEL = 'gpt-image-2.6-media'
export const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '2:3', '3:2']
export const SIZE_TIERS = ['1k', '2k', '4k']
export const QUALITIES = ['auto', 'low', 'medium', 'high']
export const OUTPUT_FORMATS = ['png', 'jpeg', 'webp', 'gif', 'svg', 'auto']
export const MAX_IMAGES = 10
export const DEFAULT_CONCURRENCY = 2
export const MODELS = [
  'gpt-image-2.6-exact', // 1k/2k/4k，主力
  'gpt-image-2.6', // 1k
  'gpt-image-2.6-media', // 1k，GIF/SVG 必须走它
  'gpt-image-2.6-flare', // 1k 风格化
  'gpt-image-2.6-sunburst', // 1k 风格化
]

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

const EXT_BY_FORMAT = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  svg: 'svg',
}

/* ------------------------------------------------------------------ 配置 */

/** 解析 `export AIPAIS_KEY=xxx` / `AIPAIS_KEY=xxx` 形式的 env 文件。 */
export function readEnvFile(file) {
  const out = {}
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/** 候选 key 文件：配置指定 → 用户主目录 → 当前工作目录 → 已知的 Feishu 插件工作区副本。 */
function keyFileCandidates(config = {}) {
  return [
    config.apiKeyFile,
    join(homedir(), '.aipais.env'),
    join(process.cwd(), '.aipais.env'),
    join(homedir(), 'dsh-plugin-feishu-im', '.aipais.env'),
  ].filter(Boolean)
}

/** 解析 API key：显式配置 > 环境变量 > 已知 env 文件。 */
export function resolveApiKey(config = {}) {
  if (config.apiKey) return String(config.apiKey).trim()
  for (const name of ['AIPAIS_KEY', 'IMAGE_GEN_API_KEY', 'AIPAIS_API_KEY']) {
    if (process.env[name]) return String(process.env[name]).trim()
  }
  for (const file of keyFileCandidates(config)) {
    const env = readEnvFile(file)
    const value = env.AIPAIS_KEY || env.API_KEY
    if (value) return value
  }
  return null
}

function baseUrl(config = {}) {
  return String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/* ------------------------------------------------------------------ HTTP */

function headers(key, extra = {}) {
  return {
    Authorization: `Bearer ${key}`,
    'User-Agent': BROWSER_UA,
    ...extra,
  }
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get?.('retry-after')
  const seconds = retryAfter ? Number(retryAfter) : NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
  return Math.min(2000 * 2 ** attempt, 30_000)
}

/** 带重试的 JSON 请求。5xx/429/网络错误重试，其余直接抛。 */
async function requestJson(url, { method = 'GET', body, key, signal, timeoutMs = 600_000, attempts = 3 } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
    const signals = [controller.signal, signal].filter(Boolean)
    try {
      const response = await fetch(url, {
        method,
        headers: headers(key, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      })
      const text = await response.text()
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${text.slice(0, 500)}`)
        error.status = response.status
        error.response = response
        throw error
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`上游返回的不是 JSON：${text.slice(0, 300)}`)
      }
    } catch (error) {
      lastError = error
      if (error?.name === 'AbortError' && error?.cause?.message === 'request timeout') {
        // 超时不再重试：上游已经在长时间生成，重试可能重复计费。
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)
      }
      const retriable =
        error?.status === undefined || error.status === 429 || error.status >= 500
      if (!retriable || attempt === attempts - 1) break
      await new Promise((resolve) => setTimeout(resolve, retryDelay(error.response, attempt)))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

/* ---------------------------------------------------------- 并发闸（0.3.0） */

/**
 * 进程内并发闸。中转站对并发敏感，多会话同时出图时排队比撞 429 便宜。
 * 只限制在途的生成请求，落盘/写账本不受影响。
 */
let activeRequests = 0
const waitingSlots = []

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1)
  const next = waitingSlots.shift()
  if (next) next()
}

async function acquireSlot(limit) {
  while (activeRequests >= limit) {
    await new Promise((resolve) => waitingSlots.push(resolve))
  }
  activeRequests++
}

/** 并发受限的 map，保持结果顺序。 */
async function mapLimit(items, limit, run) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await acquireSlot(limit)
      try {
        results[index] = await run(items[index], index)
      } finally {
        releaseSlot()
      }
    }
  })
  await Promise.all(workers)
  return results
}

/** 进程内已占用的目标路径（同秒同名并发生成时防互相覆盖）。 */
const claimedPaths = new Set()

/* -------------------------------------------------------------- 格式识别 */

/** 按文件魔数判断真实格式，返回 png/jpeg/webp/gif/svg 或 null。 */
export function sniffFormat(buffer) {
  const b = buffer
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6) {
    const head6 = b.subarray(0, 6).toString('latin1')
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif'
  }
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp'
  }
  if (b.length >= 64) {
    const head = b.subarray(0, Math.min(1024, b.length)).toString('utf8')
    if (/<svg[\s>]/i.test(head)) return 'svg'
  }
  return null
}

function formatFromMime(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('svg')) return 'svg'
  return null
}

/* ------------------------------------------------------------- 图片尺寸 */

/** 轻量读取宽高（PNG/JPEG/GIF/WEBP/SVG），失败返回 null。 */
export function imageSize(buffer, format) {
  try {
    const b = buffer
    if (format === 'png' && b.length >= 24) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    }
    if (format === 'gif' && b.length >= 10) {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
    }
    if (format === 'jpeg') {
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++
          continue
        }
        const marker = b[i + 1]
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
        }
        const length = b.readUInt16BE(i + 2)
        i += 2 + length
      }
    }
    if (format === 'webp' && b.length >= 30) {
      const chunk = b.subarray(12, 16).toString('latin1')
      if (chunk === 'VP8X') {
        return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
      }
      if (chunk === 'VP8 ') {
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
      }
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
    }
    if (format === 'svg') {
      const text = b.subarray(0, Math.min(4096, b.length)).toString('utf8')
      const w = text.match(/<svg[^>]*\swidth=["']([\d.]+)(?:px)?["']/i)
      const h = text.match(/<svg[^>]*\sheight=["']([\d.]+)(?:px)?["']/i)
      if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) }
    }
  } catch {
    /* 尺寸只是锦上添花，失败就算了 */
  }
  return null
}

/* ---------------------------------------------------------------- 落盘 */

function slugify(text, fallback = 'image') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || fallback
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function isoTimestamp() {
  return new Date().toISOString()
}

/** 相对 cwd 的展示路径；工作区外则给绝对路径。 */
export function displayPath(absolute, cwd) {
  if (!cwd) return absolute
  const rel = relative(cwd, absolute)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolute
}

/**
 * 抢一个不会覆盖已有文件的路径。
 * 同一秒、同一 prompt、并行两次调用都会算出一模一样的文件名，所以既要看磁盘也要看进程内占位。
 */
function claimPath(dirAbs, base, ext) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const absolute = join(dirAbs, `${base}${suffix}.${ext}`)
    if (claimedPaths.has(absolute) || existsSync(absolute)) continue
    claimedPaths.add(absolute)
    return absolute
  }
  const fallback = join(dirAbs, `${base}-${Date.now()}.${ext}`)
  claimedPaths.add(fallback)
  return fallback
}

/** 每张图旁边写一份 JSON 元数据，图片移到哪都能回答「这张是什么 prompt 出来的」。 */
function writeSidecar(absolute, record) {
  try {
    const sidecar = join(dirname(absolute), `${basename(absolute, extname(absolute))}.json`)
    writeFileSync(sidecar, `${JSON.stringify(record, null, 2)}\n`)
    return sidecar
  } catch {
    return null
  }
}

/** 追加一行到 save_dir/index.jsonl，供图库与「上次那张」检索。 */
function appendIndex(dirAbs, record) {
  try {
    appendFileSync(join(dirAbs, 'index.jsonl'), `${JSON.stringify(record)}\n`)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------ 出图主流程 */

function resolveModel(args) {
  if (args.model) return String(args.model)
  const format = String(args.output_format || 'auto').toLowerCase()
  // 文档：生成 GIF 或 SVG 必须用 media 别名。
  if (format === 'gif' || format === 'svg') return MEDIA_MODEL
  return DEFAULT_MODEL
}

function buildCommonFields(args, model) {
  const fields = {
    model,
    size_tier: SIZE_TIERS.includes(args.size_tier) ? args.size_tier : '1k',
    aspect_ratio: ASPECT_RATIOS.includes(args.aspect_ratio) ? args.aspect_ratio : '1:1',
    quality: QUALITIES.includes(args.quality) ? args.quality : 'auto',
    response_format: 'b64_json',
  }
  const format = String(args.output_format || 'auto').toLowerCase()
  if (format && format !== 'auto') fields.output_format = format === 'jpg' ? 'jpeg' : format
  return fields
}

/** prompts 优先；没有就给单条 prompt 复制 n 次。 */
function normalizePrompts(args) {
  const list = Array.isArray(args?.prompts) ? args.prompts : []
  const clean = list.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
  if (clean.length === 0) return null
  return clean.slice(0, MAX_IMAGES)
}

/** 把「一个 prompt × n 张」或「多个 prompt 各一张」统一成任务列表。 */
function planJobs(args, prompts) {
  if (prompts) return prompts.map((prompt) => ({ prompt, count: 1 }))
  const count = Math.max(1, Math.min(MAX_IMAGES, Number(args.n) || 1))
  return [{ prompt: String(args.prompt).trim(), count }]
}

/**
 * 生成（或参考图编辑）核心。
 * @param {object} args 模型给的参数（已校验）
 * @param {{cwd:string, config?:object, signal?:AbortSignal}} options
 * @returns {Promise<object>} 工具输出对象
 */
export async function runGenerate(args, options = {}) {
  const started = Date.now()
  const cwd = options.cwd || process.cwd()
  const config = options.config || {}
  const key = resolveApiKey(config)
  if (!key) throw new Error('没有找到 aipais API key：可配置 config.apiKey / apiKeyFile，或设置 AIPAIS_KEY 环境变量，或放在 ~/.aipais.env')

  const prompts = normalizePrompts(args)
  if (!prompts && !String(args?.prompt || '').trim()) {
    throw new Error('prompt 不能为空（也可以用 prompts 一次给多个不同提示词）')
  }

  const model = resolveModel(args)
  const common = buildCommonFields(args, model)
  const refs = Array.isArray(args.reference_images) ? args.reference_images.filter(Boolean) : []
  const jobs = planJobs(args, prompts)
  const total = jobs.reduce((sum, job) => sum + job.count, 0)
  if (total === 0) throw new Error('没有可生成的提示词')
  const concurrency = Math.max(
    1,
    Math.min(4, Number(config.concurrency) || DEFAULT_CONCURRENCY),
  )

  // ---- 请求阶段：多 prompt 就是多次请求，由并发闸排队
  const t0 = Date.now()
  const batches = await mapLimit(jobs, concurrency, async (job) => {
    const body = { ...common, prompt: job.prompt, n: job.count }
    try {
      if (refs.length > 0) {
        const form = new FormData()
        for (const [k, v] of Object.entries(body)) {
          if (v !== undefined) form.append(k, String(v))
        }
        for (const ref of refs) {
          const absolute = isAbsolute(ref) ? ref : join(cwd, ref)
          if (!existsSync(absolute)) throw new Error(`参考图不存在：${ref}`)
          const buffer = readFileSync(absolute)
          const mime = MIME_BY_EXT[extname(absolute).toLowerCase()] || 'application/octet-stream'
          form.append('image', new Blob([buffer], { type: mime }), basename(absolute))
        }
        const data = await editRequest(form, key, config, options.signal)
        return { ok: true, prompt: job.prompt, items: Array.isArray(data?.data) ? data.data : [] }
      }
      const data = await requestJson(`${baseUrl(config)}/images/generations`, {
        method: 'POST',
        body,
        key,
        signal: options.signal,
      })
      return { ok: true, prompt: job.prompt, items: Array.isArray(data?.data) ? data.data : [] }
    } catch (error) {
      return { ok: false, prompt: job.prompt, items: [], error: String(error?.message || error) }
    }
  })
  const elapsedApi = Date.now() - t0

  const failures = []
  const pending = []
  for (const batch of batches) {
    if (batch === undefined) continue
    if (!batch.ok) {
      failures.push(batch.error)
      continue
    }
    if (batch.items.length === 0) {
      failures.push(`上游没有返回图片（${batch.prompt.slice(0, 40)}）`)
      continue
    }
    for (const item of batch.items) pending.push({ item, prompt: batch.prompt })
  }
  if (pending.length === 0) {
    throw new Error(`上游没有返回可用图片：${failures.join('; ') || '空响应'}`)
  }

  // ---- 落盘阶段：先 b64，拿到字节再决定扩展名，失败的那张单独重试一次
  const saveDir = String(args.save_dir || 'generate/images')
  const dirAbs = isAbsolute(saveDir) ? saveDir : join(cwd, saveDir)
  mkdirSync(dirAbs, { recursive: true })

  const hint = slugify(args.filename_hint || (prompts ? prompts[0] : args.prompt), 'image')
  const stampText = stamp()
  const files = []

  for (let index = 0; index < pending.length; index++) {
    const { item, prompt } = pending[index]
    let buffer = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        buffer = await materialize(item, key, config, options.signal)
        break
      } catch (error) {
        if (attempt === 1) failures.push(String(error?.message || error))
        else await new Promise((resolve) => setTimeout(resolve, 800))
      }
    }
    if (buffer === null) continue

    const itemFormat =
      sniffFormat(buffer) ||
      formatFromMime(item.mime_type) ||
      (item.format ? String(item.format).toLowerCase() : null) ||
      (common.output_format === 'jpeg' ? 'jpeg' : null) ||
      'png'
    const ext = EXT_BY_FORMAT[itemFormat] || 'png'
    const suffix = pending.length > 1 ? `-${index + 1}` : ''
    const absolute = claimPath(dirAbs, `${stampText}-${hint}${suffix}`, ext)
    writeFileSync(absolute, buffer)
    const size = imageSize(buffer, itemFormat)
    const shown = displayPath(absolute, cwd)
    const record = {
      generated_at: isoTimestamp(),
      plugin: `dsh-aipais-image@${PLUGIN_VERSION}`,
      prompt,
      model: common.model,
      aspect_ratio: common.aspect_ratio,
      size_tier: common.size_tier,
      quality: common.quality,
      output_format: common.output_format || 'auto',
      reference_images: refs,
      format: itemFormat,
      bytes: buffer.length,
      ...(size ? { width: size.width, height: size.height } : {}),
    }
    writeSidecar(absolute, record)
    appendIndex(dirAbs, { ...record, file: shown })
    files.push({
      path: shown,
      absolute_path: absolute,
      format: itemFormat,
      bytes: buffer.length,
      prompt,
      ...(size ? { width: size.width, height: size.height } : {}),
    })
  }

  if (files.length === 0) {
    throw new Error(`图片拿到了但落盘失败：${failures.join('; ') || '未知原因'}`)
  }

  const balanceAfter = await balance(key, config, options.signal).catch(() => null)
  const elapsedMs = Date.now() - started
  const aspect = common.aspect_ratio
  const tier = common.size_tier
  const sizeText = files[0].width ? `${files[0].width}×${files[0].height}` : ''
  const markdown = files
    .map((file, index) => `![${hint}${files.length > 1 ? ` #${index + 1}` : ''}](<${file.path}>)`)
    .join('\n')

  const message = [
    `✅ 生成 ${files.length} 张（${model} · ${tier} · ${aspect}${sizeText ? ` · ${sizeText}` : ''}，用时 ${(elapsedMs / 1000).toFixed(1)}s${elapsedApi ? `，上游 ${(elapsedApi / 1000).toFixed(1)}s` : ''}）`,
    prompts ? `提示词：${jobs.length} 条不同${failures.length > 0 ? `，失败 ${failures.length} 条` : ''}` : '',
    `文件：${files.map((file) => file.path).join('、')}`,
    `账本：${displayPath(dirAbs, cwd)}/index.jsonl`,
    balanceAfter !== null ? `余额：${balanceAfter} credits` : '',
    failures.length > 0 ? `失败 ${failures.length} 张：${failures.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    ok: true,
    message,
    markdown,
    files: files.map((file) => ({
      path: file.path,
      absolute_path: file.absolute_path,
      format: file.format,
      bytes: file.bytes,
      width: file.width ?? 0,
      height: file.height ?? 0,
      prompt: file.prompt,
    })),
    model,
    elapsed_ms: elapsedMs,
    balance_after: balanceAfter ?? -1,
  }
}

/** 把单条 data item 变成字节：优先 b64_json，其次 url / download_url。 */
async function materialize(item, key, config, signal) {
  if (item?.b64_json) return Buffer.from(String(item.b64_json), 'base64')
  const url = item?.url || item?.download_url
  if (!url) throw new Error('上游没有给 b64_json 也没有 url')
  const response = await fetch(url, { headers: headers(key), signal })
  if (!response.ok) throw new Error(`下载图片失败 HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function editRequest(form, key, config, signal) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${baseUrl(config)}/images/edits`, {
        method: 'POST',
        headers: headers(key), // 不要手写 Content-Type，让 fetch 带 boundary
        body: form,
        signal,
      })
      const text = await response.text()
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${text.slice(0, 500)}`)
        error.status = response.status
        throw error
      }
      return JSON.parse(text)
    } catch (error) {
      lastError = error
      if (error.status && error.status < 500 && error.status !== 429) break
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)))
    }
  }
  throw lastError
}

/* -------------------------------------------------------------- 信息查询 */

export async function balance(key, config = {}, signal) {
  const data = await requestJson(`${baseUrl(config)}/balance`, { key, signal, attempts: 2 })
  const value = Number(data?.balance)
  if (!Number.isFinite(value)) throw new Error(`余额响应异常：${JSON.stringify(data).slice(0, 200)}`)
  return value
}

export async function models(key, config = {}, signal) {
  const data = await requestJson(`${baseUrl(config)}/models`, { key, signal, attempts: 2 })
  return Array.isArray(data?.data) ? data.data : []
}

/** image_gen_info 工具用：余额 + 模型 + 能力表。串行请求，避免中转站偶发拒绝并发。 */
export async function runInfo(args = {}, options = {}) {
  const config = options.config || {}
  const key = resolveApiKey(config)
  if (!key) throw new Error('没有找到 aipais API key')
  const problems = []
  let currentBalance = null
  let list = []
  try {
    currentBalance = await balance(key, config, options.signal)
  } catch (error) {
    problems.push(`余额查询失败：${error?.message || error}`)
  }
  try {
    list = await models(key, config, options.signal)
  } catch (error) {
    problems.push(`模型列表失败：${error?.message || error}`)
  }
  const modelLines = list.map((model) => {
    const tiers = Array.isArray(model.enabled_size_tiers) ? model.enabled_size_tiers.join('/') : '?'
    return `- ${model.id}（${tiers}）`
  })
  const message = [
    currentBalance !== null ? `余额：${currentBalance} credits` : '余额：查询失败',
    '',
    '模型：',
    ...(modelLines.length > 0 ? modelLines : ['- 查询失败，先用 gpt-image-2.6-exact']),
    '',
    '能力表：',
    '- 尺寸档：1k（原生）/ 2k / 4k（仅 -exact；2k/4k 是 1k 放大，细节不增加）',
    '- 比例：1:1 / 16:9 / 9:16 / 2:3 / 3:2',
    '- 格式：png / jpeg / webp / gif（动图，约 410px）/ svg（矢量，需上游原生生成）',
    '- 画质：auto / low / medium / high',
    '- 参考图编辑：/v1/images/edits，喂参考图锁角色/锁风格',
    '- 多提示词：prompts 一次给 1–10 条不同提示词，各出一张（并发闸排队）',
    '- 计费：约 0.009 credits/张，1k/2k/4k 同价',
    problems.length > 0 ? `\n注意：${problems.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return { ok: true, message, balance: currentBalance ?? -1, models: list.map((m) => ({ id: m.id, size_tiers: m.enabled_size_tiers || [] })) }
}
