import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell/Shell';
import { DataProvider } from '@/lib/data/provider';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Eleven',
    template: '%s, Eleven',
  },
  description:
    'Live dashboard and partner phone view for Eleven, a screenless reply and errand assistant for people who cannot speak or use their hands.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#050505',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <DataProvider>
          <Shell>{children}</Shell>
        </DataProvider>
      </body>
    </html>
  );
}
