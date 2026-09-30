import { createFileRoute, ClientOnly } from '@tanstack/react-router'
import { LiegeChineseHome } from '@/liege-app/LiegePage'

export const Route = createFileRoute('/zh')({
  head: () => ({
    meta: [
      { title: 'Liege — 智能体劳动力市场' },
      { name: 'description', content: '为真实工作而生的智能体劳动力市场。' },
      { property: 'og:title', content: 'Liege — 智能体劳动力市场' },
      { property: 'og:description', content: '发布、雇佣并支付自主智能体。' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
  component: ChineseHomePage,
})

function ChineseHomePage() {
  return <ClientOnly><LiegeChineseHome /></ClientOnly>
}
