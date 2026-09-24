import { useEffect, useState } from 'react'
import { View, Text, Input, Button, Canvas } from '@tarojs/components'
import Taro from '@tarojs/taro'
import type { ListWeightsResponse, WeightLog, WeightTrendResponse } from '@qsh/shared-types'

import { ApiClientError, apiRequest } from '../../lib/api'
import { useAuthStore } from '../../store/auth.store'
import { todayLocalKey } from '../../utils/date'
import './index.scss'

export default function WeightPage() {
  const status = useAuthStore((s) => s.status)
  const [weight, setWeight] = useState('')
  const [saving, setSaving] = useState(false)
  const [trend, setTrend] = useState<WeightTrendResponse | null>(null)
  const [recent, setRecent] = useState<WeightLog[]>([])
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const t = await apiRequest<WeightTrendResponse>('/weights/trend', {
        query: { days: 90 },
      })
      setTrend(t)
      const list = await apiRequest<ListWeightsResponse>('/weights', {
        query: { days: 30 },
      })
      setRecent(list.items.slice(0, 10))
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : '加载失败')
    }
  }

  useEffect(() => {
    if (status === 'authenticated') void load()
    if (status === 'anonymous') Taro.redirectTo({ url: '/pages/login/index' })
  }, [status])

  useEffect(() => {
    if (trend && trend.points.length) {
      // 等 canvas 渲染后再绘制
      const t = setTimeout(() => drawChart(trend), 60)
      return () => clearTimeout(t)
    }
  }, [trend])

  const save = async () => {
    setError('')
    const w = Number(weight)
    if (!w || w <= 0) {
      setError('请输入有效体重')
      return
    }
    setSaving(true)
    try {
      await apiRequest('/weights', {
        method: 'POST',
        body: { weightKg: w, loggedAt: todayLocalKey() },
      })
      setWeight('')
      Taro.showToast({ title: '已记录', icon: 'success' })
      void load()
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const drawChart = (t: WeightTrendResponse) => {
    Taro.createSelectorQuery()
      .select('#trend')
      .fields({ node: true, size: true })
      .exec((res: any) => {
        if (!res || !res[0] || !res[0].node) return
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const w = res[0].width
        const h = res[0].height
        const dpr = (Taro.getSystemInfoSync() as any).pixelRatio || 2
        canvas.width = w * dpr
        canvas.height = h * dpr
        ctx.scale(dpr, dpr)
        ctx.clearRect(0, 0, w, h)

        const pts = t.points
        if (pts.length < 2) {
          ctx.fillStyle = '#94a3b8'
          ctx.font = '12px sans-serif'
          ctx.fillText('记录 2 天以上才有趋势', 12, h / 2)
          return
        }
        const weights = pts.map((p) => p.weightKg)
        let min = Math.min(...weights)
        let max = Math.max(...weights)
        const pad = (max - min) * 0.15 || 1
        min -= pad
        max += pad
        const padL = 36
        const padR = 16
        const padT = 16
        const padB = 24
        const plotW = w - padL - padR
        const plotH = h - padT - padB
        const x = (i: number) => padL + (i / (pts.length - 1)) * plotW
        const y = (v: number) =>
          padT + (1 - (v - min) / (max - min || 1)) * plotH

        // 坐标基线
        ctx.strokeStyle = '#334155'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(padL, padT)
        ctx.lineTo(padL, padT + plotH)
        ctx.lineTo(padL + plotW, padT + plotH)
        ctx.stroke()

        // 原始体重点连线（绿）
        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 3
        ctx.beginPath()
        pts.forEach((p, i) => {
          const px = x(i)
          const py = y(p.weightKg)
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        })
        ctx.stroke()

        // 7 日移动平均（灰虚线）
        const ma = t.movingAverage7
        ctx.strokeStyle = '#94a3b8'
        ctx.lineWidth = 2
        ctx.setLineDash([6, 6])
        ctx.beginPath()
        let started = false
        ma.forEach((m, i) => {
          if (m.value == null) return
          const px = x(i)
          const py = y(m.value)
          if (!started) {
            ctx.moveTo(px, py)
            started = true
          } else {
            ctx.lineTo(px, py)
          }
        })
        ctx.stroke()
        ctx.setLineDash([])

        // 顶点标注
        ctx.fillStyle = '#94a3b8'
        ctx.font = '11px sans-serif'
        ctx.fillText(String(Math.round(max)), 2, padT + 10)
        ctx.fillText(String(Math.round(min)), 2, padT + plotH)
      })
  }

  return (
    <View className="container">
      <Text className="title">体重</Text>

      <View className="card">
        <Text className="label">今日体重 (kg)</Text>
        <Input
          className="input"
          value={weight}
          onInput={(e) => setWeight(e.detail.value)}
          type="digit"
        />
        <View style={{ height: '20rpx' }} />
        <Button className="btn" loading={saving} disabled={saving} onClick={save}>
          记录
        </Button>
        {error ? <Text className="error">{error}</Text> : null}
      </View>

      <View className="card">
        <Text className="label">近 90 天趋势（绿：每日 · 灰虚线：7 日平均）</Text>
        <Canvas type="2d" id="trend" className="chart" />
      </View>

      <View className="card">
        <Text className="label">最近记录</Text>
        {recent.length === 0 ? (
          <Text className="muted">暂无</Text>
        ) : (
          recent.map((r) => (
            <View className="row between" key={r.id} style={{ padding: '10rpx 0' }}>
              <Text className="muted">{r.loggedAt}</Text>
              <Text>{r.weightKg} kg</Text>
            </View>
          ))
        )}
      </View>
    </View>
  )
}
