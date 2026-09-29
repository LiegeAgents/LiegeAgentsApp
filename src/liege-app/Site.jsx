import React,{useEffect,useState,useRef,createContext,useContext} from 'react'
import parse,{domToReact,attributesToProps} from 'html-react-parser'
import {ArrowRight,BookOpen,Search,X,ChevronRight} from 'lucide-react'
import {liegeSections} from './sections'
import {Ribbon} from './Motion'
import './reference/source.css'
import './reference/behaviors.css'
import Dither from './reference/dither'
import {ProductArt} from './ProductArt'
import HeroPreview from './HeroPreview'
import {WalletButton} from './wallet/Wallet'
import SocialLinks from './SocialLinks'
import {docs} from './data'
import {ProtocolTile} from './ProtocolIcons'
import {useSourceCarousels,stepCarousel} from './Carousel'

const Theme=createContext(null)
export function ThemeProvider({children}){
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem('liege.theme')||'Dark'}catch{return'Dark'}})
  useEffect(()=>{const m=matchMedia('(prefers-color-scheme: dark)'),apply=()=>document.documentElement.classList.toggle('dark',theme==='Dark'||(theme==='System'&&m.matches));apply();try{localStorage.setItem('liege.theme',theme)}catch{}m.addEventListener('change',apply);return()=>m.removeEventListener('change',apply)},[theme])
  return <Theme.Provider value={{theme,setTheme}}>{children}</Theme.Provider>
}
const menus={Market:[['Find an agent','Capabilities for your next job','/marketplace'],['Your jobs','From brief to settlement','/app?view=jobs'],['Launch an agent','Prepare your service profile','/app?view=launch']],Protocol:[['Job escrow','A clear lifecycle, paid in USDG','/docs/jobs'],['Evaluators','Judgment backed by stake','/docs/evaluators'],['Strategy wallets','Client-controlled permissions','/docs/wallets']],Resources:[['Documentation','Understand how Liege works','/docs'],['Whitepaper','How the protocol works','/whitepaper'],['Roadmap','What ships next','/roadmap'],['For builders','Connect an agent runtime','/docs/builders'],['Product status','What is available today','/docs/status']]}
export function Markup({html}){
  const {theme,setTheme}=useContext(Theme),[menu,setMenu]=useState(null),ref=useRef(null)
  useEffect(()=>{const close=e=>{if(e.key==='Escape')setMenu(null)},outside=e=>{if(ref.current&&!ref.current.contains(e.target))setMenu(null)};document.addEventListener('keydown',close);document.addEventListener('pointerdown',outside);return()=>{document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',outside)}},[])
  useSourceCarousels(ref,html)
  const options={replace(node){if(node.type!=='tag')return;const a=node.attribs||{}
    if(a['data-ribbon'])return <Ribbon hero={a['data-ribbon']==='hero'} className={a.class}/>
    if(a['data-dots'])return <Dither marginClip={node.parent?.attribs?.class?.includes('isolate')&&!node.parent?.attribs?.class?.includes('pb-18')}/>
    if(a['data-protocol-icon'])return <ProtocolTile name={a['data-protocol-icon']}/>
    if(a['data-wallet-connect'])return <WalletButton/>
    if(a['data-social-links'])return <SocialLinks/>
    if(a['data-dashboard-preview'])return <HeroPreview/>
    if(a['data-product-art'])return <ProductArt kind={a['data-product-art']} label={a['data-art-label']}/>
    if(node.name==='button'){
      const props=attributesToProps(a),label=a['aria-label']||node.children.filter(n=>n.type==='text').map(n=>n.data).join('').trim();delete props.command;delete props.commandfor;delete props['data-state']
      if(a['data-direction'])return <button {...props} onClick={()=>stepCarousel(a['aria-controls'],a['data-direction'])}>{domToReact(node.children,options)}</button>
      if(['Light','Dark','System'].includes(label))return <button {...props} aria-checked={theme===label} onClick={()=>setTheme(label)}>{domToReact(node.children,options)}</button>
      if(menus[label]||label==='Open menu'){
        const mobile=label==='Open menu'
        return <span className={'reference-menu-wrap'+(mobile?' mobile-nav-holder':'')}><button {...props} aria-expanded={menu===label} aria-label={mobile?(menu?'Close menu':'Open menu'):undefined} onClick={()=>setMenu(menu===label?null:label)}>{menu&&mobile?<X size={20}/>:domToReact(node.children,options)}</button>{menu===label&&<div className={'liege-nav-menu'+(mobile?' mobile':'')}>{(mobile?Object.entries(menus):[[label,menus[label]]]).map(([group,links])=><div key={group}><span className="eyebrow">{group}</span>{links.map(([name,desc,href])=><a href={href} key={name}><span>{name}<small>{desc}</small></span><ChevronRight size={14}/></a>)}</div>)}{mobile&&<a href="/app">Open workspace <ArrowRight size={14}/></a>}</div>}</span>
      }
    }
  }}
  return <div className="markup-wrapper" ref={ref}>{parse(html,options)}</div>
}
export function SiteHeader({announcement=true}){return <Markup html={(announcement?liegeSections.announcement:'')+liegeSections.desktopHeader+liegeSections.mobileHeader}/>}
export function SiteFooter({cta=false}){return <Markup html={(cta?liegeSections.cta:'')+liegeSections.footer}/>}
export function HelpWidget(){const [open,setOpen]=useState(false),[query,setQuery]=useState('');const results=Object.entries(docs).filter(([id,d])=>(d.title+' '+d.intro).toLowerCase().includes(query.toLowerCase())).slice(0,4);return <div className="help-widget"><button className="help-toggle" onClick={()=>setOpen(!open)} aria-expanded={open}>{open?<X size={15}/>:<BookOpen size={15}/>} {open?'Close help':'Explore the docs'}</button>{open&&<div className="help-panel"><label><Search size={15}/><input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Find a topic…" aria-label="Search help topics"/></label>{results.length?results.map(([id,d])=><a href={'/docs/'+id} key={id}>{d.title}<ChevronRight size={14}/></a>):<p>No matching topic. Try “job” or “wallet”.</p>}<small>Answers from the Liege product brief.</small></div>}</div>}
export default function Home(){useEffect(()=>{document.title='Liege — Agents work. You’re the liege.';if(location.hash)requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView())},[]);return <div className="liege-site reference-page"><SiteHeader/><main className="overflow-x-clip">{['hero','logos','features','enterprise','scale','startups','testimonials','updates'].map(name=><Markup key={name} html={liegeSections[name]}/>)}</main><SiteFooter cta/><HelpWidget/></div>}
