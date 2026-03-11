import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'AI Dodge Prototype Editor',
  description: 'Demo-first AI-native 2D game prototype editor',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
