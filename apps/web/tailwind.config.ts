import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 深色模式：跟随系统或手动切换，通过 <html class="dark"> 生效（R2 / NFR-8）
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 温和、无焦虑的品牌色（避免红色恐吓语义）
        brand: {
          50: '#f0f7f4',
          100: '#d9ede4',
          200: '#b6ddc9',
          300: '#8cc9ab',
          400: '#4fbf94',
          500: '#2f9e78',
          600: '#248263',
          700: '#1c6a51',
          800: '#155040',
          900: '#0f3a2e',
        },
        // 柔和暖色：用于「接近上下限」等中性提醒，绝不用刺目的红（PRD §7）
        coral: {
          50: '#fdf3ef',
          100: '#fbe3d9',
          200: '#f6c4b1',
          300: '#eda184',
          400: '#e07a56',
          500: '#c95f3b',
          600: '#a84a2d',
          700: '#853a23',
          800: '#5f2a1a',
          900: '#3d1c12',
        },
        // 生活暖色（蜂蜜 / 燕麦）：用于「过日子」气质的动作卡与摘要（基调 #f7b955）
        warm: {
          50: '#fef7ea',
          100: '#fdeccd',
          200: '#fbd89c',
          300: '#f8c06b',
          400: '#f7b955',
          500: '#eaa032',
          600: '#cf8320',
          700: '#a8631a',
          800: '#7f4a17',
          900: '#5c3614',
        },
        // 奶油底色：暖白背景，替代冷调纯白，让页面更像「家里的一角」
        cream: {
          DEFAULT: '#fdfaf5',
          50: '#fefcf8',
          100: '#fdfaf5',
          200: '#f7efe3',
          300: '#efe3cf',
        },
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
      },
      /**
       * 圆角语义层：用「用途」而非「数值」命名，避免同语义的多档圆角混用。
       * 为什么保留 `3xl` / `xl2`：既有代码仍在用（底部弹层 / 少数历史值），删了会静默改外观；
       * 新写的代码一律用下面四个语义 token。
       */
      borderRadius: {
        /** 卡片表面（≈ rounded-2xl）：普通卡片、行动卡 */
        card: '1rem',
        /** 控件（≈ rounded-xl）：按钮、输入框、小型触发元素 */
        control: '0.75rem',
        /** 胶囊：标签、 Chip */
        pill: '9999px',
        /** 底部弹层 / 抽屉（≈ xl2）：比卡片更饱满，视觉上「浮在最上层」 */
        sheet: '1.75rem',
        '3xl': '1.5rem',
        // 更饱满的圆角，弱化「仪表盘」的方正感
        xl2: '1.75rem',
      },
      /**
       * elevation 四级（0~3）。气质与既有 `soft` 一致：**低透明度 + 大扩散**，
       * 像纸轻轻浮在奶油背景上，而非 dashboard 的硬边面板。
       *
       * 值为 CSS 变量（浅色值写在 `styles/index.css` 的 `:root`，深色值在 `theme/dark.css` 覆盖）：
       * 深色下阴影几乎不可见，必须整体换成「内高光 + 少量真实阴影」的表达，
       * 用变量可以让**同一个 utility 在两套主题里各自成立**，调用方不必写 `dark:` 变体。
       */
      boxShadow: {
        /** 0 级：贴地 / 无浮起（显式写 none，避免残留父级阴影） */
        'qsh-0': 'none',
        /** 1 级：静止卡片 —— 只是把边界交代清楚，不抢内容 */
        'qsh-1': 'var(--qsh-shadow-1)',
        /** 2 级：hover 浮起 / 悬浮层（下拉、气泡） */
        'qsh-2': 'var(--qsh-shadow-2)',
        /** 3 级：弹窗 / 底部抽屉 —— 明确压在页面之上 */
        'qsh-3': 'var(--qsh-shadow-3)',
        // 柔和、低透明度、大扩散：暖色卡片轻轻浮起，而不是「面板」的硬边
        //
        // ⚠️ 已弃用：等价于新的 elevation-2（`qsh-2`）。保留是为了不让既有代码静默变样，
        //    新写的样式请用 `shadow-qsh-2`（深色模式下它会自动换成深色版 elevation）。
        soft: 'var(--qsh-shadow-2)',
      },
      /**
       * 动效时长三档：快反馈 / 常规状态切换 / 慢（大块内容进出）。
       * 为什么只有三档：时长种类越多越难保持一致节奏，这三档足以覆盖全站交互。
       */
      transitionDuration: {
        'qsh-fast': '120ms',
        'qsh-base': '200ms',
        'qsh-slow': '320ms',
      },
      /**
       * 统一缓动：与加载屏叶片生长动画同源（`index.html` 的 `cubic-bezier(.22,.68,.28,1)`），
       * 末端切线接近水平 → 减速自然、不停顿，全站动效语言因此统一。
       */
      transitionTimingFunction: {
        'qsh-out': 'cubic-bezier(.22,.68,.28,1)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out both',
      },
    },
  },
  plugins: [],
};

export default config;
