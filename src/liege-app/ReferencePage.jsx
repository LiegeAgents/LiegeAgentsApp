import React, { useEffect, useMemo, useRef, useState } from 'react'
import parse, { domToReact, attributesToProps } from 'html-react-parser'
import { useRive, useViewModel, useViewModelInstance, useViewModelInstanceBoolean, RuntimeLoader } from '@rive-app/react-canvas'
import {Ribbon,useReducedMotion} from './Motion'
import {useSourceCarousels,stepCarousel} from './Carousel'
import Dither from './reference/dither'
import announcement from './reference/announcement.html?raw'
import desktopHeader from './reference/desktop-header.html?raw'
import mobileHeader from './reference/mobile-header.html?raw'
import hero from './reference/hero.html?raw'
import logos from './reference/logos.html?raw'
import features from './reference/features.html?raw'
import enterprise from './reference/enterprise.html?raw'
import scale from './reference/scale.html?raw'
import startups from './reference/startups.html?raw'
import testimonials from './reference/testimonials.html?raw'
import updates from './reference/updates.html?raw'
import cta from './reference/cta.html?raw'
import footer from './reference/footer.html?raw'
import './reference/source.css'
import './reference/behaviors.css'
RuntimeLoader.setWasmUrl('/reference/rive.wasm')
RuntimeLoader.setWasmFallbackUrl('/reference/rive_fallback.wasm')

export const sourceSections={announcement,desktopHeader,mobileHeader,hero,logos,features,enterprise,scale,startups,testimonials,updates,cta,footer}
export function RiveArt({name,dark=true}){
  const reduced=useReducedMotion()
  const {rive,RiveComponent}=useRive({src:`/reference/rives/${name}.riv`,stateMachines:'State Machine 1',autoplay:true})
  const model=useViewModel(rive,{useDefault:true})
  const instance=useViewModelInstance(model,{useDefault:true,rive})
  const mode=useViewModelInstanceBoolean('darkMode',instance)
  useEffect(()=>{if(instance)mode.setValue(dark)},[instance,dark])
  useEffect(()=>{if(reduced&&rive){const t=setTimeout(()=>rive.pause(),100);return()=>clearTimeout(t)}},[reduced,rive])
  return <RiveComponent className="size-full" aria-hidden="true"/>
}
export default function ReferencePage({sections=sourceSections}){
  const {announcement,desktopHeader,mobileHeader,hero,logos,features,enterprise,scale,startups,testimonials,updates,cta,footer}=sections
  const [theme,setTheme]=useState('Dark'),[menu,setMenu]=useState(null),[paused,setPaused]=useState(false)
  useEffect(()=>{document.title='Mintlify · Original copy checkpoint';document.documentElement.classList.toggle('dark',theme==='Dark'||(theme==='System'&&matchMedia('(prefers-color-scheme: dark)').matches));document.body.className='geist_mono_1bf8cbf6-module__FlyLvG__variable inter_83a5a2e-module__LLhbsa__variable papermono_aa9e121d-module__lcvVkq__variable arizonaflare_e3e8b677-module__PbqaBq__variable';},[theme])
  const carouselRoot=useRef(null)
  useSourceCarousels(carouselRoot,sections)
  const options={replace(node){if(node.type!=='tag')return;const a=node.attribs||{}
    if(a['data-ribbon'])return <Ribbon hero={a['data-ribbon']==='hero'} className={a.class}/>
    if(a['data-rive'])return <RiveArt name={a['data-rive']} dark={theme!=='Light'}/>
    if(a['data-dots'])return <Dither marginClip={node.parent?.attribs?.class?.includes('isolate')&&!node.parent?.attribs?.class?.includes('pb-18')} />
    if(node.name==='button'){
      const props=attributesToProps(a), label=a['aria-label']||node.children?.filter(c=>c.type==='text').map(c=>c.data).join('');delete props.command;delete props.commandfor
      if(a['data-direction'])return <button {...props} onClick={()=>stepCarousel(a['aria-controls'],a['data-direction'])}>{domToReact(node.children,options)}</button>
      if(['Light','Dark','System'].includes(label))return <button {...props} aria-checked={theme===label} onClick={()=>setTheme(label)}>{domToReact(node.children,options)}</button>
      if(label==='Pause testimonials')return <button {...props} onClick={()=>setPaused(!paused)}>{paused?'Play testimonials':'Pause testimonials'}</button>
      if(['Products','Solutions','Resources','Open menu'].includes(label))return <span className="reference-menu-wrap"><button {...props} aria-expanded={menu===label} onClick={()=>setMenu(menu===label?null:label)}>{domToReact(node.children,options)}</button>{menu===label&&<div className="reference-menu">{(label==='Products'?['Documentation','Editor','Automations']:label==='Solutions'?['Enterprise','Startups','Build vs Buy']:['Customers','Blog','Guides','Pricing']).map(n=><a key={n} href={'https://www.mintlify.com/'+n.toLowerCase().replaceAll(' ','-')}>{n}</a>)}</div>}</span>
    }
  }}
  return <div ref={carouselRoot} className={'reference-page'+(paused?' testimonials-paused':'')}>{parse(announcement+desktopHeader+mobileHeader,options)}<main className="overflow-x-clip">{[hero,logos,features,enterprise,scale,startups,testimonials,updates,cta].map((section,i)=><React.Fragment key={i}>{parse(section,options)}</React.Fragment>)}</main>{parse(footer,options)}<a className="reference-assistant" href="https://www.mintlify.com/docs">▣ Ask assistant</a></div>
}
