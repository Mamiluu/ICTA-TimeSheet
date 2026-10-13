/* Copyright (c) 2026 Asya Hafidh <msanifuasiya@gmail.com>. All Rights Reserved.
   Proprietary and confidential. See LICENSE in the repository root.

   Scale factor for a page that uses <html class="fixed-layout"> (see
   assets/shell.css). By default it is "auto": 1 at 1280px and wider, smaller
   below that, so a narrow window shows the same layout shrunk. Phones and
   tablets already lay the page out 1280px wide through the viewport meta, so
   auto stays at 1 there. The A- / A+ buttons in the sidebar override it for any
   viewer that cannot be detected as narrow; the choice is remembered. */
(function(){
  var DESIGN_WIDTH = 1280, MIN = 0.2, MAX = 1.6, KEY = 'icta_page_scale', OLD_KEY = 'icta_superadmin_scale';
  var root = document.documentElement, manual = null;
  try{
    var saved = parseFloat(localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY));
    if(saved > 0) manual = saved;
  }catch(e){}
  function auto(){
    var w = root.clientWidth || window.innerWidth;
    return w < DESIGN_WIDTH ? w / DESIGN_WIDTH : 1;
  }
  function current(){ return Math.min(MAX, Math.max(MIN, manual != null ? manual : auto())); }
  function paint(){
    var z = current();
    root.style.setProperty('--fit', z.toFixed(4));
    root.classList.toggle('manual-scale', manual != null);
    var label = document.getElementById('sizeAuto');
    if(label){
      label.textContent = manual != null ? Math.round(z * 100) + '%' : 'Auto';
      label.title = manual != null ? 'Back to automatic sizing' : 'Sized automatically to fit the screen';
    }
  }
  function remember(){
    try{
      if(manual == null){ localStorage.removeItem(KEY); localStorage.removeItem(OLD_KEY); }
      else localStorage.setItem(KEY, String(manual));
    }catch(e){}
  }
  window.pageScale = {
    smaller: function(){ manual = Math.max(MIN, current() * 0.85); remember(); paint(); },
    larger: function(){ manual = Math.min(MAX, current() * 1.15); remember(); paint(); },
    auto: function(){ manual = null; remember(); paint(); },
    refresh: paint
  };
  paint();
  window.addEventListener('resize', paint);
  window.addEventListener('orientationchange', paint);
  document.addEventListener('DOMContentLoaded', function(){
    var down = document.getElementById('sizeDown'), up = document.getElementById('sizeUp'), auto = document.getElementById('sizeAuto');
    if(down) down.addEventListener('click', window.pageScale.smaller);
    if(up) up.addEventListener('click', window.pageScale.larger);
    if(auto) auto.addEventListener('click', window.pageScale.auto);
    paint();
  });
})();
