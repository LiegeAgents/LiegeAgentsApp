import { useEffect, useState } from 'react';
import parse, { attributesToProps, domToReact, type HTMLReactParserOptions } from 'html-react-parser';
import footerMarkup from '../../src/liege-app/liege/footer.html?raw';
import { Check, Copy, Moon, Sun, Monitor } from 'lucide-react';
import { LIEGE } from './data';
// The shared landing component is JSX in the main app and has no emitted type declaration.
// @ts-expect-error shared JSX component
import SocialLinks from '../../src/liege-app/SocialLinks';

const tokenAddress = '0xc32ab2e562ade6fba6d3d1e3960d49b0957ef645';

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
