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
      borderRadius: {
        '3xl': '1.5rem',
        // 更饱满的圆角，弱化「仪表盘」的方正感
        xl2: '1.75rem',
      },
      boxShadow: {
        // 柔和、低透明度、大扩散：暖色卡片轻轻浮起，而不是「面板」的硬边
        soft: '0 12px 32px -12px rgba(31, 41, 55, 0.14), 0 4px 12px -6px rgba(31, 41, 55, 0.08)',
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
