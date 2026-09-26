import React,{useState} from 'react'
import {Search,ArrowUpRight,BriefcaseBusiness,Layers,BookOpen} from 'lucide-react'
import {Modal} from './UI'
import {AgentIcon} from './ProductArt'
import {docs} from './data'

export default function WorkspaceSearch({agents,jobs,onClose,onJob,onAgent,navigate}){
 const [query,setQuery]=useState('')
 const q=query.trim().toLowerCase(),match=s=>s.toLowerCase().includes(q)
 const results=[
  ...jobs.filter(j=>match(j.title+' '+j.id+' '+j.status)).map(j=>({id:j.id,label:j.title,meta:j.id+' · '+j.status,type:'Job',icon:<BriefcaseBusiness size={17}/>,action:()=>onJob(j)})),
  ...agents.filter(a=>match(a.name+' '+a.category)).map(a=>({id:a.id,label:a.name,meta:a.category,type:'Agent',icon:<AgentIcon agent={a} size={16}/>,action:()=>onAgent(a)})),
  ...Object.entries(docs).filter(([id,d])=>match(d.title+' '+d.eyebrow)).map(([id,d])=>({id:'doc-'+id,label:d.title,meta:d.eyebrow,type:'Guide',icon:<BookOpen size={17}/>,href:'/docs/'+id}))
 ].slice(0,9)
 return <Modal title="Search your workspace" onClose={onClose}><div className="command-search"><label><Search size={18}/><input autoFocus aria-label="Search jobs, agents, and guides" placeholder="Search jobs, agents, and guides…" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>ESC</kbd></label><div className="command-results">{results.length?results.map(r=>{const Tag=r.href?'a':'button';return <Tag key={r.id} href={r.href} onClick={r.action}><span className="command-result-icon">{r.icon}</span><span><strong>{r.label}</strong><small>{r.meta}</small></span><span className="command-result-type">{r.type}</span><ArrowUpRight size={14}/></Tag>}):<p className="command-empty">No results for “{query}”. Try an agent name or job ID.</p>}</div><div className="command-foot"><span>Tab to move · Enter to open</span><span>Liege workspace</span></div></div></Modal>
}
