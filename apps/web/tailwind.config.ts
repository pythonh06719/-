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
