import React,{useState,useEffect,useRef} from 'react'
import {drawRibbonFrame,defaultSettings} from './reference/ribbon-engine'
export function useReducedMotion(){const [reduced,setReduced]=useState(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);useEffect(()=>{const m=matchMedia('(prefers-reduced-motion: reduce)'),f=()=>setReduced(m.matches);m.addEventListener('change',f);return()=>m.removeEventListener('change',f)},[]);return reduced}
export function Ribbon({hero=false,className=''}){
  const ref=useRef(null),reduced=useReducedMotion()
  useEffect(()=>{
    const canvas=ref.current,ctx=canvas.getContext('2d'),settings={...defaultSettings,speed:.66,background:'transparent',rotate:hero?-28:0,edgeFade:.25,particleSpeed:hero?.84:1.15}
    let frame=0,start=0,visible=true
    const draw=(t)=>{const ratio=Math.max(canvas.width/settings.width,canvas.height/settings.height);ctx.setTransform(ratio,0,0,ratio,(canvas.width-settings.width*ratio)/2,(canvas.height-settings.height*ratio)/2);drawRibbonFrame(ctx,settings,t,1)}
    const resize=()=>{const b=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio,2);canvas.width=b.width*d;canvas.height=b.height*d;draw(0)}
    const tick=t=>{if(!start)start=t;if(visible)draw((t-start)/1000*settings.speed);frame=requestAnimationFrame(tick)}
    const ro=new ResizeObserver(resize);ro.observe(canvas);const io=new IntersectionObserver(([entry])=>visible=entry.isIntersecting);io.observe(canvas);resize();if(!reduced)frame=requestAnimationFrame(tick)
    return()=>{cancelAnimationFrame(frame);ro.disconnect();io.disconnect()}
  },[hero,reduced])
  return <canvas ref={ref} className={className} aria-hidden="true"/>
}

