import React,{createContext,useContext,useEffect,useMemo,useRef,useState} from 'react'
import {ConnectButton,RainbowKitProvider,getDefaultConfig} from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {WagmiProvider,useAccount,useChainId,useDisconnect,useSignMessage} from 'wagmi'
import {Wallet,LoaderCircle} from 'lucide-react'
import {api,createWalletSession} from '../api'
import './wallet.css'

const robinhoodChain={
 id:4663,
 name:'Robinhood Chain',
 nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
 rpcUrls:{default:{http:['https://rpc.mainnet.chain.robinhood.com']}},
 blockExplorers:{default:{name:'Robinhood Chain Explorer',url:'https://robinhoodchain.blockscout.com'}},
}
const walletConfig=getDefaultConfig({
 appName:'Liege',
 projectId:import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'walletconnect-project-id-required',
 chains:[robinhoodChain],
 ssr:false,
})
const queryClient=new QueryClient()
const Context=createContext(null)
const shortAddress=address=>address?`${address.slice(0,6)}…${address.slice(-4)}`:''

export function useWallet(){return useContext(Context)}

export function WalletProvider({children}){
 return <WagmiProvider config={walletConfig}><QueryClientProvider client={queryClient}><RainbowKitProvider><LiegeWalletProvider>{children}</LiegeWalletProvider></RainbowKitProvider></QueryClientProvider></WagmiProvider>
}

function LiegeWalletProvider({children}){
 const {address,connector,isConnected}=useAccount(),chainId=useChainId(),{disconnect:disconnectWallet}=useDisconnect(),{signMessageAsync}=useSignMessage()
 const [apiSession,setApiSession]=useState(null),[signingIn,setSigningIn]=useState(false),[error,setError]=useState('')
 const previousAddress=useRef(address)
 useEffect(()=>{if(previousAddress.current!==address){setApiSession(null);setError('');previousAddress.current=address}},[address])
 const ready=Boolean(isConnected&&address&&chainId===robinhoodChain.id)
 useEffect(()=>{let active=true;if(!ready||!address)return;api.me().then(result=>{if(active&&result.data?.wallet_address?.toLowerCase()===address.toLowerCase())setApiSession(result.data)}).catch(()=>{});return()=>{active=false}},[ready,address])
 const signIn=async()=>{
  if(!ready||!address){setError('Connect a wallet on Robinhood Chain before signing in.');return}
  setSigningIn(true);setError('')
  try{const session=await createWalletSession(address,message=>signMessageAsync({message}));const account=await api.me();setApiSession(account.data||session)}catch(e){setError(e?.shortMessage||e?.message||'Wallet sign-in failed.')}finally{setSigningIn(false)}
 }
 const disconnect=()=>{disconnectWallet();setApiSession(null);setError('')}
 const value=useMemo(()=>({session:{kind:connector?.name||null,address:address||null,chain:chainId?`0x${chainId.toString(16)}`:null},ready,apiSession,signingIn,error,signIn,disconnect}),[connector?.name,address,chainId,ready,apiSession,signingIn,error])
 return <Context.Provider value={value}>{children}</Context.Provider>
}

export function WalletButton(){
 const wallet=useWallet()
 return <ConnectButton.Custom>{({account,chain,mounted,openAccountModal,openChainModal,openConnectModal})=>{
  const active=mounted&&account
  if(!active)return <button className="wallet-connect" onClick={openConnectModal}><Wallet size={14}/><span>Connect wallet</span></button>
  if(chain?.unsupported||!wallet.ready)return <button className="wallet-connect has-account" onClick={openChainModal}><i className="wrong-network"/><span>Switch to Robinhood</span></button>
  return <button className="wallet-connect has-account" onClick={wallet.apiSession?openAccountModal:wallet.signIn}>{wallet.signingIn?<LoaderCircle className="wallet-spin" size={14}/>:<i/>}<span>{wallet.signingIn?'Waiting for signature…':wallet.apiSession?shortAddress(account.address):'Sign in to Liege'}</span></button>
 }}</ConnectButton.Custom>
}
