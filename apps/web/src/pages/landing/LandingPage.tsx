import type { ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import CalorieCalculator from '@/components/common/CalorieCalculator';
import LoginCard from '@/components/common/LoginCard';
import { useAuthStore } from '@/lib/auth.store';

const HIGHLIGHTS: ReadonlyArray<{ title: string; desc: string }> = [
  { title: '3 次点击记一餐', desc: '搜索 + 常见份量，记录不再是负担。' },
  { title: '科学可溯源', desc: '基于 Mifflin-St Jeor 公式，强制安全下限与缺口上限。' },
  { title: '无负罪感设计', desc: '断签不惩罚，用趋势而不是单日波动评价你。' },
];

/**
 * 落地页（`/`）：产品介绍 + 隐私承诺 + 免责声明 + 免注册试用计算器（US-01 / US-02 / R10.5）。
 *
 * 登录入口（审查后补）：此前登录卡片只存在于「我的」页，新访客从落地页无法进入应用 ——
 * 现在登录卡片直接内嵌落地页，登录成功即跳转今日看板。
 */
export default function LandingPage(): ReactElement {
  const accessToken = useAuthStore((state) => state.accessToken);
  const navigate = useNavigate();

  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <header className="text-center">
        <p className="inline-block rounded-full bg-brand-100 px-3 py-1 text-xs font-medium text-brand-700">
          不节食 · 不极端 · 融进日常
        </p>
        <h1 className="mt-4 text-3xl font-bold leading-tight text-slate-900 sm:text-4xl">轻生活</h1>
        <p className="mx-auto mt-3 max-w-xl text-base text-slate-600">
          一款把减肥融入日常的中文工具：科学热量预算、低门槛饮食记录、温和的习惯养成。
        </p>
      </header>

      <section className="mt-8 grid gap-3 sm:grid-cols-3">
        {HIGHLIGHTS.map((item) => (
          <div key={item.title} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-brand-100">
            <h3 className="text-sm font-semibold text-slate-800">{item.title}</h3>
            <p className="mt-1 text-sm text-slate-500">{item.desc}</p>
          </div>
        ))}
      </section>

      <section aria-label="登录或注册" className="mt-10 rounded-2xl bg-white p-6 shadow-sm">
        {accessToken ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-slate-600">已经登录，欢迎回来 👋</p>
            <Link
              to="/dashboard"
              className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-medium text-white"
            >
              进入今日看板
            </Link>
            <Link to="/tools" className="text-xs text-slate-500 underline">
              先随便逛逛生活化工具
            </Link>
          </div>
        ) : (
          <>
            <h2 className="text-base font-semibold text-slate-800">开始使用（邮箱验证码登录，未注册自动创建）</h2>
            <div className="mt-4">
              <LoginCard
                onSuccess={(payload) =>
                  navigate(payload.onboardingCompleted ? '/dashboard' : '/onboarding')
                }
              />
            </div>
          </>
        )}
      </section>

      <div className="mt-10">
        <CalorieCalculator />
      </div>

      <section
        aria-label="隐私承诺"
        className="mt-10 rounded-2xl border border-brand-100 bg-white p-6"
      >
        <h2 className="text-base font-semibold text-slate-800">我们的隐私承诺</h2>
        <ul className="mt-3 space-y-2 text-sm text-slate-600">
          <li>· 不出售你的任何数据</li>
          <li>· 不接入广告 SDK</li>
          <li>· 不使用第三方行为分析</li>
          <li>· 你的数据随时可以导出带走、也可以彻底删除</li>
        </ul>
      </section>

      <footer className="mt-8 rounded-2xl bg-slate-100 p-5 text-xs leading-relaxed text-slate-500">
        <p className="font-medium text-slate-600">免责声明</p>
        <p className="mt-1">
          本产品不提供医疗建议。孕期、哺乳期、疾病治疗期人群不建议使用热量缺口方案，请先咨询专业医师。
          计算结果仅用于健康生活参考，不能替代专业诊断与治疗。
        </p>
      </footer>
    </main>
  );
}
