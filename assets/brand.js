// Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
// Proprietary and confidential. See LICENSE in the repository root.
//
// Gives every page the look of the organisation it belongs to: its accent colour,
// logo and name. The pages themselves are written for the first organisation, so
// this swaps in the right ones rather than each page being edited per customer.
//
// Whose look it is comes from the address (?org=, ?event=, ?code=) or, on the admin
// pages, from the person signed in; the server decides. The last answer is kept on
// this device so the next page opens already in the right colours.
(function(){
  var DEFAULT_NAME = 'ICT Authority';
  var DEFAULT_LOGO = 'icta_logo_cropped';

  var qs = new URLSearchParams(location.search);
  var ctx = [];
  ['org', 'event', 'code'].forEach(function(k){ if(qs.get(k)) ctx.push(k + '=' + encodeURIComponent(qs.get(k))); });
  var cacheKey = 'brand:v1:' + (ctx.join('&') || 'session');
  var brand = null;

  function validHex(c){ return /^#[0-9a-f]{6}$/i.test(c || ''); }

  function setColours(b){
    if(!validHex(b.accent)) return;
    var s = document.documentElement.style;
    s.setProperty('--accent', b.accent);
    s.setProperty('--c-accent', b.accent);
    if(validHex(b.accentDark)) s.setProperty('--c-accent-dark', b.accentDark);
    if(validHex(b.accentWash)) s.setProperty('--c-accent-wash', b.accentWash);
  }

  function isOwnLogo(img){
    var src = img.getAttribute('src') || '';
    return img.id === 'orgLogoImg' || src.indexOf(DEFAULT_LOGO) !== -1;
  }

  // The name the pages were written with is replaced wherever it appears as text.
  function swapName(text){
    return text.split(DEFAULT_NAME).join(brand.orgName);
  }

  function walk(root){
    if(!brand) return;
    var renaming = brand.orgName && brand.orgName !== DEFAULT_NAME;
    if(root.nodeType === 1 && root.tagName === 'IMG'){
      if(brand.logoUrl && isOwnLogo(root) && root.getAttribute('src') !== brand.logoUrl) root.setAttribute('src', brand.logoUrl);
      return;
    }
    if(root.nodeType === 3){
      if(renaming && root.nodeValue.indexOf(DEFAULT_NAME) !== -1) root.nodeValue = swapName(root.nodeValue);
      return;
    }
    if(root.nodeType !== 1 && root.nodeType !== 9) return;
    var imgs = root.querySelectorAll ? root.querySelectorAll('img') : [];
    Array.prototype.forEach.call(imgs, function(img){ walk(img); });
    if(!renaming) return;
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n){
        var p = n.parentNode && n.parentNode.nodeName;
        if(p === 'SCRIPT' || p === 'STYLE' || p === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
        return n.nodeValue.indexOf(DEFAULT_NAME) !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes = [];
    while(tw.nextNode()) nodes.push(tw.currentNode);
    nodes.forEach(function(n){ n.nodeValue = swapName(n.nodeValue); });
  }

  function apply(b){
    if(!b || !b.orgName) return;
    brand = b;
    setColours(b);
    if(b.logoUrl){
      Array.prototype.forEach.call(document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]'), function(l){ l.setAttribute('href', b.logoUrl); });
    }
    // The loading screen starts as plain Daymark and takes the organisation's name and logo
    // as soon as they are known, so nobody sees another organisation's mark while a page opens.
    var pl = document.querySelector('.preloader-logo'), po = document.querySelector('.preloader-org');
    if(pl && b.logoUrl && pl.id !== 'preloaderLogo') pl.setAttribute('src', b.logoUrl);
    if(po) po.textContent = b.orgName;
    if(b.orgName !== DEFAULT_NAME && document.title.indexOf(DEFAULT_NAME) !== -1) document.title = swapName(document.title);
    if(document.body) walk(document.body);
    window.ORG_BRAND = b;
    release();
    document.dispatchEvent(new CustomEvent('brand:ready', { detail: b }));
  }

  // Text and images the page creates later (certificates, printouts) get the same treatment.
  function watch(){
    if(!window.MutationObserver || !document.body) return;
    new MutationObserver(function(muts){
      muts.forEach(function(m){ Array.prototype.forEach.call(m.addedNodes, function(n){ walk(n); }); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  var cached = null;
  try{ cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); }catch(e){}
  if(cached){ brand = cached; setColours(cached); }

  // Until the organisation is known, the loading screen shows only its ring, never a name or a logo
  // that might be somebody else's. It is released when the answer arrives, or after a few seconds.
  var root = document.documentElement;
  function release(){ root.classList.remove('brand-wait'); }
  if(!cached){ root.classList.add('brand-wait'); setTimeout(release, 3500); }

  function start(){
    if(cached) apply(cached);
    watch();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  fetch('/api/branding' + (ctx.length ? '?' + ctx.join('&') : ''), { credentials: 'include' })
    .then(function(r){ return r.json(); })
    .then(function(b){
      if(!b || !b.ok){ release(); return; }
      try{ localStorage.setItem(cacheKey, JSON.stringify(b)); }catch(e){}
      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ apply(b); }); else apply(b);
    })
    .catch(function(){ /* keep the page as written */ release(); });
})();
