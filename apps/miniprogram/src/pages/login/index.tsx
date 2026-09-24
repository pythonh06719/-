import { useEffect, useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { ApiClientError } from '../../lib/api'
import { useAuthStore } from '../../store/auth.store'
import './index.scss'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export default function LoginPage() {
  const status = useAuthStore((s) => s.status)
  const sendCode = useAuthStore((s) => s.sendCode)
  const verifyCode = useAuthStore((s) => s.verifyCode)

  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [hint, setHint] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (status === 'authenticated') {
      Taro.switchTab({ url: '/pages/dashboard/index' })
    }
  }, [status])

  const onSend = async () => {
    setError('')
    if (!EMAIL_RE.test(email)) {
      setError('请输入有效邮箱')
      return
    }
    setSending(true)
    try {
      const res = await sendCode(email)
      if (res.code) {
        setCode(res.code)
        setHint(`开发模式已返回验证码：${res.code}（${res.expiresInSeconds}s 内有效）`)
      } else {
        setHint(`验证码已发送至 ${email}（${res.expiresInSeconds}s 内有效）`)
      }
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : '发送失败，请稍后重试')
    } finally {
      setSending(false)
    }
  }

  const onVerify = async () => {
    setError('')
    if (!code.trim()) {
      setError('请输入验证码')
      return
    }
    setVerifying(true)
    try {
      const res = await verifyCode(email, code.trim())
      Taro.showToast({ title: '登录成功', icon: 'success' })
      if (!res.onboardingCompleted) {
        Taro.redirectTo({ url: '/pages/onboarding/index' })
      } else {
        Taro.switchTab({ url: '/pages/dashboard/index' })
      }
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : '登录失败，请稍后重试')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <View className="container login">
      <View className="login-head">
        <Text className="login-title">轻生活</Text>
        <Text className="muted">记下每一口，慢慢瘦下来</Text>
      </View>

      <View className="card">
        <Text className="label">邮箱</Text>
        <Input
          className="input"
          value={email}
          onInput={(e) => setEmail(e.detail.value)}
          placeholder="you@example.com"
          placeholderClass="ph"
        />
        <View style={{ height: '24rpx' }} />
        <Button
          className="btn btn-ghost"
          loading={sending}
          disabled={sending}
          onClick={onSend}
        >
          {sending ? '发送中…' : '发送验证码'}
        </Button>
        {hint ? (
          <Text className="muted" style={{ display: 'block', marginTop: '16rpx' }}>
            {hint}
          </Text>
        ) : null}
      </View>

      <View className="card">
        <Text className="label">验证码</Text>
        <Input
          className="input"
          value={code}
          onInput={(e) => setCode(e.detail.value)}
          placeholder="6 位数字"
          type="number"
          maxlength={6}
        />
        <View style={{ height: '24rpx' }} />
        <Button
          className="btn"
          loading={verifying}
          disabled={verifying}
          onClick={onVerify}
        >
          {verifying ? '登录中…' : '登录 / 注册'}
        </Button>
        {error ? <Text className="error">{error}</Text> : null}
      </View>

      <Text className="muted" style={{ textAlign: 'center', marginTop: '8rpx' }}>
        新邮箱将自动注册账号
      </Text>
    </View>
  )
}
