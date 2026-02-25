import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './Dashboard';
import BusinessIntelligence from './departments/BusinessIntelligence';
import Sales from './departments/Sales';
import Marketing from './departments/Marketing';
import IT from './departments/IT';
import Finance from './departments/Finance';
import Content from './departments/Content';

function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-gray-50">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/bi" element={<BusinessIntelligence />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/marketing" element={<Marketing />} />
            <Route path="/it" element={<IT />} />
            <Route path="/finance" element={<Finance />} />
            <Route path="/content" element={<Content />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
