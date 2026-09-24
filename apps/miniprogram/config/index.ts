import { defineConfig } from '@tarojs/cli'
import path from 'path'

// 复用 monorepo 内两个纯 TS 包（@qsh/core 引擎 / @qsh/shared-types 契约）。
// 它们 main 指向 ./src/index.ts，需让 Taro 的 babel 一并转译。
const repoRoot = path.resolve(__dirname, '..', '..')
const pkgCore = path.join(repoRoot, 'packages', 'core')
const pkgShared = path.join(repoRoot, 'packages', 'shared-types')

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
      chain.module
        .rule('script')
        .include.add(pkgCore)
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
