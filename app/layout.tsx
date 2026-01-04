import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Vollen Bot - RAG Chat',
  description: 'Chat med Vollen Opplevelser ved hjelp av RAG',
  icons: {
    icon: '/assets/logo.png',
    apple: '/assets/logo.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  )
}
