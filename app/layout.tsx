import type { Metadata } from 'next';
import './globals.css';
import '../cloud/public/static/assistant.css';
import '../cloud/public/static/rail-theme.css';

export const metadata: Metadata = {
  title: '同车余票 · 12306 余票与中转助手',
  description: '查询实时铁路余票，比较直达、同车分段与一次异车中转的票价和总用时。',
  icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
