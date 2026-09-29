import React,{createContext,useContext,useEffect,useRef,useState} from 'react'
import {Wallet,ArrowUpRight,ArrowRight,Check,Copy,LogOut,ShieldCheck,LoaderCircle,Globe} from 'lucide-react'
import {Modal,Button,Notice} from '../UI'
import {ROBINHOOD,WALLETS,chainHex,firstAccount,shortAddress,walletError,discoverWallets,readWallet,connectWallet,switchToRobinhood,createWalletConnectProvider} from './core'
import {createWalletSession} from '../api'
import './wallet.css'

const Context=createContext(null), KEY='liege.wallet.v1'
const remember=kind=>{try{kind?localStorage.setItem(KEY,kind):localStorage.removeItem(KEY)}catch{}}
const remembered=()=>{try{return localStorage.getItem(KEY)}catch{return null}}
const empty={kind:null,address:null,chain:null}
export function useWallet(){return useContext(Context)}
export function WalletProvider({children,discover=discoverWallets}){
 const [providers,setProviders]=useState({}),[session,setSession]=useState(empty),[open,setOpen]=useState(()=>WALLETS[new URLSearchParams(location.search).get('wallet')]?true:false),[pending,setPending]=useState(null),[error,setError]=useState(''),[apiSession,setApiSession]=useState(null),[signingIn,setSigningIn]=useState(false)
 const registry=useRef({}),active=useRef(null),abort=useRef(null),cleanup=useRef(()=>{}),restored=useRef(false),revision=useRef(0)
 const disconnect=()=>{const provider=active.current?.provider;abort.current?.abort();abort.current=null;revision.current++;cleanup.current();active.current=null;provider?.disconnect?.().catch?.(()=>{});remember(null);setSession(empty);setApiSession(null);setSigningIn(false);setPending(null);setError('')}
 const bind=(kind,provider)=>{
  cleanup.current();active.current={kind,provider};const identity=active.current
  let refreshCount=0
  const reset=()=>{if(active.current===identity)disconnect()}
  const accounts=values=>{if(active.current!==identity)return;const address=firstAccount(values);if(!address){reset();return}setApiSession(null);setSession(s=>({...s,kind,address}))}
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
 const connect=async(kind,networkOnly=false,connectedProvider=null)=>{
  if(abort.current)return
  const provider=connectedProvider||registry.current[kind]?.provider
  if(!provider){setError(`${WALLETS[kind].name} is unavailable. Try again in a moment.`);return}
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
 const signIn=async()=>{
  if(!session.address||!active.current?.provider||!session.chain||session.chain!==ROBINHOOD.chainId){setError('Connect an account on Robinhood Chain before signing in.');return}
  setSigningIn(true);setError('')
  try{setApiSession(await createWalletSession(session.address,active.current.provider))}catch(e){setError(e?.message||'Wallet sign-in failed.')}finally{setSigningIn(false)}
 }
 const connectWalletConnect=async()=>{
  if(abort.current)return
  try{const provider=await createWalletConnectProvider(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID);registry.current={...registry.current,walletconnect:{provider,announced:true}};setProviders({...registry.current});await connect('walletconnect',false,provider)}catch(e){setError(walletError(e,'walletconnect'))}
 }
 const value={providers,session,pending,error,apiSession,signingIn,connect,connectWalletConnect,disconnect,cancel,signIn,show:()=>{setError('');setOpen(true)},close:()=>setOpen(false),ready:!!session.address&&session.chain===ROBINHOOD.chainId}
 return <Context.Provider value={value}>{children}{open&&<WalletDialog/>}</Context.Provider>
}
export function WalletButton(){const w=useWallet();return <button className={'wallet-connect'+(w.session.address?' has-account':'')} onClick={w.show} aria-label={w.session.address?'Manage connected wallet':'Connect wallet'}>{w.pending?<LoaderCircle className="wallet-spin" size={14}/>:w.session.address?<i className={w.ready?'':'wrong-network'}/>:<Wallet size={14}/>}<span>{w.pending?'Connecting…':w.session.address?(w.ready?shortAddress(w.session.address):'Switch network'):'Connect wallet'}</span></button>}
function WalletGlyph(){return <span className="wallet-glyph walletconnect" aria-hidden="true"><Wallet size={24}/></span>}
function WalletDialog(){
 const w=useWallet(),[copied,setCopied]=useState(false)
 const copy=async()=>{try{await navigator.clipboard.writeText(w.session.address);setCopied(true)}catch{setCopied(false)}}
 return <Modal title={w.session.address?'Your wallet':'Connect your wallet'} onClose={w.close}><div className="wallet-dialog-body">
  <div className="wallet-network"><span className="wallet-network-symbol"><Globe size={17}/></span><span>Robinhood Chain<small>Mainnet · ETH for gas</small></span><b>4663</b></div>
  {w.pending?<div className="wallet-pending" role="status"><WalletGlyph/><LoaderCircle className="wallet-spin" size={22}/><h3>Continue in your wallet</h3><p>Choose a wallet, scan the WalletConnect code if needed, then approve access on Robinhood Chain.</p><Button secondary onClick={w.cancel}>Cancel connection</Button></div>
  :w.session.address?<><div className="wallet-account"><WalletGlyph kind={w.session.kind}/><span>{WALLETS[w.session.kind].name}<strong>{shortAddress(w.session.address)}</strong></span><span className={'wallet-status '+(!w.ready?'needs-network':'')}>{w.ready?<Check size={12}/>:<Globe size={12}/>} {w.ready?'Connected':'Wrong network'}</span></div><code className="wallet-full-address">{w.session.address}</code>{!w.ready&&<><p className="wallet-intro">Your account is connected. Switch to Robinhood Chain to finish setup.</p><Button onClick={()=>w.connect(w.session.kind,true)}>Switch to Robinhood Chain <ArrowRight size={14}/></Button></>}{w.ready&&!w.apiSession&&<><p className="wallet-intro">Sign a one-time wallet message to create your Liege session. This does not move funds.</p><Button onClick={w.signIn} disabled={w.signingIn}>{w.signingIn?'Waiting for signature…':'Sign in to Liege'} <ShieldCheck size={14}/></Button></>}{w.apiSession&&<Notice>Signed in to Liege. Your session is held only in this tab.</Notice>}<div className="wallet-account-actions"><button onClick={copy}><Copy size={14}/>{copied?'Copied':'Copy address'}</button><a href={`${ROBINHOOD.blockExplorerUrls[0]}/address/${w.session.address}`} target="_blank" rel="noreferrer">Explorer<ArrowUpRight size={14}/></a></div><button className="wallet-disconnect" onClick={w.disconnect}><LogOut size={14}/>Disconnect from Liege</button></>
  :<><p className="wallet-intro">Connect with WalletConnect. Choose MetaMask, Phantom, Rabby, Coinbase Wallet, or any supported wallet; Liege requests Robinhood Chain (4663).</p><Button onClick={w.connectWalletConnect}><WalletGlyph/>Connect with WalletConnect <ArrowRight size={14}/></Button></>}
  {w.error&&<Notice error>{w.error}</Notice>}
  <div className="wallet-privacy"><ShieldCheck size={16}/><p>Connection shares your public address. It does not authorize a payment or give an agent access to your funds.</p></div>
 </div></Modal>
}
