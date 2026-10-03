import { createFileRoute, ClientOnly } from '@tanstack/react-router'
import { LiegeMobile } from '@/liege-app/LiegePage'

export const Route = createFileRoute('/mobile')({
  head: () => ({ meta: [{ title: 'Liege for Android — Liege' }, { name: 'description', content: 'The Liege Android companion for mobile-safe monitoring and approvals.' }] }),
  component: () => <ClientOnly><LiegeMobile /></ClientOnly>,
})
