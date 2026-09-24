import { useEffect, useState } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import type { DashboardResponse } from '@qsh/shared-types'

import { ApiClientError, apiRequest } from '../../lib/api'
import { useAuthStore } from '../../store/auth.store'
import './index.scss'

export default function DashboardPage() {
  const status = useAuthStore((s) => s.status)
  const logout = useAuthStore((s) => s.logout)
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const d = await apiRequest<DashboardResponse>('/dashboard')
      setData(d)
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (status === 'authenticated') void load()
    if (status === 'anonymous') Taro.redirectTo({ url: '/pages/login/index' })
  }, [status])

  if (loading) {
    return (
      <View className="container">
        <Text className="muted">加载中…</Text>
      </View>
    )
  }
  if (error) {
    return (
      <View className="container">
        <Text className="error">{error}</Text>
        <Button className="btn btn-ghost" onClick={load}>
          重试
        </Button>
      </View>
    )
  }
  if (!data) return null

  if (!data.goal || !data.budget) {
    return (
      <View className="container">
        <Text className="title">先完善资料</Text>
        <Text className="muted" style={{ marginTop: '12rpx' }}>
          设置目标后才有每日热量预算
        </Text>
        <View style={{ height: '32rpx' }} />
        <Button
          className="btn"
          onClick={() => Taro.navigateTo({ url: '/pages/onboarding/index' })}
        >
          去完善资料
        </Button>
      </View>
    )
  }

  const ratio = Math.min(Math.max(data.progressRatio, 0), 1)
  const over = data.remainingKcal < 0

  return (
    <View className="container">
      <View className="row between" style={{ marginBottom: '8rpx' }}>
        <Text className="title">今日</Text>
        <Text
          className="logout"
          onClick={() => {
            logout()
            Taro.redirectTo({ url: '/pages/login/index' })
          }}
        >
          退出
        </Text>
      </View>

      <View className="card remain">
        <Text className="muted">今日还可吃</Text>
        <View className="remain-num">
          <Text
            style={{
              fontSize: '72rpx',
              fontWeight: '700',
              color: over ? '#fca5a5' : '#22c55e',
            }}
          >
            {Math.round(Math.abs(data.remainingKcal))}
          </Text>
          <Text className="muted" style={{ marginLeft: '8rpx' }}>
            kcal
          </Text>
        </View>
        <Text className="muted">
          {over ? '已超出预算，明天轻一点就好' : data.encouragement}
        </Text>
      </View>

      <View className="card">
        <View className="row between">
          <Text className="muted">已吃 {Math.round(data.intakeKcal)} kcal</Text>
          <Text className="muted">预算 {data.budget.intakeRecommended} kcal</Text>
        </View>
        <View className="bar">
          <View
            className="bar-fill"
            style={{
              width: `${ratio * 100}%`,
              background: over ? '#ef4444' : '#22c55e',
            }}
          />
        </View>
      </View>

      <View className="actions">
        <Button className="btn" onClick={() => Taro.switchTab({ url: '/pages/diary/index' })}>
          记饮食
        </Button>
        <View style={{ width: '24rpx' }} />
        <Button
          className="btn btn-ghost"
          onClick={() => Taro.switchTab({ url: '/pages/weight/index' })}
        >
          记体重
        </Button>
      </View>
    </View>
  )
}
