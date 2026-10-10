// 这是整个网页的入口文件。
// 它做的事：找到 index.html 里的 <div id="root">，把 <App /> 渲染进去。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// document.getElementById('root')! 末尾的 ! 表示"我确定它存在"
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
