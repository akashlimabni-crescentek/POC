import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Prediction Market POC',
  description: 'Polymarket + Kalshi data via Supabase',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="site-title">
              Prediction Market POC
            </Link>
            <span className="muted" style={{ fontSize: '0.875rem' }}>
              Supabase direct reads
            </span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
