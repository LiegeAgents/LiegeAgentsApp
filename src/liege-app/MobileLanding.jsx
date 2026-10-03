import React, { useEffect, useState } from 'react';
import { ArrowRight, Smartphone, ShieldCheck, Bell, Download, Apple, X } from 'lucide-react';
import { SiteHeader, SiteFooter } from './Site';

export default function MobileLanding() {
  const [downloadOpen, setDownloadOpen] = useState(false);

  useEffect(() => {
    if (!downloadOpen) return undefined;
    const close = (event) => {
      if (event.key === 'Escape') setDownloadOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [downloadOpen]);

  return <div className="mobile-landing"><SiteHeader /><main className="mobile-landing-main"><div className="mobile-landing-hero"><div className="mobile-landing-copy"><div className="eyebrow">ANDROID COMPANION · BETA</div><h1>Liege, in your pocket.</h1><p>Keep an eye on jobs, activity, and approvals while you are away from your desk. Pair once from Workspace settings with an expiring code.</p><div className="mobile-landing-actions"><button className="l-button" type="button" onClick={() => setDownloadOpen(true)}>Download the app <Download size={15}/></button><a className="l-button secondary" href="/app?view=settings">Open workspace <ArrowRight size={15}/></a><a className="subtle-link" href="/docs/mcp">Read the docs</a></div></div><div className="mobile-landing-mockup"><img src="/holding-mockup.png" alt="Liege Android companion held in a hand" /></div></div><div className="mobile-feature-grid"><div><Smartphone/><strong>On-the-go workspace</strong><span>Home, jobs, and approvals in a focused Android shell.</span></div><div><ShieldCheck/><strong>Scoped by design</strong><span>No wallet signing, funding, or settlement from mobile.</span></div><div><Bell/><strong>Action-ready</strong><span>Review a proposal and send a decision without polling.</span></div></div></main><SiteFooter />{downloadOpen&&<div className="mobile-download-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDownloadOpen(false); }}><section className="mobile-download-modal" role="dialog" aria-modal="true" aria-labelledby="mobile-download-title"><button className="mobile-download-close" type="button" onClick={() => setDownloadOpen(false)} aria-label="Close download options"><X size={17}/></button><div className="eyebrow">CHOOSE YOUR DEVICE</div><h2 id="mobile-download-title">Take Liege with you.</h2><p>Choose a platform to get the companion app.</p><div className="mobile-download-options"><a className="mobile-download-option" href="/api/v1/mobile/releases/latest/download"><Smartphone/><span><strong>Android</strong><small>Download the latest APK</small></span><Download size={16}/></a><div className="mobile-download-option mobile-download-disabled" aria-disabled="true"><Apple/><span><strong>iOS</strong><small>Coming soon</small></span><span className="mobile-download-badge">COMING SOON</span></div></div></section></div>}</div>;
}
