import { useEffect, useRef, useState } from 'react';
import parse, { attributesToProps, domToReact, type HTMLReactParserOptions } from 'html-react-parser';
import footerMarkup from '../../src/liege-app/liege/footer.html?raw';
import { Check, Copy, Moon, Sun, Monitor } from 'lucide-react';
import { LIEGE } from './data';
import { ArrowUpRight, X as Close } from 'lucide-react';

const tokenAddress = '0xc32ab2e562ade6fba6d3d1e3960d49b0957ef645';
const channels = [
  { id: 'x', label: 'X', url: 'https://x.com/liegeagents' },
  { id: 'telegram', label: 'Telegram', url: 'https://t.me/liegeagents' },
] as const;

function SocialIcon({ id }: { id: 'x' | 'telegram' }) {
  return id === 'x'
    ? <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l7.9-9.1L1.8 2h6.5l4.5 6.6L18.9 2Zm-1.1 18h1.7L7.3 3.9H5.5L17.8 20Z"/></svg>
    : <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="m21.3 3.4-3.2 16.1c-.2 1.1-.9 1.4-1.8.9l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.4-4.9 8.9-8.1c.4-.3-.1-.5-.6-.2L6 13.4l-4.7-1.5c-1-.3-1-1 .2-1.5L19.9 3c.8-.3 1.6.2 1.4.4Z"/></svg>;
}

function SocialLinks() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return;
      if (event.type === 'pointerdown' && ref.current?.contains(event.target as Node)) return;
      setOpen(null);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); };
  }, []);
  return <div className="social-links" ref={ref} aria-label="Liege social channels">{channels.map(channel => <div className="social-channel" key={channel.id}><a href={channel.url} target="_blank" rel="noreferrer"><SocialIcon id={channel.id}/>{channel.label}<ArrowUpRight size={12}/></a>{open === channel.id && <div className="social-coming" role="status"><div><strong>{channel.label}</strong><button type="button" onClick={() => setOpen(null)} aria-label="Close social notice"><Close size={13}/></button></div><p>Visit the official {channel.label} channel.</p></div>}</div>)}</div>;
}

function TokenAddress() {
  const [copied, setCopied] = useState(false);
  return <div className="normal-footer-token"><span>CA</span><code>{tokenAddress}</code><button type="button" aria-label="Copy contract address" onClick={() => { void navigator.clipboard?.writeText(tokenAddress); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }}>{copied ? <Check size={14}/> : <Copy size={14}/>}<em>{copied ? 'Copied' : 'Copy'}</em></button></div>;
}

function ThemeButtons() {
  const [theme, setTheme] = useState<'Light' | 'Dark' | 'System'>('Dark');
  useEffect(() => { document.documentElement.classList.add('dark'); }, []);
  const choices = [['Light', Sun], ['Dark', Moon], ['System', Monitor] ] as const;
  return <div aria-label="Theme switcher" className="normal-footer-themes" role="radiogroup">{choices.map(([name, Icon]) => <button key={name} type="button" aria-label={name} aria-checked={theme === name} role="radio" onClick={() => { setTheme(name); document.documentElement.classList.toggle('dark', name !== 'Light'); }}><Icon size={17}/></button>)}</div>;
}

export function NormalFooter() {
  const html = footerMarkup.replaceAll('Local workspace', 'Product status');
  const options: HTMLReactParserOptions = { replace(node) {
    if (node.type !== 'tag') return;
    const attrs = node.attribs || {};
    if (attrs['data-social-links'] !== undefined) return <SocialLinks />;
    if (node.name === 'div' && attrs['aria-label'] === 'Theme switcher') return <ThemeButtons />;
    if (node.name === 'button' && ['Light', 'Dark', 'System'].includes(attrs['aria-label'] || '')) return null;
    if (node.name === 'a' && attrs.href?.startsWith('/')) {
      const props = attributesToProps(attrs);
      props.href = `${LIEGE}${attrs.href}`;
      return <a {...props}>{domToReact(node.children as any, options)}</a>;
    }
    if (node.name === 'a' && attrs.href === '/') {
      const props = attributesToProps(attrs);
      props.href = LIEGE;
      return <a {...props}>{domToReact(node.children as any, options)}</a>;
    }
  }};
  return <><div className="normal-footer-shell liege-site reference-page">{parse(html, options)}</div><TokenAddress /></>;
}
