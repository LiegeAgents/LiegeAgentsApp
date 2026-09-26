import React,{lazy,Suspense,useEffect} from 'react'
import Home,{ThemeProvider} from './Site'
const Workspace=lazy(()=>import('./Workspace'))
import Docs from './Docs'
const Marketplace=lazy(()=>import('./Marketplace'))
import {WalletProvider} from './wallet/Wallet'
import './brand-social.css'
import {Button} from './UI'
import {Brand} from './ProductArt'
import './liege.css'
import './workspace-premium.css'
import './hero-centered.css'
const ReferencePage=lazy(()=>import('./ReferencePage'))
export default function App(){
 useEffect(()=>{document.body.className='geist_mono_1bf8cbf6-module__FlyLvG__variable inter_83a5a2e-module__LLhbsa__variable papermono_aa9e121d-module__lcvVkq__variable arizonaflare_e3e8b677-module__PbqaBq__variable'},[])
 const path=location.pathname
 if(path==='/baseline')return <Suspense fallback={<div className="loading-state">Loading the original-copy checkpoint…</div>}><ReferencePage/></Suspense>
 return <ThemeProvider><WalletProvider><Suspense fallback={<div className="loading-state">Opening Liege…</div>}>{path==='/'?<Home/>:path==='/app'?<Workspace/>:path==='/marketplace'||path.startsWith('/marketplace/')?<Marketplace/>:path==='/docs'||path.startsWith('/docs/')?<Docs/>:<main className="not-found"><Brand/><span className="eyebrow">404 / PAGE NOT FOUND</span><h1>This page has moved beyond the brief.</h1><p>Return to Liege or explore the documentation.</p><Button href="/">Back to Liege</Button></main>}</Suspense></WalletProvider></ThemeProvider>
}
