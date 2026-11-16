/**
 * 把 dist-single 的入口脚本、样式内联进 index.html，产出可单独分发的单文件页面。
 *
 * 单文件模式下 rspack 已把异步 chunk 合并进入口、字体转成 data URI，这里只处理
 * 外链的 <script src> 与 <link rel="stylesheet">，并删掉不再需要的 static 目录。
 */
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const dir = path.resolve('dist-single')
const htmlPath = path.join(dir, 'index.html')
const readAsset = (href) => readFile(path.join(dir, href.replace(/^\.?\//, '')), 'utf8')

let html = await readFile(htmlPath, 'utf8')

// 样式保留在 head；脚本统一移到 body 末尾：内联脚本没有 defer，放在 head 会早于 #root 执行
for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
  if (!/\brel="stylesheet"/.test(tag)) {
    continue
  }
  const href = /\bhref="([^"]+)"/.exec(tag)?.[1]
  if (!href) {
    continue
  }
  const css = await readAsset(href)
  // 函数形式替换：资源里的 $&、$' 等序列会被 String.replace 当成替换模式
  html = html.replace(tag, () => `<style>${css}</style>`)
}

const scripts = []
for (const tag of html.match(/<script\b[^>]*><\/script>/g) ?? []) {
  const src = /\bsrc="([^"]+)"/.exec(tag)?.[1]
  if (!src) {
    continue
  }
  scripts.push(await readAsset(src))
  html = html.replace(tag, () => '')
}

const inline = scripts
  // 代码里若出现 </script（模板字符串、正则等），需转义，否则会提前结束标签
  .map((code) => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`)
  .join('')
html = html.replace('</body>', () => `${inline}</body>`)

await writeFile(htmlPath, html)
await rm(path.join(dir, 'static'), { recursive: true, force: true })

const { size } = await stat(htmlPath)
console.log(
  `单文件已生成：${path.relative(process.cwd(), htmlPath)}（${(size / 1024 / 1024).toFixed(2)} MB）`
)
