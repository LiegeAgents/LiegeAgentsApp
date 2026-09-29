import React,{useEffect,useState} from 'react'
import {ArrowUpRight,FileText,Printer} from 'lucide-react'
import {SiteHeader,SiteFooter} from './Site'
import {Button} from './UI'
import {statusLabels,whitepaper} from './whitepaperContent'
import './pages.css'

const sectionIds=whitepaper.sections.map(section=>section.id)
const number=index=>String(index+1).padStart(2,'0')

// Content strings may contain [text](href) links.
function Inline({text}){return text.split(/(\[[^\]]+\]\([^)]+\))/).map((part,i)=>{const link=part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);return link?<a href={link[2]} key={i}>{link[1]}</a>:part})}

function Chip({status}){return <span className={'page-chip chip-'+status}>{statusLabels[status]}</span>}

function Block({block}){
  if(block.p)return <p><Inline text={block.p}/></p>
  if(block.list)return <ul className="wp-list">{block.list.map(item=><li key={item}><Inline text={item}/></li>)}</ul>
  if(block.terms)return <dl className="wp-terms">{block.terms.map(([term,text])=><div key={term}><dt>{term}</dt><dd><Inline text={text}/></dd></div>)}</dl>
  if(block.note)return <aside className="wp-note"><p><Inline text={block.note}/></p></aside>
  if(block.table){const {columns,rows,chip}=block.table;return <div className="wp-table-wrap"><table className="wp-table"><thead><tr>{columns.map(column=><th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={row[0]}>{row.map((cell,i)=>i===0?<th scope="row" key={i}>{cell}</th>:<td key={i}>{i===chip?<Chip status={cell}/>:<Inline text={cell}/>}</td>)}</tr>)}</tbody></table></div>}
  return null
}

// Highlights the section being read in the sidebar.
function useActiveSection(){
  const [active,setActive]=useState(sectionIds[0])
  useEffect(()=>{
    const observer=new IntersectionObserver(entries=>{
      const visible=entries.filter(entry=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top)
      if(visible[0])setActive(visible[0].target.id)
    },{rootMargin:'-90px 0px -65% 0px'})
    sectionIds.forEach(id=>{const element=document.getElementById(id);if(element)observer.observe(element)})
    return()=>observer.disconnect()
  },[])
  return active
}

export default function Whitepaper(){
  const active=useActiveSection()
  // The page renders client-side, after the browser's own jump to a #section has been missed.
  useEffect(()=>{if(location.hash)requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView())},[])
  return <div className="liege-site reference-page wp-root">
    <SiteHeader announcement={false}/>
    <main className="docs-layout">
      <aside className="docs-sidebar wp-sidebar">
        <a className="docs-home" href="/whitepaper"><FileText size={17}/>Whitepaper</a>
        <nav className="docs-nav-group" aria-label="Whitepaper sections">
          <h3>Version {whitepaper.version}</h3>
          {whitepaper.sections.map((section,index)=><a href={'#'+section.id} key={section.id} className={active===section.id?'active':''} aria-current={active===section.id?'location':undefined}><span className="wp-nav-number">{number(index)}</span>{section.title}</a>)}
        </nav>
      </aside>
      <article className="docs-content wp-content">
        <span className="eyebrow">WHITEPAPER · VERSION {whitepaper.version}</span>
        <h1>{whitepaper.title}</h1>
        <p className="doc-intro">{whitepaper.abstract}</p>
        <div className="wp-meta">
          <span>Updated {whitepaper.updated}</span>
          <span>Robinhood Chain · USDG</span>
          <button type="button" className="l-button secondary small wp-print" onClick={()=>window.print()}><Printer size={14}/>Print or save as PDF</button>
        </div>
        <div className="wp-legend">
          <span><Chip status="built"/>In the current codebase</span>
          <span><Chip status="designed"/>Specified, not yet built</span>
        </div>
        <nav className="doc-contents wp-inline-contents" aria-label="On this page">{whitepaper.sections.map(section=><a href={'#'+section.id} key={section.id}>{section.title}</a>)}</nav>
        {whitepaper.sections.map((section,index)=><section id={section.id} key={section.id} className="doc-section wp-section" aria-labelledby={section.id+'-title'}>
          <div className="wp-section-head">
            <span className="wp-section-number">{number(index)}</span>
            <h2 id={section.id+'-title'}>{section.title}</h2>
            {section.status&&<Chip status={section.status}/>}
          </div>
          {section.blocks.map((block,i)=><Block block={block} key={i}/>)}
        </section>)}
        <div className="doc-app-cta wp-cta">
          <h3>See what ships next.</h3>
          <p>The roadmap puts these components in order, starting with the jobs protocol.</p>
          <Button href="/roadmap">View the roadmap <ArrowUpRight size={14}/></Button>
        </div>
      </article>
    </main>
    <SiteFooter/>
  </div>
}
