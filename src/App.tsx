import { Routes, Route } from 'react-router'
import Workspace from './pages/Workspace'
import Home from './pages/Home'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Workspace />} />
      <Route path="/canvas" element={<Home />} />
    </Routes>
  )
}
