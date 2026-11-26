/* Apple Book Delight — lightweight interaction polish.
   The previous full-screen intro overlay was removed: it could cover the whole
   page and intercept clicks when a browser/session timer was interrupted.
   The Duck sticker picker is provided by applebook-chat-polish.js. */
(function(){
  'use strict';
  function install(){
    // Remove any stale intro left by an older cached script.
    document.querySelectorAll('.abx-book-intro').forEach(el=>el.remove());
    if(!document.getElementById('abx-delight-css')){
      const st=document.createElement('style');
      st.id='abx-delight-css';
      st.textContent=`
        .abx-sent-sticker{display:inline-flex;align-items:center;gap:9px;padding:8px 12px;border-radius:15px;background:linear-gradient(135deg,#fff7f8,#f2e1e5);color:#54202d;box-shadow:0 5px 16px #41101d18}
        .abx-sent-sticker span{font-size:32px;line-height:1}.abx-sent-sticker b{font-size:13px}
        button,.b,a[onclick]{transition:transform .13s ease,filter .13s ease,box-shadow .13s ease}
        button:active,.b:active,a[onclick]:active{transform:scale(.98);filter:brightness(.97)}
        button:focus-visible,.b:focus-visible{outline:2px solid var(--bl);outline-offset:2px}
        @media(prefers-reduced-motion:reduce){button,.b{transition:none}}
      `;
      document.head.appendChild(st);
    }
    if(!window.__abxDelightClicks){
      window.__abxDelightClicks=true;
      document.addEventListener('click',e=>{
        const b=e.target.closest('button,.b');
        if(!b||b.disabled)return;
        b.classList.remove('abx-pressed');
        void b.offsetWidth;
        b.classList.add('abx-pressed');
        setTimeout(()=>b.classList.remove('abx-pressed'),160);
      });
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
