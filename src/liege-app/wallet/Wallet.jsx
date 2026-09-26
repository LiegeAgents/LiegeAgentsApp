import React,{createContext,useContext,useEffect,useRef,useState} from 'react'
import {Wallet,ArrowUpRight,ArrowRight,Check,Copy,LogOut,Smartphone,ShieldCheck,LoaderCircle,ChevronLeft,Globe} from 'lucide-react'
import {QRCodeSVG} from 'qrcode.react'
import {Modal,Button,Notice} from '../UI'
import {ROBINHOOD,WALLETS,chainHex,firstAccount,shortAddress,walletError,discoverWallets,readWallet,connectWallet,switchToRobinhood,publicAppUrl,mobileWalletLink} from './core'
import './wallet.css'

const Context=createContext(null), KEY='liege.wallet.v1'
const remember=kind=>{try{kind?localStorage.setItem(KEY,kind):localStorage.removeItem(KEY)}catch{}}
const remembered=()=>{try{return localStorage.getItem(KEY)}catch{return null}}
const empty={kind:null,address:null,chain:null}
export function useWallet(){return useContext(Context)}
export function WalletProvider({children,discover=discoverWallets}){
 const [providers,setProviders]=useState({}),[session,setSession]=useState(empty),[open,setOpen]=useState(()=>WALLETS[new URLSearchParams(location.search).get('wallet')]?true:false),[pending,setPending]=useState(null),[error,setError]=useState('')
 const registry=useRef({}),active=useRef(null),abort=useRef(null),cleanup=useRef(()=>{}),restored=useRef(false),revision=useRef(0)
 const disconnect=()=>{abort.current?.abort();abort.current=null;revision.current++;cleanup.current();active.current=null;remember(null);setSession(empty);setPending(null);setError('')}
 const bind=(kind,provider)=>{
  cleanup.current();active.current={kind,provider};const identity=active.current
  let refreshCount=0
  const reset=()=>{if(active.current===identity)disconnect()}
  const accounts=values=>{if(active.current!==identity)return;const address=firstAccount(values);if(!address){reset();return}setSession(s=>({...s,kind,address}))}
  const chain=value=>{if(active.current===identity){setSession(s=>({...s,kind,chain:chainHex(value)}));setError('')}}
  const refresh=async()=>{const id=++refreshCount;try{const data=await readWallet(provider);if(active.current!==identity||id!==refreshCount)return;if(!data.address){reset();return}setSession({kind,...data})}catch{if(active.current===identity&&!abort.current)reset()}}
  provider.on?.('accountsChanged',accounts);provider.on?.('chainChanged',chain);provider.on?.('disconnect',reset)
  window.addEventListener('focus',refresh);window.addEventListener('pageshow',refresh)
  cleanup.current=()=>{refreshCount++;provider.removeListener?.('accountsChanged',accounts);provider.removeListener?.('chainChanged',chain);provider.removeListener?.('disconnect',reset);window.removeEventListener('focus',refresh);window.removeEventListener('pageshow',refresh)}
 }
 useEffect(()=>{
  let disposed=false
  const stop=discover(window,(kind,provider,announced)=>{
   const old=registry.current[kind]
   if(!old||announced&&!old.announced){registry.current={...registry.current,[kind]:{provider,announced}};setProviders({...registry.current})}
   if(!restored.current&&remembered()===kind){
    restored.current=true;const rev=revision.current
    readWallet(provider).then(data=>{if(disposed||rev!==revision.current||!data.address)return;bind(kind,provider);setSession({kind,...data})}).catch(()=>{})
   }
  })
  return()=>{disposed=true;restored.current=false;stop();cleanup.current();abort.current?.abort()}
 },[])
 const connect=async(kind,networkOnly=false)=>{
  if(abort.current)return
  const provider=registry.current[kind]?.provider
  if(!provider){setError(`Open Liege in ${WALLETS[kind].name} or install its browser extension.`);return}
  const controller=new AbortController();abort.current=controller;const rev=++revision.current
  setPending(kind);setError('');setSession(empty);bind(kind,provider)
  try{
   const data=await (networkOnly?switchToRobinhood(provider,kind,controller.signal):connectWallet(provider,kind,controller.signal))
   if(controller.signal.aborted||rev!==revision.current)return
   setSession({kind,...data});remember(kind)
  }catch(e){
   if(controller.signal.aborted||rev!==revision.current)return
   setError(walletError(e,kind))
   // Preserve a shared account on a rejected network switch, clearly marked as wrong network.
   try{const data=await readWallet(provider);if(rev===revision.current&&!controller.signal.aborted){setSession({kind,...data});if(data.address)remember(kind)}}catch{}
  }finally{if(rev===revision.current){abort.current=null;setPending(null)}}
 }
 const cancel=()=>{disconnect();setError('Connection stopped in Liege. Dismiss any request still open in your wallet before retrying.')}
 const value={providers,session,pending,error,connect,disconnect,cancel,show:()=>{setError('');setOpen(true)},close:()=>setOpen(false),ready:!!session.address&&session.chain===ROBINHOOD.chainId}
 return <Context.Provider value={value}>{children}{open&&<WalletDialog/>}</Context.Provider>
}
export function WalletButton(){const w=useWallet();return <button className={'wallet-connect'+(w.session.address?' has-account':'')} onClick={w.show} aria-label={w.session.address?'Manage connected wallet':'Connect wallet'}>{w.pending?<LoaderCircle className="wallet-spin" size={14}/>:w.session.address?<i className={w.ready?'':'wrong-network'}/>:<Wallet size={14}/>}<span>{w.pending?'Connecting…':w.session.address?(w.ready?shortAddress(w.session.address):'Switch network'):'Connect wallet'}</span></button>}
function WalletGlyph({kind}){return <span className={'wallet-glyph '+kind} aria-hidden="true"><img src={kind==='phantom'?'/brand/wallet-phantom.png':'/brand/wallet-metamask.svg'} alt=""/></span>}
function WalletDialog(){
 const w=useWallet(),[phone,setPhone]=useState(null),[copied,setCopied]=useState(false)
 const mobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&/Macintosh/.test(navigator.userAgent))
 const publicUrl=publicAppUrl(import.meta.env.VITE_PUBLIC_APP_URL,location.href)
 const copy=async()=>{try{await navigator.clipboard.writeText(w.session.address);setCopied(true)}catch{setCopied(false)}}
 const phoneLink=phone?mobileWalletLink(phone,publicUrl):null
 return <Modal title={phone?'Continue on your phone':w.session.address?'Your wallet':'Connect your wallet'} onClose={w.close}><div className="wallet-dialog-body">
  <div className="wallet-network"><span className="wallet-network-symbol"><Globe size={17}/></span><span>Robinhood Chain<small>Mainnet · ETH for gas</small></span><b>4663</b></div>
  {phone?<><button className="wallet-back" onClick={()=>setPhone(null)}><ChevronLeft size={14}/>All wallets</button><div className="wallet-phone"><WalletGlyph kind={phone}/><h3>Open Liege in {WALLETS[phone].name}</h3>{phoneLink?<><QRCodeSVG value={phoneLink} size={184} marginSize={4} level="M" title={`Open Liege in ${WALLETS[phone].name}`}/><p>Scan with your phone’s camera. Connect inside the wallet app’s browser.</p><a className="l-button" href={phoneLink}>Open {WALLETS[phone].name}<ArrowUpRight size={14}/></a><small>{new URL(publicUrl).host}</small></>:<><p>This preview is running on your computer. Phone connections become available when Liege is opened at its public HTTPS address.</p><a href={WALLETS[phone].install} target="_blank" rel="noreferrer">Get {WALLETS[phone].name}<ArrowUpRight size={14}/></a></>}</div></>
  :w.pending?<div className="wallet-pending" role="status"><WalletGlyph kind={w.pending}/><LoaderCircle className="wallet-spin" size={22}/><h3>Continue in {WALLETS[w.pending].name}</h3><p>Unlock your wallet and approve the account connection and Robinhood Chain network request.</p><Button secondary onClick={w.cancel}>Cancel connection</Button></div>
  :w.session.address?<><div className="wallet-account"><WalletGlyph kind={w.session.kind}/><span>{WALLETS[w.session.kind].name}<strong>{shortAddress(w.session.address)}</strong></span><span className={'wallet-status '+(!w.ready?'needs-network':'')}>{w.ready?<Check size={12}/>:<Globe size={12}/>} {w.ready?'Connected':'Wrong network'}</span></div><code className="wallet-full-address">{w.session.address}</code>{!w.ready&&<><p className="wallet-intro">Your account is connected. Switch to Robinhood Chain to finish setup.</p><Button onClick={()=>w.connect(w.session.kind,true)}>Switch to Robinhood Chain <ArrowRight size={14}/></Button></>}<div className="wallet-account-actions"><button onClick={copy}><Copy size={14}/>{copied?'Copied':'Copy address'}</button><a href={`${ROBINHOOD.blockExplorerUrls[0]}/address/${w.session.address}`} target="_blank" rel="noreferrer">Explorer<ArrowUpRight size={14}/></a></div><button className="wallet-disconnect" onClick={w.disconnect}><LogOut size={14}/>Disconnect from Liege</button></>
  :<><p className="wallet-intro">Choose your wallet to connect an Ethereum account on Robinhood Chain.</p><div className="wallet-choices">{Object.entries(WALLETS).map(([kind,meta])=><div className="wallet-choice" key={kind}>{mobile&&!w.providers[kind]&&publicUrl?<a className="wallet-choice-main" href={mobileWalletLink(kind,publicUrl)}><WalletGlyph kind={kind}/><span><strong>{meta.name}</strong><small>Open mobile app</small></span><ArrowUpRight size={17}/></a>:<button className="wallet-choice-main" onClick={()=>w.providers[kind]?w.connect(kind):setPhone(kind)}><WalletGlyph kind={kind}/><span><strong>{meta.name}</strong><small>{w.providers[kind]?'Detected in this browser':'Extension & mobile app'}</small></span>{w.providers[kind]?<span className="wallet-detected">Connect <ArrowRight size={13}/></span>:<ArrowRight size={17}/>}</button>}<div className="wallet-choice-links"><button onClick={()=>setPhone(kind)}><Smartphone size={12}/>Use phone</button>{!w.providers[kind]&&<a href={meta.install} target="_blank" rel="noreferrer">Install extension<ArrowUpRight size={12}/></a>}</div></div>)}</div></>}
  {w.error&&<Notice error>{w.error}</Notice>}
  <div className="wallet-privacy"><ShieldCheck size={16}/><p>Connection shares your public address. It does not authorize a payment or give an agent access to your funds.</p></div>
 </div></Modal>
}
