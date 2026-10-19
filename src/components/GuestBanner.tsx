// 顶部只读横幅：访客模式下常驻页面最上方，交代"看可以、改不行"，并给一个去登录的出口。
//
// 为什么要一条常驻横幅，而不是只在登录页提示一次：
//   访客是从登录页走进来的，过一会儿就忘了自己"没登录"。这时看到「新建工具」点不动，
//   只会以为网站坏了。横幅是唯一能一直待在那儿解释这件事的东西。
//
// 为什么用 fixed，而由 App 垫一格空白给它让位：
//   各模块都是整屏滚动，横幅要始终贴着视口顶部才不会滚走 → 用 fixed。
//   代价是它会盖住页面最上面那一条，所以 App.tsx 在它下面垫了一个 h-10 的空占位，
//   把主界面整体顶下来 40px，正好落在横幅下沿。
//   ⚠️ 这里的 h-10 和 App.tsx 里的 h-10 必须一致，改一个就要改另一个。
//
// 颜色只用设计令牌（bg-primary-soft / text-primary / border-line）：
// 它们是 CSS 变量，浅色和深色主题各自有一套，写死颜色在深色模式下会糊成一片。

import { useGuest } from '../hooks/useGuest'

export default function GuestBanner() {
  const { exitGuest } = useGuest()

  function handleLogin() {
    // 先清掉访客标记，再整页刷新。
    //
    // 只清标记不刷新也能用（App 订阅着这个标记，会当场退回登录页），
    // 但同步引擎、文件列表这些模块里还留着"上一次会话"的内存状态；
    // 刷新一次能把它们一起清干净，回到最干净的登录页。
    exitGuest()
    window.location.reload()
  }

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex h-10 items-center justify-between gap-3 border-b border-line bg-primary-soft px-4 text-xs text-primary">
      {/* truncate：极窄的屏幕上宁可把提示省略，也不让它折行撑高 ——
          高度一变，App 里垫的那 40px 就对不上了 */}
      <span className="truncate">👀 访客预览模式 · 只能查看，不能修改</span>

      <button type="button" onClick={handleLogin} className="btn btn-sm btn-text shrink-0">
        去登录
      </button>
    </div>
  )
}
