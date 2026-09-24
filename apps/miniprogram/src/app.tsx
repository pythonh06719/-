import { PropsWithChildren, useEffect } from 'react'
import { useAuthStore } from './store/auth.store'

export default function App({ children }: PropsWithChildren) {
  const bootstrap = useAuthStore((s) => s.bootstrap)
  useEffect(() => {
    void bootstrap()
  }, [bootstrap])
  return <>{children}</>
}
