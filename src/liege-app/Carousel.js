import {useEffect} from 'react'
import {Blossom} from '@blossom-carousel/core'
import '@blossom-carousel/core/style.css'

const engines = new WeakMap()
export function stepCarousel(id, direction) {
  const el = typeof id==='string'?document.getElementById(id):id
  if (!el) return
  const engine = engines.get(el)
  if (engine && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    engine[direction === 'next' ? 'next' : 'prev']()
  } else {
    const width = el.firstElementChild?.getBoundingClientRect().width || 300
    el.scrollBy({left:(direction === 'next' ? 1 : -1)*(width+16),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'})
  }
}

// The same native-scroll engine used by the reference, including drag momentum
// and click suppression. Touch scrolling stays native.
export function useSourceCarousels(ref, dependency) {
  useEffect(() => {
    const root=ref.current
    if (!root) return
    const cleanups=[...root.querySelectorAll('[blossom-carousel]')].map(el=>{
      let engine
      if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
        engine=Blossom(el,{repeat:false})
        engine.init()
        engines.set(el,engine)
      }
      const buttons=[...root.querySelectorAll('button[data-direction]')].filter(b=>b.getAttribute('aria-controls')===el.id)
      const update=()=>buttons.forEach(b=>{b.disabled=b.dataset.direction!=='next'?el.scrollLeft<2:el.scrollLeft>=el.scrollWidth-el.clientWidth-2})
      const keys=e=>{
        if(e.target!==el||!['ArrowLeft','ArrowRight'].includes(e.key))return
        e.preventDefault();stepCarousel(el,e.key==='ArrowRight'?'next':'previous')
      }
      el.tabIndex=0
      el.addEventListener('scroll',update,{passive:true})
      el.addEventListener('keydown',keys)
      const resize=new ResizeObserver(update);resize.observe(el);update()
      return()=>{engine?.destroy();engines.delete(el);resize.disconnect();el.removeEventListener('scroll',update);el.removeEventListener('keydown',keys)}
    })
    return()=>cleanups.forEach(fn=>fn())
  },[ref,dependency])
}
