import type { Metadata } from 'next'
import './globals.css'
import { botConfig } from '@/config/bot-config'

export const metadata: Metadata = {
  title: botConfig.metadata.title,
  description: botConfig.metadata.description,
  icons: {
    icon: botConfig.metadata.icon || '/assets/logo.png',
    apple: botConfig.metadata.icon || '/assets/logo.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang={botConfig.language}>
      <body>{children}</body>
    </html>
  )
}
