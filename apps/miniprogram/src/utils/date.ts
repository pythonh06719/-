/** 本地时区日期键 `YYYY-MM-DD`（与后端 todayLocalKey 对齐）。 */
export function todayLocalKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 把 `YYYY-MM-DD` 转成 `M月D日` 展示。 */
export function prettyDate(key: string): string {
  const [, m, d] = key.split('-')
  return `${Number(m)}月${Number(d)}日`
}
