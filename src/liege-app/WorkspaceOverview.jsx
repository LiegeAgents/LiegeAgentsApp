import React,{useMemo} from 'react'
import {ArrowRight,ArrowUpRight,Plus,BriefcaseBusiness,ShieldCheck,Wallet,Bookmark,Clock} from 'lucide-react'
import {AgentIcon} from './ProductArt'
import {Button,Empty,Status} from './UI'
import {money} from './data'

const activeStatuses=new Set(['Open','Funded','Submitted'])
const shortDate=value=>value?new Date(value).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'—'

export default function WorkspaceOverview({state,agents,account,onCreate,onJob,onAgent,onHire,navigate,onSaved}){
 const jobs=state.jobs||[]
 const active=jobs.filter(job=>activeStatuses.has(job.status))
 const completed=jobs.filter(job=>job.status==='Completed')
 const escrow=active.reduce((total,job)=>total+Number(job.budget||0),0)
 const metrics=[
  {label:'Active jobs',value:active.length,detail:'Open, funded, or in review',Icon:BriefcaseBusiness,action:()=>navigate('jobs')},
  {label:'Escrowed',value:money(escrow),unit:'USDG',detail:'Across active jobs',Icon:Wallet,action:()=>navigate('jobs')},
  {label:'Available balance',value:money(account?.balances?.availableUsdg||0),unit:'USDG',detail:account?'Internal Liege balance':'Sign in to load balance',Icon:ShieldCheck,action:()=>navigate('jobs')},
  {label:'Saved agents',value:state.saved.length,detail:'Your browser shortlist',Icon:Bookmark,action:onSaved},
 ]
 const recent=useMemo(()=>[...jobs].sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,5),[jobs])
 return <div className="overview-premium">
  <div className="overview-heading"><div><span className="eyebrow"><span/> WORKSPACE / OVERVIEW</span><h1>Your work, in motion<span>.</span></h1><p>Live jobs, agents, and balances from your Liege account.</p></div><div className="overview-heading-actions"><span className="overview-date"><Clock size={12}/>{new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</span><div><Button secondary onClick={()=>navigate('agents')}>Explore agents <ArrowUpRight size={14}/></Button><Button onClick={onCreate}><Plus size={15}/>Create a job</Button></div></div></div>
  <div className="premium-metrics">{metrics.map(({label,value,unit,detail,Icon,action},index)=><section className="premium-surface premium-metric" key={label}><div className="metric-label"><span>{label}</span><Icon size={15}/></div><button className="metric-value" onClick={action}>{value}<small>{unit}</small><ArrowUpRight size={16}/></button><div className="metric-bottom"><span><i/> {detail}</span><span className="metric-number">0{index+1}</span></div></section>)}</div>
  <div className="overview-columns"><div className="overview-primary">
   <section className="premium-surface work-ledger"><div className="premium-panel-head"><div><span className="panel-overline">LIVE JOBS</span><h2>Your job desk <span>{jobs.length}</span></h2></div><button className="subtle-link" onClick={()=>navigate('jobs')}>View all <ArrowUpRight size={14}/></button></div><div className="premium-job-list">{recent.length?recent.map(job=>{const agent=agents.find(value=>value.id===job.agent);return <button className="premium-job-row" key={job.id} onClick={()=>onJob(job)}><AgentIcon agent={agent} size={21}/><span className="premium-job-title"><strong>{job.title}</strong><small>{agent?.name||job.agent}<i/> {job.id}</small></span><span className="premium-job-progress"><Status value={job.status}/></span><span className="premium-job-budget"><b>{money(job.budget)} <small>USDG</small></b><span>Due {shortDate(job.deadline)}</span></span><ArrowRight size={14}/></button>}):<Empty title="No live jobs yet" action={<Button onClick={onCreate}>Create a job</Button>}>Publish or select an active marketplace agent to begin.</Empty>}</div></section>
  </div><div className="overview-secondary"><section className="premium-surface escrow-overview"><div className="premium-panel-head"><div><span className="panel-overline">ACCOUNT</span><h2>Job escrow</h2></div><img src="/brand/usdg-official.png" alt="USDG" className="currency-token"/></div><div className="escrow-chart"><div><span>ACTIVE ESCROW</span><strong>{money(escrow)}</strong><small>USDG</small></div></div><div className="escrow-note"><ShieldCheck size={13}/><span>Balances are read from your<br/>signed Liege account.</span></div></section></div></div>
  <div className="agent-discovery-heading"><div><span className="panel-overline">LIVE MARKETPLACE</span><h2>Available agents.</h2></div><button onClick={()=>navigate('agents')}>Explore agent market <ArrowRight size={15}/></button></div>
  {agents.length?<div className="discovery-grid">{agents.slice(0,3).map(agent=><section className="premium-surface discovery-card" key={agent.id} style={{'--agent-color':agent.color}}><div className="discovery-top"><AgentIcon agent={agent} size={23}/><span>{agent.category}</span><button className="icon-button" aria-label={'View '+agent.name} onClick={()=>onAgent(agent)}><ArrowUpRight size={16}/></button></div><button className="discovery-name" onClick={()=>onAgent(agent)}>{agent.name}<span>{agent.symbol}</span></button><p>{agent.description}</p><div className="discovery-bottom"><span>From <b>{money(agent.price)}</b> USDG / job</span><button onClick={()=>onHire(agent)}>Hire <ArrowRight size={13}/></button></div></section>)}</div>:<Empty title="No active agents yet" action={<Button secondary onClick={()=>navigate('launch')}>Publish an agent</Button>}>New agent profiles will appear here as their owners publish them.</Empty>}
 </div>
}
