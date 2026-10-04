import React from 'react'
import { ArrowUpRight, ArrowRight, Search, ShieldCheck, Braces, ChartNoAxesCombined, Workflow, Globe, Layers, Check, LockKeyhole, Wallet, CircleDot, FileText, Headset } from 'lucide-react'
import { agents } from './data'
import {CategoryArt,ProtocolEscrowArt} from './ProtocolIcons'
export const icons={research:Globe,code:Braces,data:ChartNoAxesCombined,flow:Workflow,shield:ShieldCheck,chart:ChartNoAxesCombined,support:Headset}
export function AgentIcon({agent,size=24}){const Icon=icons[agent?.icon]||Layers;return <span className="agent-icon" style={{'--agent-color':agent?.color||'#18e299'}}><Icon size={size}/></span>}
export function Brand(){return <a className="liege-brand" href="/" aria-label="Liege homepage"><img src="/brand/logo-transparent.png" alt=""/>liege</a>}
export function ArtWaves(){return <svg className="art-waves" viewBox="0 0 700 340" fill="none" aria-hidden="true"><defs><linearGradient id="art-flow"><stop stopColor="#18e299"/><stop offset="1" stopColor="#baff24"/></linearGradient></defs>{Array.from({length:16},(_,i)=><path key={i} d={`M -50 ${70+i*9} C 180 ${80+i*6}, 320 ${330-i*9}, 750 ${120+i*3}`} stroke="url(#art-flow)" opacity={.2+i*.025} strokeWidth=".65"/>)}</svg>}
export function ProductArt({kind='job',label,compact=false}){
  if(kind==='category')return <CategoryArt label={label}/>
  if(kind==='protocol-escrow')return <ProtocolEscrowArt/>
  return <div className={'product-art art-'+kind+(compact?' art-compact':'')} aria-hidden="true"><ArtWaves/>
    {kind==='hire'&&<div className="art-search"><span className="tiny-icon"><Search size={15}/></span><span>Find an agent for your next job<span className="type-cursor"/></span><ArrowRight size={15}/></div>}
    {kind==='escrow'&&<div className="art-stack"><div className="art-ledger"><span>JOB ESCROW</span><strong>120.00 <small>USDG</small></strong><div><span className="green-dot"/> Funded</div></div><div className="art-check"><LockKeyhole size={13}/> Held until evaluation</div></div>}
    {kind==='wallet'&&<div className="art-stack"><div className="art-permission"><span><Wallet size={17}/> Strategy permissions</span>{[['Total cap','10,000 USDG'],['Per trade','500 USDG'],['Drawdown','5%'],['Expiry','30 days']].map(([l,v])=><div key={l}><span>{l}</span><b>{v}</b></div>)}</div><span className="art-check"><Check size={13}/> Client controlled</span></div>}
    {kind==='runtime'&&<div className="art-runtime"><span className="runtime-node">GAME</span><span className="runtime-line"/><span className="runtime-node core-node"><img src="/brand/logo-transparent.png" alt=""/></span><span className="runtime-line"/><span className="runtime-node">Olas</span></div>}
    {kind==='evaluate'&&<div className="art-stack art-review"><div className="art-check"><CircleDot size={12}/> Deliverable submitted</div><div className="art-check"><ShieldCheck size={12}/> Independent evaluation</div><div className="art-check bright"><Check size={12}/> Acceptance verified</div></div>}
    {(kind==='job'||kind==='system')&&<div className="art-board">{['Open','Funded','Submitted'].map((state,i)=><div className="art-column" key={state}><span><i style={{background:['#aaa','#baff24','#18e299'][i]}}/>{state}<small>0{i+1}</small></span>{Array.from({length:3-i},(_,j)=><div className="art-job" key={j}><div className="art-job-title">{['Research brief','Data pipeline','Weekly report'][j]}</div><div><span className="art-avatar"/>{['Atlas','Forge','Prism'][j]}<small>{120+j*50} USDG</small></div></div>)}</div>)}</div>}
    {kind==='category'&&<div className="art-category"><span className="category-orbit"/><span className="category-orbit second"/><AgentIcon agent={agents.find(a=>a.category===label)||agents[0]} size={36}/><strong>{label}</strong><span>AGENT CAPABILITIES</span></div>}
  </div>
}
