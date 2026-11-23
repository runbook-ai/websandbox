'use strict';
// Serve a site that believes it runs at the root ("/login", "/static/x.css", Path=/ cookies)
// under a path prefix ("/forum/login"), without changing the site: rewrite what it sends.
//
//   response headers  Location (root-relative or absolute to our host), Set-Cookie Path
//   text/html         href/src/action/formaction/poster/xlink:href/data-* attributes, srcset,
//                     <option value="/...">, url(/...) in inline styles, root-relative string
//                     literals in inline <script> and on* handlers, absolute URLs to our host;
//                     plus a shim (first thing in <head>) for URLs client JS builds at run time
//   text/css          url(/...)
//   site JS (/static/, /_kit/)   root-relative string literals ('/api/x' -> '/forum/api/x'), so
//                     comparisons with location.pathname keep working
//   JSON / other text absolute URLs to our host (map style.json tiles/glyphs/sprite, wiki opensearch)
//   request           prefix stripped from the path and from a same-origin Referer
//
// "Already prefixed" = the path is P or starts with P/ -- except for sites that own paths under
// their own prefix name (the wiki's /wiki/<Article>): their Location headers are always prefixed.

const ATTR = /(\s(?:href|src|action|formaction|poster|background|xlink:href|data-[\w-]+)\s*=\s*)(["'])\/(?![\/\\])/gi;
const SRCSET = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;
const OPTION = /(<option\b[^>]*?\svalue\s*=\s*)(["'])\/(?![\/\\])/gi;
const CSSURL = /(url\(\s*)(["']?)\/(?![\/\\])/gi;
const JSLIT = /(["'`])\/(?=[A-Za-z_])/g;
const SCRIPT = /(<script\b(?![^>]*\ssrc\s*=)[^>]*>)([\s\S]*?)(<\/script>)/gi;
const ONATTR = /(\son[a-z]+\s*=\s*")([^"]*)(")/gi;

function under(p, P) { return p === P || p.startsWith(P + '/'); }
function addPrefix(p, P) { return P + p; }
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function shim(P) {
  // keep tiny; runs before any site script. URLs the site builds at run time (from JSON, from
  // location) get the prefix when they are same-origin and not already under it.
  return `<script>(function(){var P=${JSON.stringify(P)},O=location.origin;
function u(p){return p===P||p.indexOf(P+'/')===0}
function fx(x){if(x==null)return x;var s=String(x);if(/^\\/(?![\\/\\\\])/.test(s))return u(s.split(/[?#]/)[0])?s:P+s;
if(!/^https?:/i.test(s))return x;try{var a=new URL(s);if(a.origin===O&&!u(a.pathname)){a.pathname=P+a.pathname;return a.href}}catch(e){}return x}
var F=window.fetch;if(F)window.fetch=function(i,o){if(typeof i==='string'||i instanceof URL)i=fx(String(i));else if(i&&i.url){var n=fx(i.url);if(n!==i.url)i=new Request(n,i)}return F.call(this,i,o)};
var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,l){arguments[1]=fx(l);return X.apply(this,arguments)};
['pushState','replaceState'].forEach(function(k){var h=history[k];history[k]=function(s,t,l){return l==null?h.call(this,s,t):h.call(this,s,t,fx(l))}});
var W=window.open;window.open=function(l){arguments[0]=fx(l);return W.apply(this,arguments)};
var A=['href','src','action','formaction','poster'];
function fe(e){if(!e.getAttribute)return;for(var i=0;i<A.length;i++){var v=e.getAttribute(A[i]);if(v){var n=fx(v);if(n!==v)e.setAttribute(A[i],n)}}}
function fa(n){if(n.nodeType!==1)return;fe(n);if(n.querySelectorAll){var l=n.querySelectorAll('[href],[src],[action],[formaction],[poster]');for(var i=0;i<l.length;i++)fe(l[i])}}
new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==='attributes')fe(m.target);else m.addedNodes.forEach(fa)})})
.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:A});
document.addEventListener('submit',function(e){fe(e.target)},true);document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a)fe(a)},true);
})();</script>`;
}

// A quoted absolute path starts an expression: not a quote right after / or \ (a regex literal such
// as /"/g, an escaped quote), and not a path piece appended with + ('/x/' + id + '/messages' --
// only the first piece is a URL start; the shim covers anything built at run time).
function rewriteJs(s, P) {
  return s.replace(JSLIT, (m, q, off, str) => {
    const before = str[off - 1];
    if (before === '/' || before === '\\') return m;
    let i = off - 1;
    while (i >= 0 && /\s/.test(str[i])) i--;
    return str[i] === '+' ? m : `${q}${P}/`;
  });
}
function rewriteCss(s, P) { return s.replace(CSSURL, `$1$2${P}/`); }
function rewriteAbs(s, P, host, proto) {
  // absolute URLs to our host -> under the prefix (the sites build http://<Host>/... URLs)
  // (site output is never prefixed itself, so no "already prefixed" check here)
  const re = new RegExp(`https?://${reEsc(host)}(?=/)`, 'gi');
  return s.replace(re, `${proto}://${host}${P}`);
}
function rewriteHtml(s, P, host, proto) {
  s = s.replace(SCRIPT, (m, a, body, c) => a + rewriteJs(body, P) + c);
  s = s.replace(ONATTR, (m, a, body, c) => a + body.replace(/(&#39;|&quot;|['`])\/(?=[A-Za-z_])/g, `$1${P}/`) + c);
  s = s.replace(ATTR, `$1$2${P}/`);
  s = s.replace(OPTION, `$1$2${P}/`);
  s = s.replace(SRCSET, (m, a, q, v) => a + q + v.split(',').map((c) => c.replace(/^(\s*)\/(?![\/\\])/, `$1${P}/`)).join(',') + q);
  s = rewriteCss(s, P);
  s = rewriteAbs(s, P, host, proto);
  // no <link rel=icon>: the browser would ask for /favicon.ico outside the prefix
  const sh = shim(P) + (/<link\b[^>]*rel\s*=\s*["']?(?:shortcut\s+)?icon/i.test(s) ? '' : '<link rel="icon" href="data:,">');
  const m = /<head\b[^>]*>/i.exec(s);
  return m ? s.slice(0, m.index + m[0].length) + sh + s.slice(m.index + m[0].length) : sh + s;
}

function rewriteLocation(loc, site, host, proto) {
  const P = site.prefix;
  if (/^\/(?![\/\\])/.test(loc)) return site.ownsPrefix || !under(loc.split(/[?#]/)[0], P) ? P + loc : loc;
  try {
    const u = new URL(loc);
    if (u.host.toLowerCase() === host.toLowerCase()) {
      if (site.ownsPrefix || !under(u.pathname, P)) u.pathname = P + u.pathname;
      return `${proto}://${host}${u.pathname}${u.search}${u.hash}`;
    }
  } catch {}
  return loc;
}

function rewriteCookie(c, P) {
  let found = false;
  const out = c.split(';').map((part) => {
    const m = /^\s*path\s*=\s*(.*)$/i.exec(part);
    if (!m) return part;
    found = true;
    const p = m[1].trim() || '/';
    return ` Path=${P}${p.startsWith('/') ? p : '/' + p}`;
  }).join(';');
  return found ? out : `${out}; Path=${P}/`;
}

// body rewriting by content type; null = stream unchanged
function bodyKind(contentType, sitePath) {
  const t = String(contentType || '').toLowerCase();
  if (t.startsWith('text/html')) return 'html';
  if (t.startsWith('text/css')) return 'css';
  if (/javascript|ecmascript/.test(t)) return /^\/(static|_kit)\//.test(sitePath) ? 'js' : null;
  if (t.includes('json') || t.startsWith('text/') || t.includes('xml')) return 'abs';
  return null;
}
function rewriteBody(kind, s, P, host, proto) {
  if (kind === 'html') return rewriteHtml(s, P, host, proto);
  if (kind === 'css') return rewriteCss(s, P);
  if (kind === 'js') return rewriteAbs(rewriteJs(s, P), P, host, proto);
  return rewriteAbs(s, P, host, proto);
}

module.exports = { under, rewriteHtml, rewriteCss, rewriteJs, rewriteAbs, rewriteLocation, rewriteCookie, bodyKind, rewriteBody, shim, addPrefix };
