/**
 * dsh-aipais-image —— 浏览器侧：把 generate_image 的结果渲染成会话内联图片卡。
 *
 * 手写客户端 bundle（惰性 CJS factory）：只依赖平台基线模块 react / react-dom，
 * 不 require 其它客户端插件模块，因此无需构建工具链。
 *
 * 数据来源：宿主侧 output.presentationMeta 写进 tools/result 的 meta（不进模型上下文），
 * 老会话没有 meta 时退回解析结果文本里的 Markdown 图片。
 * 图片字节走 DSH 自带的鉴权文件路由 GET /api/file?path=<绝对路径>（和 Markdown 图片同一条路）。
 *
 * 0.3.0：多提示词逐张显示 prompt、缩略图超过 6 张可展开、大图支持左右方向键翻页。
 */

window.__ModuleLoader__.load({
  id: 'dsh-aipais-image',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const reactDom = require('react-dom')

    const NS = 'dsh-aipais-image'
    const TOOL_NAME = 'generate_image'
    const COLLAPSED_LIMIT = 6

    const CSS = `
.dai-root{display:flex;flex-direction:column;gap:8px;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:var(--dsw-radius-md,10px);padding:10px 12px;background:var(--dsw-alias-bg-l2,transparent)}
.dai-head{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:20px}
.dai-icon{opacity:.75;font-size:13px}
.dai-title{font-weight:500;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap}
.dai-meta{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dai-grow{flex:1 1 auto;min-width:0}
.dai-hint{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));font-size:12px}
.dai-grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.dai-thumb{position:relative;display:block;padding:0;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:var(--dsw-radius-sm,8px);overflow:hidden;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));cursor:zoom-in;line-height:0}
.dai-thumb img{width:100%;height:100%;max-height:340px;object-fit:contain;display:block}
.dai-thumb[data-failed="true"]{cursor:default;line-height:1.5;padding:14px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));word-break:break-all}
.dai-foot{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}
.dai-foot button{padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px;text-decoration-color:rgba(127,127,127,.4)}
.dai-foot button:hover{color:var(--dsw-alias-label-primary,inherit)}
.dai-more{align-self:flex-start;padding:3px 10px;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:999px;background:none;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));font:inherit;font-size:11px;cursor:pointer}
.dai-more:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dai-error{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.dai-prompt{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.95));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dai-shimmer{background:linear-gradient(90deg,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)) 25%,rgba(127,127,127,0) 37%,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)) 63%);background-size:400% 100%;animation:dai-shimmer 1.4s ease infinite;height:96px;border-radius:var(--dsw-radius-sm,8px)}
@keyframes dai-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
@media (prefers-reduced-motion:reduce){.dai-shimmer{animation:none}}
.dai-lightbox{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:24px;background:rgba(0,0,0,.82);cursor:zoom-out}
.dai-lightbox img{max-width:calc(100vw - 64px);max-height:calc(100vh - 160px);object-fit:contain;border-radius:6px}
.dai-lightbox-bar{display:flex;gap:14px;align-items:center;color:rgba(255,255,255,.86);font-size:12px;cursor:default;max-width:calc(100vw - 64px)}
.dai-lightbox-bar a,.dai-lightbox-bar button{border:0;background:rgba(255,255,255,.12);color:inherit;font:inherit;padding:5px 12px;border-radius:999px;cursor:pointer;text-decoration:none}
.dai-lightbox-bar a:hover,.dai-lightbox-bar button:hover{background:rgba(255,255,255,.22)}
.dai-lightbox-bar button:disabled{opacity:.35;cursor:default;background:rgba(255,255,255,.08)}
.dai-lightbox-count{font-variant-numeric:tabular-nums}
.dai-lightbox-prompt{margin:0;max-width:min(720px,calc(100vw - 96px));font-size:12px;line-height:18px;color:rgba(255,255,255,.62);text-align:center;cursor:default;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
`

    /** 注入一次样式（bundle 只在 factory 物化时执行一遍）。 */
    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin=' + JSON.stringify(NS) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function isAbsolutePath(path) {
      return typeof path === 'string' && (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\'))
    }

    /** 工作区相对路径按会话 cwd 解析（与 DSH 自己的 Markdown 图片一致）。 */
    function resolvePath(cwd, path) {
      if (typeof path !== 'string' || path === '') return ''
      if (isAbsolutePath(path)) return path
      if (typeof cwd !== 'string' || cwd === '') return ''
      return cwd.replace(/[/\\]+$/, '') + '/' + path.replace(/^(?:\.?[/\\])+/, '')
    }

    /** 鉴权文件路由：GET <base>/api/file?path=<绝对路径>。 */
    function fileUrl(absolutePath) {
      if (!isAbsolutePath(absolutePath)) return ''
      try {
        return new URL('api/file?path=' + encodeURIComponent(absolutePath), document.baseURI).href
      } catch {
        return ''
      }
    }

    function isSettled(block) {
      return block !== null && typeof block === 'object' && typeof block.kind === 'string'
    }

    function textOf(block) {
      if (!isSettled(block) || !Array.isArray(block.content)) return ''
      return block.content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }

    function positive(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    }

    function promptText(value) {
      return typeof value === 'string' ? value.trim() : ''
    }

    /** 从 meta.images 读（新会话）；没有再解析结果文本里的 Markdown 图片（老会话）。 */
    function imagesOf(block, cwd) {
      const out = []
      const seen = new Set()
      const push = (entry) => {
        if (entry === null || entry.abs === '' || seen.has(entry.abs)) return
        seen.add(entry.abs)
        out.push(entry)
      }

      const meta = isSettled(block) ? block.meta : undefined
      if (meta !== null && typeof meta === 'object' && Array.isArray(meta.images)) {
        for (const item of meta.images) {
          if (item === null || typeof item !== 'object') continue
          const abs = typeof item.absolute_path === 'string' && item.absolute_path !== ''
            ? item.absolute_path
            : resolvePath(cwd, item.path)
          push({
            abs,
            label: typeof item.path === 'string' && item.path !== '' ? item.path : abs,
            width: positive(item.width),
            height: positive(item.height),
            bytes: positive(item.bytes),
            prompt: promptText(item.prompt),
          })
        }
      }

      if (out.length > 0) return out

      const text = textOf(block)
      const markdown = /!\[[^\]]*\]\(\s*<?([^)>\n]+)>?\s*\)/g
      let match
      while ((match = markdown.exec(text)) !== null) {
        const abs = resolvePath(cwd, match[1].trim())
        push({ abs, label: match[1].trim(), width: 0, height: 0, bytes: 0, prompt: '' })
      }
      return out
    }

    function metaOf(block) {
      const meta = isSettled(block) ? block.meta : undefined
      return meta !== null && typeof meta === 'object' ? meta : {}
    }

    /** 卡片上的一行提示词：运行中读调用参数，结束后读结果自带的 call.args。 */
    function promptOf(block) {
      if (block === null || typeof block !== 'object') return ''
      const call = block.call
      const fromArgs = (value) => {
        if (value === null || typeof value !== 'object') return ''
        if (typeof value.prompt === 'string' && value.prompt !== '') return value.prompt
        if (Array.isArray(value.prompts) && value.prompts.length > 0) {
          const list = value.prompts.filter((item) => typeof item === 'string' && item !== '')
          if (list.length === 1) return list[0]
          if (list.length > 1) return list.length + ' 条提示词：' + list.join(' / ')
        }
        return ''
      }
      const direct = fromArgs(call !== null && typeof call === 'object' ? call.args : undefined) || fromArgs(block.args)
      if (direct !== '') return direct
      const raw = call !== null && typeof call === 'object' ? call.argsRaw : undefined
      if (typeof raw === 'string' && raw !== '') {
        try {
          return fromArgs(JSON.parse(raw))
        } catch {
          return ''
        }
      }
      return ''
    }

    function formatSeconds(ms) {
      const value = typeof ms === 'number' && ms > 0 ? ms : 0
      return value === 0 ? '' : (value / 1000).toFixed(1) + 's'
    }

    function summaryOf(images, meta) {
      const parts = []
      if (images.length > 0) parts.push(images.length + ' 张')
      const first = images[0]
      if (first !== undefined && first.width > 0 && first.height > 0) parts.push(first.width + '×' + first.height)
      const seconds = formatSeconds(meta.elapsed_ms)
      if (seconds !== '') parts.push(seconds)
      return parts.join(' · ')
    }

    function Lightbox({ images, index, onClose, onStep }) {
      const image = images[index]
      react.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key === 'ArrowRight' && images.length > 1) {
            event.preventDefault()
            onStep(1)
            return
          }
          if (event.key === 'ArrowLeft' && images.length > 1) {
            event.preventDefault()
            onStep(-1)
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose, onStep, images.length])
      if (image === undefined) return null
      const url = fileUrl(image.abs)
      const many = images.length > 1
      return reactDom.createPortal(
        react.createElement(
          'div',
          {
            className: 'dai-lightbox',
            role: 'dialog',
            'aria-modal': 'true',
            onClick: (event) => {
              if (event.target === event.currentTarget) onClose()
            },
          },
          react.createElement('img', { src: url, alt: image.label }),
          many ? react.createElement('div', { className: 'dai-lightbox-prompt' }, image.prompt || image.label) : null,
          react.createElement(
            'div',
            { className: 'dai-lightbox-bar', onClick: (event) => event.stopPropagation() },
            many ? react.createElement('button', { type: 'button', onClick: () => onStep(-1) }, '‹') : null,
            react.createElement('span', { className: 'dai-lightbox-count' }, many ? index + 1 + ' / ' + images.length : image.label),
            many ? react.createElement('button', { type: 'button', onClick: () => onStep(1) }, '›') : null,
            url !== ''
              ? react.createElement('a', { href: url, download: image.label }, '下载')
              : null,
            react.createElement('button', { type: 'button', onClick: onClose }, '关闭'),
          ),
        ),
        document.body,
      )
    }

    /** 单个缩略图；加载失败时降级成路径文本而不是空框。 */
    function Thumb({ image, onOpen }) {
      const [failed, setFailed] = react.useState(false)
      const url = fileUrl(image.abs)
      if (url === '' || failed) {
        return react.createElement(
          'div',
          { className: 'dai-thumb', 'data-failed': 'true', title: image.abs },
          '无法预览：' + image.label,
        )
      }
      return react.createElement(
        'button',
        { type: 'button', className: 'dai-thumb', title: image.prompt || image.label, onClick: () => onOpen() },
        react.createElement('img', {
          src: url,
          alt: image.label,
          loading: 'lazy',
          onError: () => setFailed(true),
        }),
      )
    }

    function ImageCard(props) {
      const block = props.block
      const cwd = props.cwd
      const settled = isSettled(block)
      const failed = settled && block.isError === true
      const images = react.useMemo(() => (failed ? [] : imagesOf(block, cwd)), [block, cwd, failed])
      const meta = react.useMemo(() => metaOf(block), [block])
      const prompt = react.useMemo(() => promptOf(block), [block])
      const [preview, setPreview] = react.useState(null)
      const [expanded, setExpanded] = react.useState(false)

      const closePreview = react.useCallback(() => setPreview(null), [])
      const stepPreview = react.useCallback(
        (delta) => {
          setPreview((current) => {
            if (current === null) return null
            const size = images.length
            if (size <= 1) return current
            return (current + delta + size) % size
          })
        },
        [images.length],
      )
      const summary = settled ? summaryOf(images, meta) : '正在生成…'
      const balance = typeof meta.balance_after === 'number' && meta.balance_after >= 0
        ? '余额 ' + meta.balance_after
        : ''

      const header = react.createElement(
        'div',
        { className: 'dai-head' },
        react.createElement('span', { className: 'dai-icon', 'aria-hidden': 'true' }, '▧'),
        react.createElement('span', { className: 'dai-title' }, '图片'),
        react.createElement('span', { className: 'dai-meta' }, summary),
        react.createElement('span', { className: 'dai-grow' }),
        balance !== '' ? react.createElement('span', { className: 'dai-hint' }, balance) : null,
      )

      let body = null
      if (!settled) {
        body = react.createElement('div', { className: 'dai-shimmer', 'aria-label': '正在生成图片' })
      } else if (failed) {
        body = react.createElement('div', { className: 'dai-error' }, textOf(block) || '生成失败')
      } else if (images.length === 0) {
        body = react.createElement('div', { className: 'dai-hint' }, '这条结果没有可预览的图片')
      } else {
        const shown = expanded ? images : images.slice(0, COLLAPSED_LIMIT)
        body = react.createElement(
          'div',
          { className: 'dai-grid' },
          shown.map((image) =>
            react.createElement(Thumb, { key: image.abs, image, onOpen: () => setPreview(images.indexOf(image)) }),
          ),
        )
      }

      const toggle = settled && !failed && images.length > COLLAPSED_LIMIT
        ? react.createElement(
            'button',
            { type: 'button', className: 'dai-more', onClick: () => setExpanded((value) => !value) },
            expanded ? '收起' : '展开全部 ' + images.length + ' 张',
          )
        : null

      const footer = images.length === 0 ? null : react.createElement(
        'div',
        { className: 'dai-foot' },
        images.slice(0, 3).map((image) =>
          react.createElement(
            'button',
            {
              key: 'p:' + image.abs,
              type: 'button',
              title: image.abs,
              onClick: () => {
                if (typeof props.openFile === 'function') props.openFile(image.abs)
              },
            },
            image.label,
          ),
        ),
        images.length > 3 ? react.createElement('span', null, '等 ' + images.length + ' 张') : null,
      )

      return react.createElement(
        'section',
        { className: 'dai-root', 'data-tool': TOOL_NAME, 'data-state': !settled ? 'running' : failed ? 'failed' : 'done' },
        header,
        prompt !== '' ? react.createElement('p', { className: 'dai-prompt', title: prompt }, prompt) : null,
        body,
        toggle,
        footer,
        preview !== null ? react.createElement(Lightbox, { images, index: preview, onClose: closePreview, onStep: stepPreview }) : null,
      )
    }

    /** 客户端插件入口：往 Tool 的 keyed 视图槽注册 generate_image 卡片。 */
    function apply(ctx) {
      ensureCss()
      const slots = ctx.slots !== undefined ? ctx.slots : typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (slots === undefined || slots === null) return

      const register = () => {
        try {
          return slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, ImageCard)
        } catch (error) {
          console.warn('[' + NS + '] tool.call.toolview 注册失败', error)
          return undefined
        }
      }

      if (typeof slots.inject === 'function') {
        slots.inject('tool.call.toolview', register)
        return
      }
      register()
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
