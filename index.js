/**
 * dsh-aipais-image —— 把「想点子 → 填表 → 出图」压成一次工具调用的宿主插件。
 *
 * 注册两个工具：
 *  - generate_image  生成/编辑，落盘到工作区，返回可直接粘贴的 Markdown
 *  - image_gen_info  查余额、模型与能力表（不花钱）
 *
 * 只依赖 node 内置能力与 ./lib/core.js，不 import @deepseek-ai/*，
 * 因此 link 安装进 profile 后无需额外依赖即可解析。
 */

import { PLUGIN_VERSION, runGenerate, runInfo } from './lib/core.js'

/** Cordis 插件名（与包名一致，Loader 按此解析）。 */
export const name = 'dsh-aipais-image'

/** 需要的服务：工具注册表。 */
export const inject = ['tools']

/** 模型给出的参数已由注册表校验，这里再兜一层运行期默认值。 */
function unref(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value
}

function normalizeArgs(raw) {
  const args = {}
  for (const [key, value] of Object.entries(unref(raw) || {})) args[key] = unref(value)
  return args
}

const GENERATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: {
      type: 'string',
      description: '单条提示词（与 prompts 二选一）。写清主体、场景、光线、媒介/画风；需要画面文字时把文字逐字写进 prompt 并要求不得乱码。',
    },
    prompts: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 10,
      description:
        '一次给多条不同提示词，各出一张（最多 10 条）。想一句话出四种不同方向、或一次填满整块版面时用它；与 prompt 二选一，忽略 n。',
    },
    n: { type: 'integer', minimum: 1, maximum: 10, description: '同一提示词的张数，默认 1。给了 prompts 时忽略。' },
    model: {
      type: 'string',
      description: '模型。默认 gpt-image-2.6（1k，单张约 10–15s）；传 size_tier 2k/4k 会自动切 gpt-image-2.6-exact（约 15–30s）。GIF/SVG 自动切 gpt-image-2.6-media。风格化可选 -flare / -sunburst。',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['1:1', '16:9', '9:16', '2:3', '3:2'],
      description: '宽高比，默认 1:1。海报用 2:3/9:16，风景用 16:9。',
    },
    size_tier: {
      type: 'string',
      enum: ['1k', '2k', '4k'],
      description: '清晰度档，默认 1k（原生分辨率）。只有 -exact 支持 2k/4k，但 2k/4k 只是 1k 放大，细节不增加。',
    },
    quality: {
      type: 'string',
      enum: ['auto', 'low', 'medium', 'high'],
      description: '画质，默认 auto。追求速度用 auto/low，追求细节用 high。',
    },
    output_format: {
      type: 'string',
      enum: ['png', 'jpeg', 'webp', 'gif', 'svg', 'auto'],
      description: '格式，默认 auto（b64 一般返回 PNG）。gif 出约 410px 循环动图；svg 需上游原生矢量。',
    },
    reference_images: {
      type: 'array',
      items: { type: 'string' },
      description: '参考图路径（绝对路径或相对当前工作目录），1–4 张。给了就走 /v1/images/edits：锁角色、锁风格、改背景/表情。参考图必须是目标角色/目标风格本身。',
    },
    save_dir: {
      type: 'string',
      description: '保存目录，默认 generate/images（相对当前工作目录）。',
    },
    filename_hint: {
      type: 'string',
      description: '文件名提示（可选），默认从 prompt 提取。',
    },
  },
}

const GENERATE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'message', 'markdown', 'files'],
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string', description: '人类可读的结果摘要。' },
    markdown: { type: 'string', description: '可直接粘进回复的 Markdown 图片块。' },
    model: { type: 'string' },
    elapsed_ms: { type: 'number' },
    balance_after: { type: 'number', description: '调用后余额（credits），查询失败为 -1。' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'absolute_path', 'format', 'bytes'],
        properties: {
          path: { type: 'string', description: '相对工作区（或绝对）路径，用于 Markdown 引用。' },
          absolute_path: { type: 'string' },
          format: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          prompt: { type: 'string', description: '这一张用的是哪条提示词（多提示词时用于区分）。' },
          attachment: {
            type: 'object',
            additionalProperties: false,
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
            description: '会话附件引用（持久，重开会话仍在）。准入失败时缺省。',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              name: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

const INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const INFO_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'message', 'balance', 'models'],
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    balance: { type: 'number', description: '余额（credits），查询失败为 -1。' },
    models: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string' },
          size_tiers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

function sessionCwd(exec) {
  const session = exec?.agent?.session
  return (
    session?.header?.cwd ||
    session?.cwd ||
    exec?.agent?.cwd ||
    process.cwd()
  )
}

/**
 * 会话附件准入：把生成好的字节存进 DSH 的附件存储，拿到持久引用。
 * 服务缺席（自定义组合没挂 attachment-local）时安静降级，不影响出图。
 */
function admissionOf(ctx) {
  // 与 dsh-bili-scroll 同一套取法：运行时 ctx.get('attachments') + saveImages()。
  const service = () => {
    const scoped = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined
    return scoped ?? ctx?.attachments
  }
  return async ({ buffer, mediaType, name }) => {
    const attachments = service()
    if (!attachments) return { reason: '附件服务不可用（ctx.get("attachments") 为空）' }
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    try {
      if (typeof attachments.saveImages === 'function') {
        const refs = await attachments.saveImages([{ data, mediaType, name }])
        const ref = Array.isArray(refs) ? refs[0] : refs
        if (ref?.attachmentId) return { ref }
        return { reason: 'saveImages 没有返回引用' }
      }
      if (typeof attachments.saveImage === 'function') {
        const ref = await attachments.saveImage({ data, mediaType, name })
        if (ref?.attachmentId) return { ref }
        return { reason: 'saveImage 没有返回引用' }
      }
      return { reason: '附件服务上没有 saveImages / saveImage' }
    } catch (error) {
      return { reason: '入库失败：' + String(error?.message || error) }
    }
  }
}

/** 生成工具定义。 */
function generateToolDefinition(config, admitImage) {
  return {
    name: 'generate_image',
    description: [
      'Generate images with aipais gpt-image-2.6 (text-to-image, or reference-image edit when reference_images is given).',
      'One call covers: build request → generate → save into the workspace → return paths plus ready-to-paste Markdown.',
      'Defaults are tuned for speed: gpt-image-2.6 (1k native, ~10-15s per image), quality auto, aspect 1:1, PNG/auto format; size_tier 2k/4k switches to gpt-image-2.6-exact (~15-30s) automatically. Files go to <cwd>/generate/images unless save_dir says otherwise.',
      'For several different ideas in one call, pass prompts (array of 1-10) instead of n: same subject in different styles, four distinct concepts, or a full spread — one tool call, one inline card.',
      'Every image gets a JSON sidecar with its prompt, model and parameters, plus one line in <save_dir>/index.jsonl. Use that ledger when the user asks what an earlier image was made from.',
      'Requests are queued through a small concurrency gate (default 2) and a failed download is retried once, so parallel calls are safe.',
      'Efficiency rules for casual "make some fun images" requests: just invent the ideas, call this tool (one call, several prompts), and show the returned markdown. Do NOT read the images back one by one to check them — image2.6 is stable and a QA loop only wastes time. Inspect only when the user explicitly asks, or when the tool reports a failure.',
    ].join(' '),
    parameters: GENERATE_SCHEMA,
    output: {
      schema: GENERATE_OUTPUT,
      /**
       * 只给界面用的投影（不进模型上下文）：客户端读它渲染会话内联图片卡。
       * 老会话没有 meta 时，客户端会退回解析 render 出来的 Markdown。
       */
      presentationMeta: (_args, value) => ({
        card: 'aipais-image',
        version: PLUGIN_VERSION,
        model: String(value?.model || ''),
        elapsed_ms: Number(value?.elapsed_ms) || 0,
        balance_after: Number(value?.balance_after ?? -1),
        images: (Array.isArray(value?.files) ? value.files : []).map((file) => ({
          path: String(file?.path || ''),
          absolute_path: String(file?.absolute_path || ''),
          format: String(file?.format || ''),
          bytes: Number(file?.bytes) || 0,
          width: Number(file?.width) || 0,
          height: Number(file?.height) || 0,
          prompt: String(file?.prompt || ''),
          attachment: file?.attachment && typeof file.attachment === 'object'
            ? {
                attachmentId: String(file.attachment.attachmentId || ''),
                mediaType: String(file.attachment.mediaType || ''),
                bytes: Number(file.attachment.bytes) || 0,
                width: Number(file.attachment.width) || 0,
                height: Number(file.attachment.height) || 0,
                ...(file.attachment.name ? { name: String(file.attachment.name) } : {}),
              }
            : null,
        })),
      }),
      render: (_args, value) => {
        const message = String(value?.message || '')
        const markdown = String(value?.markdown || '')
        return [{ type: 'text', text: markdown ? `${message}\n\n${markdown}` : message }]
      },
    },
    async execute(rawArgs, exec) {
      const args = normalizeArgs(rawArgs)
      try {
        return await runGenerate(args, {
          cwd: sessionCwd(exec),
          config,
          signal: exec?.signal,
          admitImage,
        })
      } catch (error) {
        const message = `❌ 出图失败：${error?.message || error}`
        return {
          ok: false,
          message,
          markdown: '',
          files: [],
          model: String(args.model || 'gpt-image-2.6'),
          elapsed_ms: 0,
          balance_after: -1,
        }
      }
    },
  }
}

/** 信息查询工具定义。 */
function infoToolDefinition(config) {
  return {
    name: 'image_gen_info',
    description: [
      'Check the aipais image relay: remaining credits, available models with size tiers, and the capability table (aspect ratios, output formats, gif/svg notes, reference edits, multi-prompt, price).',
      'Free to call (no image is generated). Use it when the user asks what the image tool can do, which formats are supported, or how much credit is left.',
    ].join(' '),
    parameters: INFO_SCHEMA,
    output: {
      schema: INFO_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: String(value?.message || '') }],
    },
    async execute(_rawArgs, exec) {
      try {
        return await runInfo({}, { config, signal: exec?.signal, cwd: sessionCwd(exec) })
      } catch (error) {
        return {
          ok: false,
          message: `❌ 查询失败：${error?.message || error}`,
          balance: -1,
          models: [],
        }
      }
    },
  }
}

/**
 * 注册工具。Cordis 在 apply 前已按 inject 解析好 ctx.tools。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config bundle patch 里的 config
 */
export function apply(ctx, config = {}) {
  const register = (definition) => {
    if (typeof ctx.tools?.register !== 'function') {
      console.warn(`[dsh-aipais-image] tools registry unavailable, skip ${definition.name}`)
      return
    }
    try {
      ctx.tools.register(definition)
    } catch (error) {
      console.warn(`[dsh-aipais-image] failed to register ${definition.name}:`, error)
    }
  }
  register(generateToolDefinition(config, admissionOf(ctx)))
  register(infoToolDefinition(config))
}
