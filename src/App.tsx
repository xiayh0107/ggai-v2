import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router'

const Workspace = lazy(() => import('./pages/Workspace'))
const Home = lazy(() => import('./pages/Home'))
const NodeStudio = lazy(() => import('./pages/NodeStudio'))
const ResourceLibrary = lazy(() => import('./pages/ResourceLibrary'))

export default function App() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Workspace />} />
        <Route path="/canvas" element={<Home />} />
        <Route path="/node-studio" element={<NodeStudio />} />
        <Route path="/resources" element={<ResourceLibrary />} />
        <Route path="/resources/generated" element={<ResourceLibrary />} />
        <Route path="/resources/skills" element={<ResourceLibrary />} />
      </Routes>
    </Suspense>
  )
}

function RouteLoading() {
  return (
    <main
      role="status"
      aria-label="正在打开页面"
      className="flex min-h-screen items-center justify-center bg-gg-bg text-[12px] text-gg-muted"
    >
      正在打开…
    </main>
  )
}
