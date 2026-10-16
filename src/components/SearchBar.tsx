// 搜索框组件。
// 它是"受控组件"：自身不保存内容，值由父组件传入，改动通过 onChange 通知父组件。

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
}

export default function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-fg-subtle">
        🔍
      </span>
      {/* field 是 Google 的"填充式"输入框：浅底、无四周描边、底部一条细线，
          聚焦时底色加深 + 底线变蓝加粗。比四周描边框更像 Google 产品。 */}
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="搜索工具名称或说明…"
        className="field pl-10"
      />
    </div>
  )
}
