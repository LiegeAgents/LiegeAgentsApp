import React, { lazy, Suspense, useEffect } from 'react'
import Home, { ThemeProvider } from './Site'
const Workspace = lazy(() => import('./Workspace'))
import Docs from './Docs'
const Marketplace = lazy(() => import('./Marketplace'))
import { WalletProvider } from './wallet/Wallet'
import './brand-social.css'
import './liege.css'
import './workspace-premium.css'
import './hero-centered.css'
const ReferencePage = lazy(() => import('./ReferencePage'))
const Roadmap = lazy(() => import('./Roadmap'))
const Whitepaper = lazy(() => import('./Whitepaper'))

const BODY_CLASSES =
  'geist_mono_1bf8cbf6-module__FlyLvG__variable inter_83a5a2e-module__LLhbsa__variable papermono_aa9e121d-module__lcvVkq__variable arizonaflare_e3e8b677-module__PbqaBq__variable'

function Shell({ children }) {
  useEffect(() => {
    document.body.className = BODY_CLASSES
  }, [])
  return (
    <ThemeProvider>
      <WalletProvider>
        <Suspense fallback={<div className="loading-state">Opening Liege…</div>}>{children}</Suspense>
      </WalletProvider>
    </ThemeProvider>
  )
}

export function LiegeHome() {
  return (
    <Shell>
      <Home />
    </Shell>
  )
}

export function LiegeMarketplace() {
  return (
    <Shell>
      <Marketplace />
    </Shell>
  )
}

export function LiegeWorkspace() {
  return (
    <Shell>
      <Workspace />
    </Shell>
  )
}

export function LiegeDocs() {
  return (
    <Shell>
      <Docs />
    </Shell>
  )
}

export function LiegeRoadmap() {
  return (
    <Shell>
      <Roadmap />
    </Shell>
  )
}

export function LiegeWhitepaper() {
  return (
    <Shell>
      <Whitepaper />
    </Shell>
  )
}

export function LiegeBaseline() {
  useEffect(() => {
    document.body.className = BODY_CLASSES
  }, [])
  return (
    <Suspense fallback={<div className="loading-state">Loading the original-copy checkpoint…</div>}>
      <ReferencePage />
    </Suspense>
  )
}
