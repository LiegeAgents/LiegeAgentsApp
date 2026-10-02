import React, { useEffect, useState } from "react";

export function registerPwa() {
  if (typeof window !== "undefined" && "serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}), { once: true });
  }
}

export function InstallPrompt() {
  const [prompt, setPrompt] = useState(null);
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem("liege.pwa.dismissed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    const onInstall = (event) => { event.preventDefault(); setPrompt(event); };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => window.removeEventListener("beforeinstallprompt", onInstall);
  }, []);
  if (!prompt || hidden) return null;
  const install = async () => { await prompt.prompt(); setPrompt(null); };
  const dismiss = () => { try { localStorage.setItem("liege.pwa.dismissed", "1"); } catch {} setHidden(true); };
  return <div className="pwa-install-prompt" role="status"><div><strong>Install Liege</strong><span>Add the workspace to your home screen for quick access.</span></div><button onClick={install}>Install</button><button className="pwa-dismiss" onClick={dismiss} aria-label="Dismiss install prompt">×</button></div>;
}
