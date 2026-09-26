import React,{useEffect,useRef,useState} from 'react'
import './protocol-art.css'

const destinations={Agents:'agents',Clients:'jobs',Evaluators:'evaluators',Builders:'builders',USDG:'fees',Escrow:'jobs',Identity:'agents',Reputation:'agents'}

// Original Liege glyphs: registration, handoff, independent validation and
// feedback motifs. USDG uses the publisher's unchanged official token mark.
export function ProtocolGlyph({name}) {
  if(name==='USDG')return <span className="usdg-glyph"><span className="coin-orbit"/><img src="/brand/usdg-official.png" alt=""/></span>
  return <svg className={'protocol-glyph glyph-'+name.toLowerCase()} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name==='Agents'&&<><path className="glyph-faint" d="M12 19 32 7 52 19v26L32 57 12 45Z"/><path className="glyph-orbit" d="M12 19 32 31l20-12M32 31v26"/><g className="glyph-float"><path className="glyph-fill" d="m22 25 10-6 10 6v14l-10 6-10-6Z"/><path d="m22 25 10 6 10-6M32 31v14"/></g><circle className="glyph-dot" cx="12" cy="19" r="3"/><circle className="glyph-dot delay-1" cx="52" cy="45" r="3"/><circle className="glyph-dot delay-2" cx="32" cy="57" r="3"/></>}
    {name==='Clients'&&<><circle className="glyph-fill" cx="23" cy="21" r="8"/><path d="M9 48v-3c0-8 6-13 14-13 6 0 11 3 13 8"/><path className="glyph-faint" d="M42 13a8 8 0 0 1 0 16m2 5c7 0 12 6 12 13v1"/><g className="glyph-handoff"><path d="M30 48h19m-5-5 5 5-5 5"/><circle cx="30" cy="48" r="2" className="glyph-dot"/></g></>}
    {name==='Evaluators'&&<><path className="glyph-fill" d="m32 7 20 8v16c0 13-11 22-20 27-9-5-20-14-20-27V15Z"/><path className="glyph-faint" d="m32 13 14 6v12c0 8-6 15-14 20-8-5-14-12-14-20V19Z"/><path className="glyph-draw" d="m23 31 6 6 13-14"/><path className="glyph-scan" d="M9 22h46"/></>}
    {name==='Builders'&&<><path className="glyph-faint" d="M20 15h-9v34h9m24-34h9v34h-9"/><g className="glyph-build"><path className="glyph-fill" d="m32 18 12 7v14l-12 7-12-7V25Z"/><path d="m20 25 12 7 12-7M32 32v14"/></g><path className="glyph-draw" d="m6 27-5 5 5 5m52-10 5 5-5 5"/></>}
    {name==='Escrow'&&<><rect className="glyph-fill" x="11" y="12" width="42" height="42" rx="8"/><rect className="glyph-faint" x="16" y="17" width="32" height="32" rx="5"/><circle cx="32" cy="33" r="10"/><g className="glyph-vault"><path d="M32 23v6m10 4h-6m-4 10v-6m-10-4h6"/><circle cx="32" cy="33" r="4"/></g><path d="M8 24h5m-5 18h5"/><circle className="glyph-dot" cx="46" cy="17" r="3"/></>}
    {name==='Identity'&&<><rect className="glyph-fill" x="12" y="9" width="40" height="46" rx="7"/><path className="glyph-faint" d="M26 9V6h12v3M20 45h14m-14 4h9"/><circle cx="29" cy="25" r="6"/><path d="M20 37c1-8 17-8 18 0"/><path className="glyph-scan" d="M7 30h50"/><g className="glyph-draw"><circle cx="47" cy="47" r="10" className="glyph-solid"/><path d="m42 47 3 3 6-7"/></g></>}
    {name==='Reputation'&&<><circle className="glyph-faint" cx="32" cy="29" r="22"/><circle className="glyph-orbit" cx="32" cy="29" r="27" strokeDasharray="1 7"/><path className="glyph-fill glyph-build" d="m32 14 4.5 9 10 1.5-7.2 7 1.7 10-9-4.7-9 4.7 1.7-10-7.2-7 10-1.5Z"/><path className="glyph-draw" d="m19 47-4 13 11-5 6 5 6-5 11 5-4-13"/></>}
  </svg>
}

export function ProtocolTile({name}) {
  const ref=useRef(null),[visible,setVisible]=useState(false)
  useEffect(()=>{const io=new IntersectionObserver(([e])=>setVisible(e.isIntersecting),{rootMargin:'40px'});io.observe(ref.current);return()=>io.disconnect()},[])
  return <a ref={ref} className={'protocol-tile'+(visible?' is-visible':'')} href={'/docs/'+destinations[name]} aria-label={name+' — explore the protocol'}><span className="protocol-icon"><ProtocolGlyph name={name}/></span><span>{name}</span><i className="protocol-corner" aria-hidden="true"/></a>
}

const categories={
  Research:['11832492d156.webp','e1711ea54fb58ba1.webp','research'],
  Automation:['d0ee8aa87809.webp','73c19e6dc5ca3b5c.webp','automation'],
  'Data analysis':['310bf7e4485c.webp','23409e94a47e4b93.webp','data'],
  Development:['a39a93c6cc6f.webp','b1ec780d946d583e.webp','development'],
  TradeStockToken:['625b308f00eb.webp','8e443ddadf65ed74.webp','strategy'],
  ManageVault:['76971ccac781.webp','d7d1a2048db3108e.webp','vault'],
  'Custom work':['4970061fb424.webp','199b075ea4b12ee3.webp','custom']
}
export function CategoryArt({label}){
  const [light,dark,type]=categories[label]||categories.Research
  return <div className={'category-art category-'+type} aria-hidden="true"><img className="category-bg light-art" src={'/reference/'+light} alt="" draggable="false"/><img className="category-bg dark-art" src={'/reference/'+dark} alt="" draggable="false"/><span className="category-plate"><svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    {type==='research'&&<><circle cx="28" cy="28" r="16"/><path d="m40 40 13 13M12 28h32M28 12c-10 8-10 24 0 32 10-8 10-24 0-32"/></>}
    {type==='automation'&&<><path d="M16 17h30v15H18v15h30"/><circle cx="16" cy="17" r="5" fill="currentColor"/><circle cx="46" cy="32" r="5" fill="currentColor"/><path d="m42 40 8 7-8 7"/></>}
    {type==='data'&&<><path d="M13 48V33h8v15m7 0V23h8v25m7 0V13h8v35" fill="currentColor" stroke="none"/><path d="M11 54h42"/></>}
    {type==='development'&&<><path d="m21 20-13 12 13 12m22-24 13 12-13 12M37 13 27 51"/></>}
    {type==='strategy'&&<><path d="M12 48V17M12 48h42M20 38l10-11 9 5 14-17m-11 0h11v11"/></>}
    {type==='vault'&&<><rect x="12" y="12" width="40" height="40" rx="7"/><circle cx="32" cy="32" r="11"/><path d="M32 21v22M21 32h22"/></>}
    {type==='custom'&&<><path d="m32 8 22 13v22L32 56 10 43V21Zm0 0v24m22-11L32 32 10 21m22 11v24"/></>}
  </svg></span></div>
}

export function ProtocolEscrowArt(){return <div className="protocol-escrow-art" aria-hidden="true"><div className="escrow-grid"/><div className="escrow-orbit"/><span className="escrow-art-kicker">ERC-8183 / JOB ESCROW</span><div className="escrow-vault"><ProtocolGlyph name="Escrow"/><span>Funds secured</span><strong>120.00 <small>USDG</small></strong><span className="escrow-art-state"><i/>Awaiting evaluation</span></div><div className="escrow-stages"><span><i/>Fund</span><b/><span><i/>Evaluate</span><b/><span><i/>Settle</span></div></div>}
