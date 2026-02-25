import React from 'react';
import { NavLink } from 'react-router-dom';

const navItems = [
  { path: '/', label: 'Dashboard', icon: '🏠' },
  { path: '/bi', label: 'Business Intelligence', icon: '📊' },
  { path: '/sales', label: 'Sales', icon: '💰' },
  { path: '/marketing', label: 'Marketing', icon: '📣' },
  { path: '/it', label: 'IT', icon: '🖥️' },
  { path: '/finance', label: 'Finance', icon: '🧾' },
  { path: '/content', label: 'Content', icon: '📝' },
];

const Sidebar: React.FC = () => {
  return (
    <aside className="w-64 min-h-screen bg-gray-900 text-white flex flex-col">
      <div className="px-6 py-5 border-b border-gray-700">
        <h1 className="text-xl font-bold tracking-tight">GCI Command Center</h1>
        <p className="text-xs text-gray-400 mt-1">ops.gcitires.com</p>
      </div>
      <nav className="flex-1 px-4 py-4 space-y-1">
        {navItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`
            }
          >
            <span>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
};

export default Sidebar;
