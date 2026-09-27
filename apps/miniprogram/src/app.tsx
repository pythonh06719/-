import { PropsWithChildren, useEffect } from 'react'
import { useAuthStore } from './store/auth.store'
// 全局样式必须挂在 app 上（页面级 wxss 不共享），否则这些类在产物里根本不存在：
// - styles/global.scss：.container/.card/.btn/.input/.label/.tag/.muted/.error … 各页都在用；
// - app.scss：page 的暗色背景与字体（不引入则 dist 里不会产出 app.wxss）。
import './styles/global.scss'
import './app.scss'

export default function App({ children }: PropsWithChildren) {
  const bootstrap = useAuthStore((s) => s.bootstrap)
  useEffect(() => {
    void bootstrap()
  }, [bootstrap])
  return <>{children}</>
}
