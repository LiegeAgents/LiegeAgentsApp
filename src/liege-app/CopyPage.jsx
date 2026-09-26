import React from 'react'
import ReferencePage from './ReferencePage'
const files=import.meta.glob('./liege/*.html',{query:'?raw',import:'default',eager:true})
export const liegeSections=Object.fromEntries(Object.entries(files).map(([p,s])=>[p.split('/').pop().replace('.html','').replace('desktop-header','desktopHeader').replace('mobile-header','mobileHeader'),s]))
export default function CopyPage(){return <ReferencePage sections={liegeSections}/>}
