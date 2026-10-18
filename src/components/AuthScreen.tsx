// 登录 / 注册界面：没登录时，整个站点只有这一屏（门禁在 App.tsx）。
//
// 为什么登录和注册做成同一屏的两个标签页：
//   两者字段高度重合（用户名 + 密码），分成两个页面等于让界面在两者之间"跳一下"，
//   多一次转场、也多一处要维护的布局。标签页切换时只换字段和按钮文案。
//
// 为什么注册必须要邀请码：
//   这是个公开部署的网站，谁都能打开。允许自由注册等于允许任何人占云端的存储、
//   也等于"用户表"对全网开放。邀请码把"能不能注册"收回到管理员手里。

import { useState, type FormEvent } from 'react'
import {
  authErrorMessage,
  validateInviteCode,
  validatePassword,
  validateUsername,
} from '../lib/auth'
import { useAuth } from '../hooks/useAuth'

// 两个标签。value 同时决定"当前是哪个表单"和"提交时调哪个函数"。
const TABS = [
  { value: 'login', label: '登录' },
  { value: 'register', label: '注册' },
] as const

type Mode = (typeof TABS)[number]['value']

export default function AuthScreen() {
  const { login, register, lastError } = useAuth()

  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')      // 注册时的"再输一遍密码"
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 本屏自己产生的错误。auth 状态里那条（比如令牌过期导致的自动登出）也一起显示。
  const [error, setError] = useState('')

  const message = error || lastError
  const isRegister = mode === 'register'

  // 切换标签时把"只属于另一种模式"的输入清掉：
  // 否则从注册切回登录，密码框里还留着刚输入的注册密码，容易误提交。
  function switchMode(next: Mode) {
    if (next === mode) return
    setMode(next)
    setPassword('')
    setConfirm('')
    setInviteCode('')
    setError('')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // 表单默认行为是"提交并刷新整页"，必须拦下来 —— 我们是用 fetch 发请求的
    event.preventDefault()
    if (submitting) return

    // 先做本地检查，省一次白跑的网络往返；服务端还会再校验一遍（客户端规则不可信）
    if (mode === 'login') {
      if (username.trim() === '' || password === '') {
        setError('请输入用户名和密码')
        return
      }
    } else {
      // 用 || 串起来：越靠前的问题越先报，用户一次改一个就行
      const problem =
        validateUsername(username.trim()) ||
        validatePassword(password) ||
        (password === confirm ? '' : '两次输入的密码不一致') ||
        validateInviteCode(inviteCode.trim())
      if (problem) {
        setError(problem)
        return
      }
    }

    setError('')
    setSubmitting(true)
    try {
      if (isRegister) await register(username, password, inviteCode)
      else await login(username, password)
      // 成功后不用在这里跳转：App 订阅着登录状态，
      // 状态一变就会把这一屏换成"正在同步 → 主界面"。
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10 text-fg">
      <div className="card animate-rise w-full max-w-sm p-6">
        <header className="mb-5 text-center">
          <h1 className="text-2xl font-normal tracking-tight text-fg">
            <span aria-hidden="true">🔐</span> 我的工具箱
          </h1>
          <p className="mt-1.5 text-sm text-fg-muted">
            {isRegister
              ? '用管理员发的邀请码注册一个账号。'
              : '登录后，工具和收藏会跟着你的账号同步。'}
          </p>
        </header>

        {/* 标签页：外框一条描边，内部靠 gap-px 露出底色当作分隔线；
            选中项用主色淡底 + 主色文字，和「通用设置」里的主题切换是同一套做法。 */}
        <div className="mb-5 flex gap-px overflow-hidden rounded-btn border border-line bg-line">
          {TABS.map((tab, index) => {
            const active = mode === tab.value
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => switchMode(tab.value)}
                aria-pressed={active}
                className={
                  'flex-1 px-3 py-2 text-sm font-medium transition-colors ' +
                  (index === 0 ? 'rounded-l-[7px] ' : 'rounded-r-[7px] ') +
                  (active
                    ? 'bg-primary-soft text-primary'
                    : 'bg-surface text-fg-muted hover:bg-surface-2')
                }
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        <form onSubmit={handleSubmit}>
          <label className="block">
            <span className="block text-xs text-fg-subtle">用户名</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              placeholder={isRegister ? '3-32 位字母、数字、_ 或 -' : '输入用户名'}
              className="field field-boxed mt-1"
            />
          </label>

          <label className="mt-4 block">
            <span className="block text-xs text-fg-subtle">密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              // 登录时用"当前密码"、注册时用"新密码"：浏览器的密码管理器靠这个区分
              // 是"填一个已有密码"还是"生成并记住一个新密码"。
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              placeholder={isRegister ? '至少 8 位' : '输入密码'}
              className="field field-boxed mt-1"
            />
          </label>

          {isRegister && (
            <>
              <label className="mt-4 block">
                <span className="block text-xs text-fg-subtle">再输一遍密码</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  placeholder="确认两遍输入一致"
                  className="field field-boxed mt-1"
                />
              </label>

              <label className="mt-4 block">
                <span className="block text-xs text-fg-subtle">邀请码</span>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="向管理员要一串邀请码"
                  className="field field-boxed mt-1 font-mono"
                />
              </label>
            </>
          )}

          {message !== '' && (
            // 用 role="alert"：读屏器会立刻念出这条错误，不用用户自己去找
            <p role="alert" className="mt-4 rounded-btn bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger">
              {message}
            </p>
          )}

          <button type="submit" disabled={submitting} className="btn btn-primary mt-5 w-full">
            {submitting ? '请稍候…' : isRegister ? '注册并登录' : '登录'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs leading-relaxed text-fg-subtle">
          登录状态会记住 30 天。换账号或退出登录时，这台浏览器里缓存的工具数据会被清空
          （云端那份还在，重新登录就会拉回来）。
        </p>
      </div>
    </div>
  )
}
