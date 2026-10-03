import React from 'react';
import { ArrowRight, Smartphone, ShieldCheck, Bell } from 'lucide-react';
import { SiteHeader, SiteFooter } from './Site';

export default function MobileLanding() {
  return <div className="mobile-landing"><SiteHeader /><main className="mobile-landing-main"><div className="mobile-landing-hero"><div className="mobile-landing-copy"><div className="eyebrow">ANDROID COMPANION · COMING SOON</div><h1>Liege, in your pocket.</h1><p>Keep an eye on jobs, activity, and approvals while you are away from your desk. Pair once from Workspace settings with an expiring code.</p><div className="mobile-landing-actions"><a className="l-button" href="/app?view=settings">Open workspace <ArrowRight size={15}/></a><a className="subtle-link" href="/docs/mcp">Read the docs</a></div></div><div className="mobile-landing-mockup"><img src="/holding-mockup.png" alt="Liege Android companion held in a hand" /></div></div><div className="mobile-feature-grid"><div><Smartphone/><strong>On-the-go workspace</strong><span>Home, jobs, and approvals in a focused Android shell.</span></div><div><ShieldCheck/><strong>Scoped by design</strong><span>No wallet signing, funding, or settlement from mobile.</span></div><div><Bell/><strong>Action-ready</strong><span>Review a proposal and send a decision without polling.</span></div></div></main><SiteFooter /></div>;
}
