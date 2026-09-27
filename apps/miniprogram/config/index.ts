import { defineConfig } from '@tarojs/cli'
import path from 'path'

// 复用 monorepo 内两个纯 TS 包（@qsh/core 引擎 / @qsh/shared-types 契约）。
// 它们 main 指向 ./src/index.ts，需让 Taro 的 babel 一并转译。
const repoRoot = path.resolve(__dirname, '..', '..')
const pkgCore = path.join(repoRoot, 'packages', 'core')
const pkgShared = path.join(repoRoot, 'packages', 'shared-types')
// 本工程源码目录：必须与上面两个包**一起**写进 script 规则的 include，见下方注释。
const appSrc = path.resolve(__dirname, '..', 'src')

const config = defineConfig({
  projectName: 'qingshenghuo-miniprogram',
  date: '2026-9-22',
  designWidth: 750,
  deviceRatio: { 640: 2.34 / 2, 750: 1, 828: 1.81 / 2 },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: [],
  defineConstants: {},
  copy: { patterns: [], options: {} },
  framework: 'react',
  compiler: 'webpack5',
  mini: {
    webpackChain(chain) {
      // ⚠️ 这里**必须**把本工程 src 也加进去。
      // webpack 的 `include` 语义是「只匹配列出的路径」（不是「额外追加」）：
      // 只 .add(pkgCore).add(pkgShared) 会让 script 规则（babel-loader）不再匹配 src/**，
      // 页面 .tsx 便没有 babel-loader、只剩 MiniPlugin 注入的 taro-loader/lib/page，
      // 于是被 webpack 的 acorn 解析器当普通 JS 解析 → `import type {` 直接
      // "SyntaxError: Unexpected token (4:12)"（6 个页面模块全炸）。
      // 三个路径合并后：src/** 与两个 workspace 包都走 babel（babel.config.js 里 ts: true）。
      chain.module
        .rule('script')
        .include.add(appSrc)
        .add(pkgCore)
        .add(pkgShared)
    },
    postcss: {
      pxtransform: { enable: true },
      cssModules: { enable: false },
    },
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
  },
})

export default config
