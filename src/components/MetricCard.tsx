import React from 'react';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: number;
  icon?: string;
}

const MetricCard: React.FC<MetricCardProps> = ({ title, value, subtitle, trend, icon }) => {
  const trendColor = trend !== undefined ? (trend >= 0 ? 'text-green-600' : 'text-red-500') : '';
  const trendPrefix = trend !== undefined && trend >= 0 ? '+' : '';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500 font-medium">{title}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
          {trend !== undefined && (
            <p className={`text-xs font-medium mt-1 ${trendColor}`}>
              {trendPrefix}{trend}% vs last period
            </p>
          )}
        </div>
        {icon && (
          <span className="text-2xl p-2 bg-indigo-50 rounded-lg">{icon}</span>
        )}
      </div>
    </div>
  );
};

export default MetricCard;
